import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { URL } from 'url';
import * as vscode from 'vscode';

const EXPECTED_PROTOCOL_VERSION = 2;
const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const HEALTH_TIMEOUT_MS = 15 * 1000;
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const STATUS_TIMEOUT_MS = 2 * 60 * 1000;
const RESULT_TIMEOUT_MS = 10 * 60 * 1000;
const TASK_TIMEOUT_MS = 60 * 60 * 1000;
const POLL_INTERVAL_MS = 1000;

type JsonObject = { [key: string]: unknown };

export type RemoteMinerUHealth = {
  version: string;
  protocolVersion: number;
  queuedTasks: number;
  processingTasks: number;
};

export type RemoteMinerUOptions = {
  apiUrl: string;
  backend: string;
  effort: string;
  method: string;
  lang: string;
  formula: boolean;
  table: boolean;
  imageAnalysis: boolean;
};

type HttpResponse = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

type TaskSubmission = {
  taskId: string;
  statusUrl: URL;
  resultUrl: URL;
};

type YauzlEntry = {
  fileName: string;
};

type YauzlZipFile = {
  readEntry(): void;
  openReadStream(
    entry: YauzlEntry,
    callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void
  ): void;
  close(): void;
  on(event: 'entry', listener: (entry: YauzlEntry) => void): void;
  on(event: 'end' | 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
};

type YauzlModule = {
  open(
    filePath: string,
    options: { lazyEntries: boolean },
    callback: (error: Error | null, zipFile?: YauzlZipFile) => void
  ): void;
};

const yauzl = require('yauzl') as YauzlModule;

function cancellationError(): Error {
  return new Error('Paper Reader operation was cancelled.');
}

function normalizeApiUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('MinerU API URL is empty.');
  }
  const url = new URL(trimmed.endsWith('/') ? trimmed : `${trimmed}/`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('MinerU API URL must use http:// or https://.');
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url;
}

function endpoint(baseUrl: URL, relativePath: string): URL {
  return new URL(relativePath.replace(/^\//, ''), baseUrl);
}

function resolveServerUrl(baseUrl: URL, value: unknown, label: string): URL {
  if (typeof value !== 'string' || !value) {
    throw new Error(`MinerU API response is missing ${label}.`);
  }
  const resolved = new URL(value, baseUrl);
  if (resolved.origin !== baseUrl.origin) {
    throw new Error(`MinerU API returned a cross-origin ${label}.`);
  }
  return resolved;
}

function requestModule(url: URL): typeof http | typeof https {
  return url.protocol === 'https:' ? https : http;
}

function parseJson(response: HttpResponse, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body.toString('utf8'));
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} returned an invalid response object.`);
  }
  return parsed as JsonObject;
}

function responseDetail(response: HttpResponse): string {
  const text = response.body.toString('utf8').trim();
  if (!text) {
    return `HTTP ${response.statusCode}`;
  }
  try {
    const parsed = JSON.parse(text) as JsonObject;
    const detail = parsed.detail || parsed.error || parsed.message;
    return `HTTP ${response.statusCode}: ${
      typeof detail === 'string' ? detail : text
    }`;
  } catch {
    return `HTTP ${response.statusCode}: ${text}`;
  }
}

function requestBuffer(
  url: URL,
  method: string,
  timeoutMs: number,
  cancellation?: vscode.CancellationToken
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    if (cancellation?.isCancellationRequested) {
      reject(cancellationError());
      return;
    }

    let settled = false;
    const cancellationState: { subscription?: vscode.Disposable } = {};
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cancellationState.subscription?.dispose();
      action();
    };
    const request = requestModule(url).request(
      url,
      { method, headers: { Accept: 'application/json' } },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_JSON_RESPONSE_BYTES) {
            request.destroy(
              new Error('MinerU API JSON response exceeded the size limit.')
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          finish(() =>
            resolve({
              statusCode: response.statusCode || 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
            })
          )
        );
      }
    );
    request.setTimeout(timeoutMs, () =>
      request.destroy(new Error(`MinerU API request timed out: ${url}`))
    );
    request.on('error', (error) => finish(() => reject(error)));
    cancellationState.subscription = cancellation?.onCancellationRequested(() =>
      request.destroy(cancellationError())
    );
    request.end();
  });
}

function encodeMultipartField(
  boundary: string,
  name: string,
  value: string
): Buffer {
  return Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`,
    'utf8'
  );
}

