import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';

import { runTests } from 'vscode-test';

function isVSCodeExecutable(candidate: string): boolean {
  try {
    const versionOutput = execFileSync(candidate, ['--version'], {
      encoding: 'utf8',
    });
    return /^\d+\.\d+\.\d+/m.test(versionOutput);
  } catch {
    return false;
  }
}

function findInstalledVSCode(): string | undefined {
  if (process.env.VSCODE_TEST_EXECUTABLE) {
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

  return candidates.find(
    (candidate) => fs.existsSync(candidate) && isVSCodeExecutable(candidate)
  );
}

async function main(): Promise<void> {
  try {
    // The folder containing the Extension Manifest package.json
    // Passed to `--extensionDevelopmentPath`
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');

    // The path to the extension test script
    // Passed to --extensionTestsPath
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    const vscodeExecutablePath = findInstalledVSCode();

    // Download VS Code, unzip it and run the integration test
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      vscodeExecutablePath,
      version: '1.84.2',
    });
  } catch (err) {
    console.error('Failed to run tests');
    process.exit(1);
  }
}

main();
