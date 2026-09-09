import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';

import { runTests } from '@vscode/test-electron';

async function removeDirectory(directory: string): Promise<void> {
  const promisesWithRm = fs.promises as typeof fs.promises & {
    rm?: (
      target: fs.PathLike,
      options: { recursive: boolean; force: boolean }
    ) => Promise<void>;
  };
  if (promisesWithRm.rm) {
    await promisesWithRm.rm(directory, { recursive: true, force: true });
  } else {
    await fs.promises.rmdir(directory, { recursive: true });
  }
}

function findInstalledVSCode(): string | undefined {
  if (
    process.env.VSCODE_TEST_EXECUTABLE &&
    fs.existsSync(process.env.VSCODE_TEST_EXECUTABLE)
  ) {
    return process.env.VSCODE_TEST_EXECUTABLE;
  }

  const candidates: string[] = [];
  try {
    const whereOutput = execFileSync('where.exe', ['code'], {
      encoding: 'utf8',
    });
    for (const line of whereOutput.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      candidates.push(path.resolve(trimmed, '..', '..', 'Code.exe'));
      if (trimmed.toLowerCase().endsWith('.exe')) {
        candidates.push(trimmed);
      }
    }
  } catch {
    // Fall through to known install locations.
  }

  if (process.env.LOCALAPPDATA) {
    candidates.push(
      path.join(
        process.env.LOCALAPPDATA,
        'Programs',
        'Microsoft VS Code',
        'Code.exe'
      )
    );
  }
  candidates.push(
    path.join('C:', 'Program Files', 'Microsoft VS Code', 'Code.exe')
  );

  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function main(): Promise<void> {
  const testProfileRoot = path.join(
    os.tmpdir(),
    `paper-reader-vscode-test-${process.pid}`
  );
  try {
    // Code.exe inherits these when npm is launched from VS Code's extension
    // host. Electron would otherwise start in plain Node mode.
    delete process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.VSCODE_ESM_ENTRYPOINT;
    delete process.env.VSCODE_IPC_HOOK;
    delete process.env.VSCODE_PID;

    // The folder containing the Extension Manifest package.json
    // Passed to `--extensionDevelopmentPath`
    const extensionDevelopmentPath = process.env
      .PAPER_READER_TEST_EXTENSION_PATH
      ? path.resolve(process.env.PAPER_READER_TEST_EXTENSION_PATH)
      : path.resolve(__dirname, '../../..');

    // The path to the extension test script
    // Passed to --extensionTestsPath
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    const vscodeExecutablePath = findInstalledVSCode();
    if (!vscodeExecutablePath) {
      throw new Error(
        'Unable to find Code.exe. Set VSCODE_TEST_EXECUTABLE to its absolute path.'
      );
    }

    // Download VS Code, unzip it and run the integration test
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      vscodeExecutablePath,
      launchArgs: [
        extensionDevelopmentPath,
        `--user-data-dir=${path.join(testProfileRoot, 'user-data')}`,
        `--extensions-dir=${path.join(testProfileRoot, 'extensions')}`,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
      extensionTestsEnv: {
        PAPER_READER_TEST_PDF:
          process.env.PAPER_READER_TEST_PDF ||
          path.resolve(extensionDevelopmentPath, '..', 'test.pdf'),
      },
    });
  } catch (err) {
    console.error('Failed to run tests', err);
    process.exitCode = 1;
  } finally {
    try {
      await removeDirectory(testProfileRoot);
    } catch {
      // The isolated profile may already have been removed.
    }
  }
}

main();
