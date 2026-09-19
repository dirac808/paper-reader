import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { getAiConfig, getSelectionAiConfig } from './config';
import { testAiConnection } from './deepSeekClient';
import { getMinerUConfig, getMinerUEnvironment } from './paperTranslation';
import { checkRemoteMinerU } from './minerURemoteClient';

type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
  solution?: string;
};

const CODEX_EXTENSION_ID = 'openai.chatgpt';
const CODEX_REQUIRED_COMMANDS = [
  'chatgpt.addFileToThread',
  'chatgpt.openSidebar',
];

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runProcess(
  command: string,
  args: string[],
  env?: { [key: string]: string | undefined }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Process timed out after 15 seconds.'));
    }, 15000);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(new Error(output || `Process exited with code ${code}.`));
    });
  });
}

async function checkAi(): Promise<CheckResult> {
  try {
    const paperConfig = getAiConfig();
    const selectionConfig = getSelectionAiConfig();
    await testAiConnection(paperConfig);
    if (
      paperConfig.apiKey !== selectionConfig.apiKey ||
      paperConfig.baseUrl !== selectionConfig.baseUrl ||
      paperConfig.model !== selectionConfig.model
    ) {
      await testAiConnection(selectionConfig);
    }
    return {
      name: 'AI API',
      ok: true,
      detail: 'OpenAI-compatible chat completion request succeeded.',
    };
  } catch (error) {
    return {
      name: 'AI API',
      ok: false,
      detail: formatError(error),
      solution:
        'Check Paper Reader AI settings: baseUrl must point to an OpenAI-compatible endpoint, apiKey must be valid, and model must exist for that provider.',
    };
  }
}

async function checkMinerU(): Promise<CheckResult> {
  const config = getMinerUConfig();
  try {
    if (config.apiUrl.trim()) {
      const health = await checkRemoteMinerU(config.apiUrl);
      return {
        name: 'MinerU',
        ok: true,
        detail: `Remote MinerU ${health.version} is healthy (protocol ${health.protocolVersion}, processing ${health.processingTasks}, queued ${health.queuedTasks}).`,
      };
    }
    let output = '';
    try {
      output = await runProcess(
        config.executable,
        ['--version'],
        getMinerUEnvironment(config)
      );
    } catch {
      output = await runProcess(
        config.executable,
        ['--help'],
        getMinerUEnvironment(config)
      );
    }
    return {
      name: 'MinerU',
      ok: true,
      detail:
        output.split(/\r?\n/).find(Boolean) ||
        `MinerU executable is runnable: ${config.executable}`,
    };
  } catch (error) {
    return {
      name: 'MinerU',
      ok: false,
      detail: formatError(error),
      solution: config.apiUrl.trim()
        ? 'Check the MinerU API URL, Tailscale connectivity, and the MinerU service on the remote GPU host.'
        : 'Check Paper Reader MinerU executable. Set it to mineru or the full path of a local MinerU CLI.',
    };
  }
}

async function checkCodex(): Promise<CheckResult> {
  try {
    const extension = vscode.extensions.getExtension(CODEX_EXTENSION_ID);
    if (!extension) {
      throw new Error('The openai.chatgpt extension is not installed.');
    }
    if (!extension.isActive) {
      await extension.activate();
    }

    const commands = await vscode.commands.getCommands(true);
    const missing = CODEX_REQUIRED_COMMANDS.filter(
      (command) => !commands.includes(command)
    );
    if (missing.length) {
      throw new Error(`Missing Codex command(s): ${missing.join(', ')}`);
    }

    return {
      name: 'Codex',
      ok: true,
      detail:
        'openai.chatgpt is installed and required commands are available.',
    };
  } catch (error) {
    return {
      name: 'Codex',
      ok: false,
      detail: formatError(error),
      solution:
        'Install and enable the official OpenAI/Codex VS Code extension, then reload the Extension Development Host.',
    };
  }
}

function writeResult(output: vscode.OutputChannel, result: CheckResult): void {
  output.appendLine(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}`);
  output.appendLine(`  ${result.detail}`);
  if (!result.ok && result.solution) {
    output.appendLine(`  Solution: ${result.solution}`);
  }
  output.appendLine('');
}

export async function runSelfCheck(): Promise<void> {
  const output = vscode.window.createOutputChannel('Paper Reader');
  output.clear();
  output.appendLine('Paper Reader self check');
  output.appendLine(new Date().toISOString());
  output.appendLine('');
  output.show(true);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Paper Reader self check',
      cancellable: false,
    },
    async (progress) => {
      const checks = [
        { label: 'Checking AI API...', run: checkAi },
        { label: 'Checking MinerU...', run: checkMinerU },
        { label: 'Checking Codex...', run: checkCodex },
      ];
      const results: CheckResult[] = [];

      for (const check of checks) {
        progress.report({ message: check.label });
        const result = await check.run();
        results.push(result);
        writeResult(output, result);
      }

      const failed = results.filter((result) => !result.ok);
      if (failed.length) {
        vscode.window.showWarningMessage(
          `Paper Reader self check found ${failed.length} issue(s). See Output > Paper Reader.`
        );
        return;
      }

      vscode.window.showInformationMessage('Paper Reader self check passed.');
    }
  );
}