function safeUploadName(filePath: string): string {
  return path.basename(filePath).replace(/["\r\n]/g, '_');
}

async function submitTask(
  baseUrl: URL,
  pdfPath: string,
  options: RemoteMinerUOptions,
  cancellation?: vscode.CancellationToken
): Promise<TaskSubmission> {
  if (cancellation?.isCancellationRequested) {
    throw cancellationError();
  }
  const stat = await fs.promises.stat(pdfPath);
  const boundary = `paper-reader-${Date.now().toString(
    16
  )}-${Math.random().toString(16).slice(2)}`;
  const fields: Array<[string, string]> = [
    ['lang_list', options.lang || 'ch'],
    ['backend', options.backend],
    ['effort', options.effort],
    ['parse_method', options.method],
    ['formula_enable', String(options.formula)],
    ['table_enable', String(options.table)],
    ['image_analysis', String(options.imageAnalysis)],
    ['return_md', 'true'],
    ['return_middle_json', 'false'],
    ['return_model_output', 'false'],
    ['return_content_list', 'false'],
    ['return_images', 'true'],
    ['response_format_zip', 'true'],
    ['return_original_file', 'false'],
    ['client_side_output_generation', 'false'],
    ['start_page_id', '0'],
    ['end_page_id', '99999'],
  ];
  const fieldBuffers = fields.map(([name, value]) =>
    encodeMultipartField(boundary, name, value)
  );
  const fileHeader = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="${safeUploadName(
        pdfPath
      )}"\r\n` +
      'Content-Type: application/pdf\r\n\r\n',
    'utf8'
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const contentLength =
    fieldBuffers.reduce((total, buffer) => total + buffer.length, 0) +
    fileHeader.length +
    stat.size +
    suffix.length;
  const taskUrl = endpoint(baseUrl, 'tasks');

  return new Promise((resolve, reject) => {
    let settled = false;
    const cancellationState: { subscription?: vscode.Disposable } = {};
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cancellationState.subscription?.dispose();
      action();
    };
    const request = requestModule(taskUrl).request(
      taskUrl,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(contentLength),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_JSON_RESPONSE_BYTES) {
            request.destroy(
              new Error('MinerU task response exceeded the size limit.')
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const result: HttpResponse = {
            statusCode: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          };
          if (result.statusCode !== 202) {
            finish(() => reject(new Error(responseDetail(result))));
            return;
          }
          try {
            const payload = parseJson(result, 'MinerU task submission');
            const taskId = payload.task_id;
            if (typeof taskId !== 'string' || !taskId) {
              throw new Error('MinerU API response is missing task_id.');
            }
            finish(() =>
              resolve({
                taskId,
                statusUrl: resolveServerUrl(
                  baseUrl,
                  payload.status_url,
                  'status_url'
                ),
                resultUrl: resolveServerUrl(
                  baseUrl,
                  payload.result_url,
                  'result_url'
                ),
              })
            );
          } catch (error) {
            finish(() => reject(error));
          }
        });
      }
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () =>
      request.destroy(new Error('Timed out uploading PDF to MinerU API.'))
    );
    request.on('error', (error) => finish(() => reject(error)));
    cancellationState.subscription = cancellation?.onCancellationRequested(() =>
      request.destroy(cancellationError())
    );
    for (const fieldBuffer of fieldBuffers) request.write(fieldBuffer);
    request.write(fileHeader);
    const input = fs.createReadStream(pdfPath);
    input.on('error', (error) => request.destroy(error));
    input.on('end', () => request.end(suffix));
    input.pipe(request, { end: false });
  });
}

