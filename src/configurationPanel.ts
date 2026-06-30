import * as vscode from 'vscode';
import {
  DEFAULT_SELECTION_TRANSLATION_PROMPT,
  DEFAULT_AI_TRANSLATION_CONCURRENCY,
  DEFAULT_TRANSLATION_PROMPT,
  getStoredSettingValue,
  normalizeFullTranslationPrompt,
  saveStoredSettings,
  StoredSettingValue,
} from './config';
import { runSelfCheck } from './diagnostics';

type SettingValue = string | boolean | number;

type SettingDefinition = {
  id: string;
  configurationKey: string;
  label: string;
  type: 'text' | 'password' | 'textarea' | 'checkbox' | 'number' | 'select';
  defaultValue: SettingValue;
  options?: string[];
};

type ConfigurationMessage = {
  command?: string;
  values?: { [id: string]: SettingValue };
};

type WebviewView = {
  title?: string;
  webview: vscode.Webview;
};

const SETTINGS: SettingDefinition[] = [
  {
    id: 'aiApiKey',
    configurationKey: 'paper-reader.ai.apiKey',
    label: 'AI API Key',
    type: 'password',
    defaultValue: '',
  },
  {
    id: 'aiBaseUrl',
    configurationKey: 'paper-reader.ai.baseUrl',
    label: 'AI Base URL',
    type: 'text',
    defaultValue: 'https://api.deepseek.com',
  },
  {
    id: 'aiModel',
    configurationKey: 'paper-reader.ai.model',
    label: 'AI Model',
    type: 'text',
    defaultValue: 'deepseek-v4-flash',
  },
  {
    id: 'aiPrompt',
    configurationKey: 'paper-reader.ai.translationPrompt',
    label: 'Full Translation Prompt',
    type: 'textarea',
    defaultValue: DEFAULT_TRANSLATION_PROMPT,
  },
  {
    id: 'aiTranslationConcurrency',
    configurationKey: 'paper-reader.ai.translationConcurrency',
    label: 'Full Translation Concurrency',
    type: 'number',
    defaultValue: DEFAULT_AI_TRANSLATION_CONCURRENCY,
  },
  {
    id: 'selectionApiKey',
    configurationKey: 'paper-reader.selectionTranslation.apiKey',
    label: 'Selection API Key',
    type: 'password',
    defaultValue: '',
  },
  {
    id: 'selectionBaseUrl',
    configurationKey: 'paper-reader.selectionTranslation.baseUrl',
    label: 'Selection Base URL',
    type: 'text',
    defaultValue: '',
  },
  {
    id: 'selectionModel',
    configurationKey: 'paper-reader.selectionTranslation.model',
    label: 'Selection Model',
    type: 'text',
    defaultValue: '',
  },
  {
    id: 'selectionPrompt',
    configurationKey: 'paper-reader.selectionTranslation.prompt',
    label: 'Selection Prompt',
    type: 'textarea',
    defaultValue: DEFAULT_SELECTION_TRANSLATION_PROMPT,
  },
  {
    id: 'outputDirectory',
    configurationKey: 'paper-reader.output.directory',
    label: 'Output Directory',
    type: 'text',
    defaultValue: 'paper-reader-output',
  },
  {
    id: 'mineruExecutable',
    configurationKey: 'paper-reader.mineru.executable',
    label: 'MinerU Executable',
    type: 'text',
    defaultValue: 'mineru',
  },
  {
    id: 'mineruBackend',
    configurationKey: 'paper-reader.mineru.backend',
    label: 'MinerU Backend',
    type: 'select',
    defaultValue: 'hybrid-engine',
    options: [
      'pipeline',
      'vlm-engine',
      'hybrid-engine',
      'vlm-http-client',
      'hybrid-http-client',
    ],
  },
  {
    id: 'mineruEffort',
    configurationKey: 'paper-reader.mineru.effort',
    label: 'MinerU Hybrid Effort',
    type: 'select',
    defaultValue: 'high',
    options: ['medium', 'high'],
  },
  {
    id: 'mineruModelSource',
    configurationKey: 'paper-reader.mineru.modelSource',
    label: 'MinerU Model Source',
    type: 'select',
    defaultValue: 'auto',
    options: ['auto', 'huggingface', 'modelscope', 'local'],
  },
  {
    id: 'mineruProxyUrl',
    configurationKey: 'paper-reader.mineru.proxyUrl',
    label: 'MinerU Download Proxy URL',
    type: 'text',
    defaultValue: 'http://127.0.0.1:7897',
  },
  {
    id: 'mineruMethod',
    configurationKey: 'paper-reader.mineru.method',
    label: 'MinerU Method',
    type: 'select',
    defaultValue: 'auto',
    options: ['auto', 'txt', 'ocr'],
  },
  {
    id: 'mineruApiUrl',
    configurationKey: 'paper-reader.mineru.apiUrl',
    label: 'MinerU API URL',
    type: 'text',
    defaultValue: '',
  },
  {
    id: 'mineruLang',
    configurationKey: 'paper-reader.mineru.lang',
    label: 'MinerU OCR Language',
    type: 'select',
    defaultValue: '',
    options: [
      '',
      'ch',
      'ch_server',
      'korean',
      'ta',
      'te',
      'ka',
      'th',
      'el',
      'arabic',
      'east_slavic',
      'cyrillic',
      'devanagari',
    ],
  },
  {
    id: 'mineruFormula',
    configurationKey: 'paper-reader.mineru.formula',
    label: 'MinerU Formula Parsing',
    type: 'checkbox',
    defaultValue: true,
  },
  {
    id: 'mineruTable',
    configurationKey: 'paper-reader.mineru.table',
    label: 'MinerU Table Parsing',
    type: 'checkbox',
    defaultValue: true,
  },
  {
    id: 'mineruImageAnalysis',
    configurationKey: 'paper-reader.mineru.imageAnalysis',
    label: 'MinerU Image/Chart Analysis',
    type: 'checkbox',
    defaultValue: true,
  },
  {
    id: 'mineruDevice',
    configurationKey: 'paper-reader.mineru.device',
    label: 'MinerU Device',
    type: 'select',
    defaultValue: 'auto',
    options: ['auto', 'cpu', 'cuda'],
  },
  {
    id: 'mineruCudaDevice',
    configurationKey: 'paper-reader.mineru.cudaDevice',
    label: 'MinerU CUDA Device',
    type: 'text',
    defaultValue: '0',
  },
  {
    id: 'mineruRenderThreads',
    configurationKey: 'paper-reader.mineru.renderThreads',
    label: 'MinerU Render Threads',
    type: 'number',
    defaultValue: 1,
  },
  {
    id: 'mineruProcessingWindowSize',
    configurationKey: 'paper-reader.mineru.processingWindowSize',
    label: 'MinerU Processing Window Size',
    type: 'number',
    defaultValue: 2,
  },
  {
    id: 'mineruFallbackToPdfJs',
    configurationKey: 'paper-reader.mineru.fallbackToPdfJs',
    label: 'Fallback to PDF.js',
    type: 'checkbox',
    defaultValue: false,
  },
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getNonce(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 32; index += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

function getSettingValues(): { [id: string]: SettingValue } {
  const values: { [id: string]: SettingValue } = {};
  for (const setting of SETTINGS) {
    const value =
      getStoredSettingValue<SettingValue>(setting.configurationKey) ??
      vscode.workspace
        .getConfiguration()
        .get(setting.configurationKey, setting.defaultValue);
    values[setting.id] =
      setting.id === 'aiPrompt' && typeof value === 'string'
        ? normalizeFullTranslationPrompt(value)
        : value;
  }
  return values;
}

async function saveSettingValues(values: {
  [id: string]: SettingValue;
}): Promise<void> {
  const storedValues: { [key: string]: StoredSettingValue } = {};
  for (const setting of SETTINGS) {
    const nextValue = values[setting.id];
    const valueToSave =
      nextValue === undefined ? setting.defaultValue : nextValue;
    storedValues[setting.configurationKey] = valueToSave;
  }

  saveStoredSettings(storedValues);

  const settingWriteErrors: string[] = [];
  for (const setting of SETTINGS) {
    const valueToSave = storedValues[setting.configurationKey];
    try {
      await vscode.workspace
        .getConfiguration()
        .update(setting.configurationKey, valueToSave, true);
    } catch (error) {
      settingWriteErrors.push(
        `${setting.configurationKey}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    if (vscode.workspace.workspaceFolders?.length) {
      try {
        await vscode.workspace
          .getConfiguration()
          .update(setting.configurationKey, valueToSave, false);
      } catch (error) {
        settingWriteErrors.push(
          `${setting.configurationKey}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    const savedValue = getStoredSettingValue<SettingValue>(
      setting.configurationKey
    );
    if (String(savedValue) !== String(valueToSave)) {
      throw new Error(
        `Setting ${setting.configurationKey} did not persist. Expected "${valueToSave}", got "${savedValue}".`
      );
    }
  }

  if (settingWriteErrors.length) {
    vscode.window.showWarningMessage(
      'Paper Reader settings were saved internally, but VS Code settings sync reported warnings. Paper Reader will still use the saved values.'
    );
  }
}

function renderField(setting: SettingDefinition, value: SettingValue): string {
  const id = escapeHtml(setting.id);
  const label = escapeHtml(setting.label);

  if (setting.type === 'checkbox') {
    return `<label class="check"><input id="${id}" type="checkbox" ${
      value ? 'checked' : ''
    } /> <span>${label}</span></label>`;
  }

  if (setting.type === 'textarea') {
    return `<label><span>${label}</span><textarea id="${id}" rows="5">${escapeHtml(
      String(value)
    )}</textarea></label>`;
  }

  if (setting.type === 'select') {
    const options = (setting.options || [])
      .map(
        (option) =>
          `<option value="${escapeHtml(option)}" ${
            option === value ? 'selected' : ''
          }>${escapeHtml(option)}</option>`
      )
      .join('');
    return `<label><span>${label}</span><select id="${id}">${options}</select></label>`;
  }

  return `<label><span>${label}</span><input id="${id}" type="${
    setting.type
  }" value="${escapeHtml(String(value))}" /></label>`;
}

function getHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  const values = getSettingValues();
  const fields = SETTINGS.map((setting) =>
    renderField(setting, values[setting.id])
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${
    webview.cspSource
  } 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      margin: 0;
      padding: 18px 20px 28px;
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
      margin: 0 0 18px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 14px 18px;
      max-width: 980px;
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    input,
    textarea,
    select {
      box-sizing: border-box;
      width: 100%;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      padding: 7px 8px;
      font: inherit;
    }
    textarea {
      resize: vertical;
      line-height: 1.45;
    }
    .check {
      flex-direction: row;
      align-items: center;
      color: var(--vscode-foreground);
      min-height: 31px;
    }
    .check input {
      width: auto;
    }
    .actions {
      display: flex;
      gap: 10px;
      margin-top: 20px;
      flex-wrap: wrap;
    }
    button {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 0;
      border-radius: 3px;
      padding: 8px 12px;
      cursor: pointer;
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    #status {
      margin-top: 14px;
      min-height: 20px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <h1>Paper Reader Configuration</h1>
  <div class="grid">${fields}</div>
  <div class="actions">
    <button id="save">Save</button>
    <button id="selfCheck" class="secondary">Self Check</button>
    <button id="settings" class="secondary">Open VS Code Settings</button>
  </div>
  <div id="status"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const definitions = ${JSON.stringify(SETTINGS)};
    const status = document.getElementById('status');

    function collectValues() {
      const values = {};
      for (const setting of definitions) {
        const element = document.getElementById(setting.id);
        if (setting.type === 'checkbox') {
          values[setting.id] = element.checked;
        } else if (setting.type === 'number') {
          values[setting.id] = Number(element.value) || Number(setting.defaultValue) || 0;
        } else {
          values[setting.id] = element.value;
        }
      }
      return values;
    }

    function applyValues(values) {
      for (const setting of definitions) {
        const element = document.getElementById(setting.id);
        if (!element || values[setting.id] === undefined) {
          continue;
        }
        if (setting.type === 'checkbox') {
          element.checked = Boolean(values[setting.id]);
        } else {
          element.value = values[setting.id];
        }
      }
    }

    document.getElementById('save').addEventListener('click', () => {
      vscode.postMessage({ command: 'save', values: collectValues() });
      status.textContent = 'Saving...';
    });
    document.getElementById('selfCheck').addEventListener('click', () => {
      vscode.postMessage({ command: 'selfCheck' });
      status.textContent = 'Running self check...';
    });
    document.getElementById('settings').addEventListener('click', () => {
      vscode.postMessage({ command: 'openSettings' });
    });
    window.addEventListener('message', (event) => {
      if (event.data.command === 'saved') {
        applyValues(event.data.values || {});
        vscode.setState({ values: event.data.values || {} });
        status.textContent = 'Saved.';
      } else if (event.data.command === 'saveFailed') {
        status.textContent = 'Save failed: ' + (event.data.error || 'unknown error');
      } else if (event.data.command === 'settings') {
        applyValues(event.data.values || {});
        vscode.setState({ values: event.data.values || {} });
      }
    });
    const previousState = vscode.getState();
    if (previousState && previousState.values) {
      applyValues(previousState.values);
    }
    function requestLatestSettings() {
      vscode.postMessage({ command: 'loadSettings' });
    }
    window.addEventListener('focus', requestLatestSettings);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        requestLatestSettings();
      }
    });
    requestLatestSettings();
  </script>
</body>
</html>`;
}

async function handleConfigurationMessage(
  message: ConfigurationMessage,
  webview: vscode.Webview
): Promise<void> {
  if (message.command === 'save') {
    try {
      await saveSettingValues(message.values || {});
      await webview.postMessage({
        command: 'saved',
        values: getSettingValues(),
      });
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : 'Unable to save settings.';
      await webview.postMessage({
        command: 'saveFailed',
        error: messageText,
      });
      vscode.window.showErrorMessage(
        `Unable to save Paper Reader settings: ${messageText}`
      );
    }
  } else if (message.command === 'selfCheck') {
    await runSelfCheck();
  } else if (message.command === 'openSettings') {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      'paper-reader'
    );
  } else if (message.command === 'loadSettings') {
    await webview.postMessage({
      command: 'settings',
      values: getSettingValues(),
    });
  }
}

export class ConfigurationViewProvider {
  public constructor(private readonly extensionUri: vscode.Uri) {}

  public resolveWebviewView(webviewView: WebviewView): void {
    webviewView.title = 'Configuration';
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: ConfigurationMessage) =>
      handleConfigurationMessage(message, webviewView.webview)
    );
  }
}

export class ConfigurationPanel {
  private static panel: vscode.WebviewPanel | undefined;

  public static show(extensionUri: vscode.Uri): void {
    if (ConfigurationPanel.panel) {
      ConfigurationPanel.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'paperReaderConfiguration',
      'Paper Reader Configuration',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [extensionUri],
      }
    );
    ConfigurationPanel.panel = panel;
    panel.webview.html = getHtml(panel.webview);

    panel.webview.onDidReceiveMessage((message: ConfigurationMessage) =>
      handleConfigurationMessage(message, panel.webview)
    );

    panel.onDidDispose(() => {
      ConfigurationPanel.panel = undefined;
    });
  }
}

class ConfigurationTreeItem extends vscode.TreeItem {
  public constructor() {
    super('Configuration', vscode.TreeItemCollapsibleState.None);
    this.command = {
      command: 'dipe-paper-reader.openConfiguration',
      title: 'Open Paper Reader Configuration',
    };
  }
}

export class ConfigurationTreeProvider
  implements vscode.TreeDataProvider<ConfigurationTreeItem> {
  public getTreeItem(item: ConfigurationTreeItem): vscode.TreeItem {
    return item;
  }

  public getChildren(): ConfigurationTreeItem[] {
    return [new ConfigurationTreeItem()];
  }
}