function delay(
  ms: number,
  cancellation?: vscode.CancellationToken
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (cancellation?.isCancellationRequested) {
      reject(cancellationError());
      return;
    }
    const cancellationState: { subscription?: vscode.Disposable } = {};
    const timer = setTimeout(() => {
      cancellationState.subscription?.dispose();
      resolve();
    }, ms);
    cancellationState.subscription = cancellation?.onCancellationRequested(
      () => {
        clearTimeout(timer);
        cancellationState.subscription?.dispose();
        reject(cancellationError());
      }
    );
  });
}

async function waitForTask(
  submission: TaskSubmission,
  onProgress?: (message: string) => void,
  cancellation?: vscode.CancellationToken
): Promise<void> {
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  let lastMessage = '';
  while (Date.now() < deadline) {
    const response = await requestBuffer(
      submission.statusUrl,
      'GET',
      STATUS_TIMEOUT_MS,
      cancellation
    );
    if (response.statusCode !== 200) {
      throw new Error(
        `Unable to query MinerU task ${submission.taskId}: ${responseDetail(
          response
        )}`
      );
    }
    const payload = parseJson(response, 'MinerU task status');
    const status = payload.status;
    if (status === 'completed') return;
    if (status === 'failed') {
      throw new Error(
        `MinerU task failed: ${String(
          payload.error || payload.message || 'unknown server error'
        )}`
      );
    }
    if (status !== 'pending' && status !== 'processing') {
      throw new Error(
        `MinerU returned an unknown task status: ${String(status)}`
      );
    }
    const queuedAhead = payload.queued_ahead;
    const message =
      status === 'pending'
        ? `MinerU 远程任务排队中${
            typeof queuedAhead === 'number' && queuedAhead > 0
              ? `（前方 ${queuedAhead} 个任务）`
              : ''
          }`
        : 'MinerU 正在主力机 GPU 上解析文档';
    if (message !== lastMessage) {
      lastMessage = message;
      onProgress?.(message);
    }
    await delay(POLL_INTERVAL_MS, cancellation);
  }
  throw new Error(
    'Timed out waiting for the remote MinerU task after 60 minutes.'
  );
}

function downloadResult(
  url: URL,
  targetPath: string,
  cancellation?: vscode.CancellationToken
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (cancellation?.isCancellationRequested) {
      reject(cancellationError());
      return;
    }
    let settled = false;
    let output: fs.WriteStream | undefined;
    const cancellationState: { subscription?: vscode.Disposable } = {};
    const finish = (action: () => void, removePartial = false): void => {
      if (settled) return;
      settled = true;
      cancellationState.subscription?.dispose();
      if (removePartial) {
        output?.destroy();
        fs.promises.unlink(targetPath).catch(() => undefined);
      }
      action();
    };
    const request = requestModule(url).get(
      url,
      { headers: { Accept: 'application/zip' } },
      (response) => {
        if (response.statusCode !== 200) {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () =>
            finish(() =>
              reject(
                new Error(
                  responseDetail({
                    statusCode: response.statusCode || 0,
                    headers: response.headers,
                    body: Buffer.concat(chunks),
                  })
                )
              )
            )
          );
          return;
        }
        output = fs.createWriteStream(targetPath, { flags: 'wx' });
        const failDownload = (error: Error): void =>
          finish(() => reject(error), true);
        response.on('aborted', () =>
          failDownload(new Error('MinerU result download was interrupted.'))
        );
        response.on('error', failDownload);
        output.on('error', failDownload);
        output.on('finish', () => finish(resolve));
        response.pipe(output);
      }
    );
    request.setTimeout(RESULT_TIMEOUT_MS, () =>
      request.destroy(new Error('Timed out downloading MinerU result.'))
    );
    request.on('error', (error) => finish(() => reject(error), true));
    cancellationState.subscription = cancellation?.onCancellationRequested(() =>
      request.destroy(cancellationError())
    );
  });
}

function safeArchiveTarget(root: string, entryName: string): string {
  const normalized = entryName.replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`Unsafe path in MinerU result archive: ${entryName}`);
  }
  const target = path.resolve(root, normalized);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe path in MinerU result archive: ${entryName}`);
  }
  return target;
}

function extractZip(zipPath: string, outputDirectory: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError || new Error('Unable to open MinerU result archive.'));
        return;
      }
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        zipFile.close();
        action();
      };
      zipFile.on('error', (error) => finish(() => reject(error)));
      zipFile.on('end', () => finish(resolve));
      zipFile.on('entry', (entry) => {
        let target: string;
        try {
          target = safeArchiveTarget(outputDirectory, entry.fileName);
        } catch (error) {
          finish(() => reject(error));
          return;
        }
        if (entry.fileName.endsWith('/')) {
          fs.promises
            .mkdir(target, { recursive: true })
            .then(() => zipFile.readEntry())
            .catch((error) => finish(() => reject(error)));
          return;
        }
        fs.promises
          .mkdir(path.dirname(target), { recursive: true })
          .then(() =>
            zipFile.openReadStream(entry, (streamError, stream) => {
              if (streamError || !stream) {
                finish(() =>
                  reject(
                    streamError || new Error('Unable to read MinerU ZIP entry.')
                  )
                );
                return;
              }
              const output = fs.createWriteStream(target, { flags: 'wx' });
              stream.on('error', (error) => output.destroy(error));
              output.on('error', (error) => finish(() => reject(error)));
              output.on('finish', () => zipFile.readEntry());
              stream.pipe(output);
            })
          )
          .catch((error) => finish(() => reject(error)));
      });
      zipFile.readEntry();
    });
  });
}

export async function checkRemoteMinerU(
  rawApiUrl: string
): Promise<RemoteMinerUHealth> {
  const baseUrl = normalizeApiUrl(rawApiUrl);
  const response = await requestBuffer(
    endpoint(baseUrl, 'health'),
    'GET',
    HEALTH_TIMEOUT_MS
  );
  if (response.statusCode !== 200) {
    throw new Error(`MinerU health check failed: ${responseDetail(response)}`);
  }
  const payload = parseJson(response, 'MinerU health check');
  if (payload.status !== 'healthy') {
    throw new Error(
      `MinerU API is not healthy: ${String(payload.error || '')}`
    );
  }
  if (payload.protocol_version !== EXPECTED_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported MinerU API protocol ${String(
        payload.protocol_version
      )}; expected ${EXPECTED_PROTOCOL_VERSION}.`
    );
  }
  return {
    version: String(payload.version || 'unknown'),
    protocolVersion: Number(payload.protocol_version),
    queuedTasks: Number(payload.queued_tasks || 0),
    processingTasks: Number(payload.processing_tasks || 0),
  };
}

export async function runRemoteMinerU(
  pdfPath: string,
  outputDirectory: string,
  options: RemoteMinerUOptions,
  onProgress?: (message: string) => void,
  cancellation?: vscode.CancellationToken
): Promise<void> {
  const baseUrl = normalizeApiUrl(options.apiUrl);
  const health = await checkRemoteMinerU(options.apiUrl);
  onProgress?.(`已连接主力机 MinerU ${health.version}`);
  const submission = await submitTask(baseUrl, pdfPath, options, cancellation);
  await waitForTask(submission, onProgress, cancellation);

  const tempRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'paper-reader-mineru-result-')
  );
  const zipPath = path.join(tempRoot, 'result.zip');
  try {
    onProgress?.('正在下载 MinerU 解析结果');
    await downloadResult(submission.resultUrl, zipPath, cancellation);
    await extractZip(zipPath, outputDirectory);
  } finally {
    const promisesWithRm = fs.promises as typeof fs.promises & {
      rm?: (
        target: fs.PathLike,
        options: { recursive: boolean; force: boolean }
      ) => Promise<void>;
    };
    if (promisesWithRm.rm) {
      await promisesWithRm.rm(tempRoot, { recursive: true, force: true });
    } else {
      await fs.promises.rmdir(tempRoot, { recursive: true });
    }
  }
}

export const testingHooks = {
  normalizeApiUrl,
  safeArchiveTarget,
};
