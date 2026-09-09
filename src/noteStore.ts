import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import initSqlJs = require('sql.js');
import { getConfiguredOutputRoot } from './config';

export type NoteRecord = {
  id: number;
  title: string;
  content: string;
  updatedAt: string;
};

export type GraphNode = {
  id: string;
  label: string;
  type: 'note' | 'tag';
};

export type GraphLink = {
  source: string;
  target: string;
  type: 'wikilink' | 'tag';
};

export type KnowledgeGraph = {
  nodes: GraphNode[];
  links: GraphLink[];
};

export type PdfAnnotationRecord = {
  id: number;
  documentHash: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  selectedText: string;
  content: string;
  updatedAt: string;
  exportedPath?: string;
};

export type MarkdownAnnotationRecord = {
  id: number;
  documentUri: string;
  documentHash: string;
  selectedText: string;
  prefixText: string;
  suffixText: string;
  textOffset: number;
  content: string;
  updatedAt: string;
  exportedPath?: string;
};

export type AnnotationChange = {
  kind: 'pdf' | 'markdown';
  documentHash: string;
};

type SqlStatement = {
  bind(values?: unknown[]): boolean;
  step(): boolean;
  getAsObject(): { [key: string]: unknown };
  free(): void;
};

type SqlDatabase = {
  run(sql: string, params?: unknown[]): SqlDatabase;
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  prepare(sql: string): SqlStatement;
  export(): Uint8Array;
  close(): void;
};

type SqlJsModule = {
  Database: new (data?: Uint8Array) => SqlDatabase;
};

const DEFAULT_NOTE_TITLE = 'Untitled Note';
const WIKILINK_PATTERN = /\[\[([^\]\n]+)\]\]/g;
const TAG_PATTERN = /(^|[\s([{])#([A-Za-z0-9_\-\u4e00-\u9fa5]+)/g;
function unique(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean))
  );
}

function extractWikiLinks(content: string): string[] {
  const links: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_PATTERN.exec(content))) {
    links.push(match[1]);
  }
  return unique(links);
}

function extractTags(content: string): string[] {
  const tags: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = TAG_PATTERN.exec(content))) {
    tags.push(match[2]);
  }
  return unique(tags);
}

function inferTitle(content: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading) {
    return heading[1].trim();
  }

  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine
    ? firstLine.replace(/^#+\s*/, '').slice(0, 80)
    : DEFAULT_NOTE_TITLE;
}

function sanitizeFileName(name: string): string {
  const sanitized = name
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized || DEFAULT_NOTE_TITLE;
}

function rows<T>(db: SqlDatabase, sql: string, params: unknown[] = []): T[] {
  const statement = db.prepare(sql);
  const result: T[] = [];
  try {
    statement.bind(params);
    while (statement.step()) {
      result.push((statement.getAsObject() as unknown) as T);
    }
  } finally {
    statement.free();
  }
  return result;
}

function row<T>(
  db: SqlDatabase,
  sql: string,
  params: unknown[] = []
): T | undefined {
  return rows<T>(db, sql, params)[0];
}

function hasColumn(db: SqlDatabase, table: string, column: string): boolean {
  const tableInfo = rows<{ name: string }>(db, `PRAGMA table_info(${table})`);
  return tableInfo.some((item) => item.name === column);
}

export class NoteStore implements vscode.Disposable {
  public static async create(
    context: vscode.ExtensionContext
  ): Promise<NoteStore> {
    const storageRoot = context.globalStoragePath;
    fs.mkdirSync(storageRoot, { recursive: true });

    const wasmPath = path.join(
      context.extensionPath,
      'node_modules',
      'sql.js',
      'dist',
      'sql-wasm.wasm'
    );
    const SQL = (await initSqlJs({
      locateFile: () => wasmPath,
    })) as SqlJsModule;
    const workspaceRoot =
      vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : storageRoot;
    return new NoteStore(
      path.join(storageRoot, 'dipe-notes.sqlite3'),
      path.join(getConfiguredOutputRoot(workspaceRoot), 'notes'),
      SQL
    );
  }

  private readonly db: SqlDatabase;
  private readonly annotationListeners = new Set<
    (change: AnnotationChange) => void
  >();
  private annotationWatcher: vscode.FileSystemWatcher | undefined;
  private persistTimer: NodeJS.Timer | undefined;
  private persistDirty = false;

  private constructor(
    private readonly filePath: string,
    private readonly notesDirectory: string,
    SQL: SqlJsModule
  ) {
    this.db = fs.existsSync(filePath)
      ? new SQL.Database(new Uint8Array(fs.readFileSync(filePath)))
      : new SQL.Database();
    this.initialize();
    this.watchAnnotationFiles();
  }

  public dispose(): void {
    this.annotationWatcher?.dispose();
    this.annotationListeners.clear();
    this.flushPersist();
    this.db.close();
  }

  public onDidChangeAnnotations(
    listener: (change: AnnotationChange) => void
  ): vscode.Disposable {
    this.annotationListeners.add(listener);
    return {
      dispose: (): void => {
        this.annotationListeners.delete(listener);
      },
    };
  }

  private emitAnnotationChange(change: AnnotationChange): void {
    for (const listener of this.annotationListeners) {
      listener(change);
    }
  }

  private watchAnnotationFiles(): void {
    const workspaceWithWatcher = vscode.workspace as typeof vscode.workspace & {
      createFileSystemWatcher?: typeof vscode.workspace.createFileSystemWatcher;
    };
    if (!workspaceWithWatcher.createFileSystemWatcher) {
      return;
    }

    const outputRoot = path.dirname(this.notesDirectory);
    fs.mkdirSync(path.join(outputRoot, 'pdf-annotations'), { recursive: true });
    fs.mkdirSync(path.join(outputRoot, 'markdown-annotations'), {
      recursive: true,
    });
    this.annotationWatcher = workspaceWithWatcher.createFileSystemWatcher(
      new vscode.RelativePattern(
        outputRoot,
        '{pdf-annotations,markdown-annotations}/*.md'
      )
    );
    this.annotationWatcher.onDidDelete((uri) => {
      this.removeAnnotationForDeletedFile(uri.fsPath);
    });
  }

  private removeAnnotationForDeletedFile(filePath: string): void {
    const pdfAnnotation = row<{ id: number; documentHash: string }>(
      this.db,
      'SELECT id, document_hash as documentHash FROM pdf_annotations WHERE exported_path = ?',
      [filePath]
    );
    const markdownAnnotation = row<{ id: number; documentHash: string }>(
      this.db,
      'SELECT id, document_hash as documentHash FROM markdown_annotations WHERE exported_path = ?',
      [filePath]
    );
    if (!pdfAnnotation && !markdownAnnotation) {
      return;
    }

    if (pdfAnnotation) {
      this.db.run('DELETE FROM pdf_annotations WHERE id = ?', [
        pdfAnnotation.id,
      ]);
    }
    if (markdownAnnotation) {
      this.db.run('DELETE FROM markdown_annotations WHERE id = ?', [
        markdownAnnotation.id,
      ]);
    }
    this.persist();
    if (pdfAnnotation) {
      this.emitAnnotationChange({
        kind: 'pdf',
        documentHash: pdfAnnotation.documentHash,
      });
    }
    if (markdownAnnotation) {
      this.emitAnnotationChange({
        kind: 'markdown',
        documentHash: markdownAnnotation.documentHash,
      });
    }
  }

  private initialize(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS note_links (
        note_id INTEGER NOT NULL,
        target_title TEXT NOT NULL,
        UNIQUE(note_id, target_title)
      );

      CREATE TABLE IF NOT EXISTS note_tags (
        note_id INTEGER NOT NULL,
        tag TEXT NOT NULL,
        UNIQUE(note_id, tag)
      );

      CREATE TABLE IF NOT EXISTS pdf_annotations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_hash TEXT NOT NULL,
        page INTEGER NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        width REAL NOT NULL DEFAULT 0,
        height REAL NOT NULL DEFAULT 0,
        selected_text TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        exported_path TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_pdf_annotations_document
        ON pdf_annotations(document_hash, page);

      CREATE TABLE IF NOT EXISTS markdown_annotations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_uri TEXT NOT NULL,
        document_hash TEXT NOT NULL,
        selected_text TEXT NOT NULL DEFAULT '',
        prefix_text TEXT NOT NULL DEFAULT '',
        suffix_text TEXT NOT NULL DEFAULT '',
        text_offset INTEGER NOT NULL DEFAULT -1,
        content TEXT NOT NULL,
        exported_path TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_markdown_annotations_document
        ON markdown_annotations(document_hash);
    `);
    this.migrate();
    this.persist();
  }

  private migrate(): void {
    if (!hasColumn(this.db, 'pdf_annotations', 'width')) {
      this.db.run(
        'ALTER TABLE pdf_annotations ADD COLUMN width REAL NOT NULL DEFAULT 0'
      );
    }
    if (!hasColumn(this.db, 'pdf_annotations', 'height')) {
      this.db.run(
        'ALTER TABLE pdf_annotations ADD COLUMN height REAL NOT NULL DEFAULT 0'
      );
    }
    if (!hasColumn(this.db, 'pdf_annotations', 'exported_path')) {
      this.db.run(
        "ALTER TABLE pdf_annotations ADD COLUMN exported_path TEXT NOT NULL DEFAULT ''"
      );
    }
    if (!hasColumn(this.db, 'markdown_annotations', 'document_uri')) {
      this.db.run(
        "ALTER TABLE markdown_annotations ADD COLUMN document_uri TEXT NOT NULL DEFAULT ''"
      );
    }
    if (!hasColumn(this.db, 'markdown_annotations', 'exported_path')) {
      this.db.run(
        "ALTER TABLE markdown_annotations ADD COLUMN exported_path TEXT NOT NULL DEFAULT ''"
      );
    }
    if (!hasColumn(this.db, 'markdown_annotations', 'text_offset')) {
      this.db.run(
        'ALTER TABLE markdown_annotations ADD COLUMN text_offset INTEGER NOT NULL DEFAULT -1'
      );
    }
  }

  private persist(): void {
    this.persistDirty = true;
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => this.flushPersist(), 200);
  }

  private flushPersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (!this.persistDirty) {
      return;
    }
    this.persistDirty = false;
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, Buffer.from(this.db.export()));
    fs.renameSync(tempPath, this.filePath);
  }

  private exportNoteFile(note: NoteRecord): void {
    fs.mkdirSync(this.notesDirectory, { recursive: true });
    const filename = `${sanitizeFileName(note.title)}.md`;
    fs.writeFileSync(
      path.join(this.notesDirectory, filename),
      note.content,
      'utf8'
    );
  }

  private exportPdfAnnotationFile(
    annotation: PdfAnnotationRecord,
    documentTitle: string
  ): string {
    const directory = path.join(
      path.dirname(this.notesDirectory),
      'pdf-annotations'
    );
    fs.mkdirSync(directory, { recursive: true });

    const filename = `${sanitizeFileName(documentTitle)}-p${
      annotation.page
    }-note-${annotation.id}.md`;
    const selectedText = annotation.selectedText.trim()
      ? `\n\n## Source Selection\n\n> ${annotation.selectedText
          .trim()
          .replace(/\r?\n/g, '\n> ')}\n`
      : '';
    const content = [
      `# ${sanitizeFileName(documentTitle)} · Page ${annotation.page}`,
      '',
      annotation.content,
      selectedText,
    ].join('\n');

    const filePath = path.join(directory, filename);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  private exportMarkdownAnnotationFile(
    annotation: MarkdownAnnotationRecord,
    documentTitle: string
  ): string {
    const directory = path.join(
      path.dirname(this.notesDirectory),
      'markdown-annotations'
    );
    fs.mkdirSync(directory, { recursive: true });

    const filename = `${sanitizeFileName(documentTitle)}-note-${
      annotation.id
    }.md`;
    const selectedText = annotation.selectedText.trim()
      ? `\n\n## Source Selection\n\n> ${annotation.selectedText
          .trim()
          .replace(/\r?\n/g, '\n> ')}\n`
      : '';
    const content = [
      `# ${sanitizeFileName(documentTitle)} · Markdown Note ${annotation.id}`,
      '',
      annotation.content,
      selectedText,
    ].join('\n');

    const filePath = path.join(directory, filename);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  public getOrCreateDefaultNote(): NoteRecord {
    const note = row<NoteRecord>(
      this.db,
      'SELECT id, title, content, updated_at as updatedAt FROM notes ORDER BY updated_at DESC LIMIT 1'
    );
    if (note) {
      return note;
    }

    const content =
      '# Reading Notes\n\nStart writing with [[links]] and #tags.\n';
    return this.saveNote(undefined, content);
  }

  public getNote(id: number): NoteRecord | undefined {
    return row<NoteRecord>(
      this.db,
      'SELECT id, title, content, updated_at as updatedAt FROM notes WHERE id = ?',
      [id]
    );
  }

  public saveNote(id: number | undefined, content: string): NoteRecord {
    const title = inferTitle(content);
    const now = new Date().toISOString();
    let noteId = id;

    if (noteId && this.getNote(noteId)) {
      this.db.run(
        'UPDATE notes SET title = ?, content = ?, updated_at = ? WHERE id = ?',
        [title, content, now, noteId]
      );
    } else {
      this.db.run(
        'INSERT INTO notes (title, content, created_at, updated_at) VALUES (?, ?, ?, ?)',
        [title, content, now, now]
      );
      const created = row<{ id: number }>(
        this.db,
        'SELECT last_insert_rowid() as id'
      );
      noteId = created ? created.id : undefined;
    }

    if (!noteId) {
      throw new Error('Unable to save note.');
    }

    this.reindexNote(noteId, content);
    this.persist();
    const savedNote = this.getNote(noteId) as NoteRecord;
    this.exportNoteFile(savedNote);
    return savedNote;
  }

  public appendToDefaultNote(markdown: string): NoteRecord {
    const note = this.getOrCreateDefaultNote();
    const nextContent = `${note.content.replace(
      /\s+$/g,
      ''
    )}\n\n${markdown.trim()}\n`;
    return this.saveNote(note.id, nextContent);
  }

  private reindexNote(noteId: number, content: string): void {
    this.db.run('DELETE FROM note_links WHERE note_id = ?', [noteId]);
    this.db.run('DELETE FROM note_tags WHERE note_id = ?', [noteId]);

    for (const link of extractWikiLinks(content)) {
      this.db.run(
        'INSERT OR IGNORE INTO note_links (note_id, target_title) VALUES (?, ?)',
        [noteId, link]
      );
    }

    for (const tag of extractTags(content)) {
      this.db.run(
        'INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)',
        [noteId, tag]
      );
    }
  }

  public getGraph(): KnowledgeGraph {
    const notes = rows<{ id: number; title: string }>(
      this.db,
      'SELECT id, title FROM notes ORDER BY updated_at DESC'
    );
    const links = rows<{ source: string; target: string }>(
      this.db,
      'SELECT notes.title as source, note_links.target_title as target FROM note_links JOIN notes ON notes.id = note_links.note_id'
    );
    const tags = rows<{ source: string; tag: string }>(
      this.db,
      'SELECT notes.title as source, note_tags.tag as tag FROM note_tags JOIN notes ON notes.id = note_tags.note_id'
    );

    const nodeMap = new Map<string, GraphNode>();
    const addNode = (node: GraphNode): void => {
      if (!nodeMap.has(node.id)) {
        nodeMap.set(node.id, node);
      }
    };

    for (const note of notes) {
      addNode({ id: `note:${note.title}`, label: note.title, type: 'note' });
    }
    for (const link of links) {
      addNode({ id: `note:${link.source}`, label: link.source, type: 'note' });
      addNode({ id: `note:${link.target}`, label: link.target, type: 'note' });
    }
    for (const tag of tags) {
      addNode({ id: `note:${tag.source}`, label: tag.source, type: 'note' });
      addNode({ id: `tag:${tag.tag}`, label: `#${tag.tag}`, type: 'tag' });
    }

    return {
      nodes: Array.from(nodeMap.values()),
      links: [
        ...links.map((link) => ({
          source: `note:${link.source}`,
          target: `note:${link.target}`,
          type: 'wikilink' as const,
        })),
        ...tags.map((tag) => ({
          source: `note:${tag.source}`,
          target: `tag:${tag.tag}`,
          type: 'tag' as const,
        })),
      ],
    };
  }

  private selectPdfAnnotations(documentHash: string): PdfAnnotationRecord[] {
    return rows<PdfAnnotationRecord>(
      this.db,
      `SELECT
        id,
        document_hash as documentHash,
        page,
        x,
        y,
        width,
        height,
        selected_text as selectedText,
        content,
        updated_at as updatedAt,
        exported_path as exportedPath
      FROM pdf_annotations
      WHERE document_hash = ?
      ORDER BY page ASC, y ASC, x ASC`,
      [documentHash]
    );
  }

  private syncPdfAnnotationFiles(
    documentHash: string,
    documentTitle?: string
  ): void {
    const annotations = this.selectPdfAnnotations(documentHash);
    let changed = false;

    for (const annotation of annotations) {
      if (annotation.exportedPath) {
        if (!fs.existsSync(annotation.exportedPath)) {
          this.db.run('DELETE FROM pdf_annotations WHERE id = ?', [
            annotation.id,
          ]);
          changed = true;
        }
        continue;
      }

      if (documentTitle) {
        const exportedPath = this.exportPdfAnnotationFile(
          annotation,
          documentTitle
        );
        this.db.run(
          'UPDATE pdf_annotations SET exported_path = ? WHERE id = ?',
          [exportedPath, annotation.id]
        );
        changed = true;
      }
    }

    if (changed) {
      this.persist();
    }
  }

  public getPdfAnnotations(
    documentHash: string,
    documentTitle?: string
  ): PdfAnnotationRecord[] {
    this.syncPdfAnnotationFiles(documentHash, documentTitle);
    return this.selectPdfAnnotations(documentHash);
  }

  public getPdfAnnotation(
    documentHash: string,
    id: number,
    documentTitle?: string
  ): PdfAnnotationRecord | undefined {
    this.syncPdfAnnotationFiles(documentHash, documentTitle);
    return row<PdfAnnotationRecord>(
      this.db,
      `SELECT
        id,
        document_hash as documentHash,
        page,
        x,
        y,
        width,
        height,
        selected_text as selectedText,
        content,
        updated_at as updatedAt,
        exported_path as exportedPath
      FROM pdf_annotations
      WHERE document_hash = ? AND id = ?`,
      [documentHash, id]
    );
  }

  public savePdfAnnotation(input: {
    documentHash: string;
    documentTitle?: string;
    page: number;
    x: number;
    y: number;
    width?: number;
    height?: number;
    selectedText?: string;
    content: string;
    id?: number;
  }): PdfAnnotationRecord {
    const now = new Date().toISOString();
    const content = input.content.trim();
    if (!content) {
      throw new Error('Annotation content cannot be empty.');
    }

    if (input.id) {
      this.db.run(
        `UPDATE pdf_annotations
        SET page = ?, x = ?, y = ?, width = ?, height = ?, selected_text = ?, content = ?, updated_at = ?
        WHERE id = ? AND document_hash = ?`,
        [
          input.page,
          input.x,
          input.y,
          input.width || 0,
          input.height || 0,
          input.selectedText || '',
          content,
          now,
          input.id,
          input.documentHash,
        ]
      );
    } else {
      this.db.run(
        `INSERT INTO pdf_annotations
        (document_hash, page, x, y, width, height, selected_text, content, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.documentHash,
          input.page,
          input.x,
          input.y,
          input.width || 0,
          input.height || 0,
          input.selectedText || '',
          content,
          now,
          now,
        ]
      );
      const created = row<{ id: number }>(
        this.db,
        'SELECT last_insert_rowid() as id'
      );
      input.id = created ? created.id : undefined;
    }

    if (!input.id) {
      throw new Error('Unable to save PDF annotation.');
    }

    const annotation = row<PdfAnnotationRecord>(
      this.db,
      `SELECT
        id,
        document_hash as documentHash,
        page,
        x,
        y,
        width,
        height,
        selected_text as selectedText,
        content,
        updated_at as updatedAt,
        exported_path as exportedPath
      FROM pdf_annotations
      WHERE id = ?`,
      [input.id]
    );

    if (!annotation) {
      throw new Error('Unable to load saved PDF annotation.');
    }
    const exportedPath = this.exportPdfAnnotationFile(
      annotation,
      input.documentTitle || input.documentHash
    );
    this.db.run('UPDATE pdf_annotations SET exported_path = ? WHERE id = ?', [
      exportedPath,
      annotation.id,
    ]);
    this.persist();
    return { ...annotation, exportedPath };
  }

  public deletePdfAnnotation(documentHash: string, id: number): void {
    const annotation = row<{ exportedPath: string }>(
      this.db,
      'SELECT exported_path as exportedPath FROM pdf_annotations WHERE document_hash = ? AND id = ?',
      [documentHash, id]
    );
    if (annotation?.exportedPath && fs.existsSync(annotation.exportedPath)) {
      fs.unlinkSync(annotation.exportedPath);
    }
    this.db.run(
      'DELETE FROM pdf_annotations WHERE document_hash = ? AND id = ?',
      [documentHash, id]
    );
    this.persist();
  }

  private selectMarkdownAnnotations(
    documentHash: string
  ): MarkdownAnnotationRecord[] {
    return rows<MarkdownAnnotationRecord>(
      this.db,
      `SELECT
        id,
        document_uri as documentUri,
        document_hash as documentHash,
        selected_text as selectedText,
        prefix_text as prefixText,
        suffix_text as suffixText,
        text_offset as textOffset,
        content,
        updated_at as updatedAt,
        exported_path as exportedPath
      FROM markdown_annotations
      WHERE document_hash = ?
      ORDER BY updated_at DESC`,
      [documentHash]
    );
  }

  private syncMarkdownAnnotationFiles(
    documentHash: string,
    documentTitle?: string
  ): void {
    const annotations = this.selectMarkdownAnnotations(documentHash);
    let changed = false;

    for (const annotation of annotations) {
      if (annotation.exportedPath) {
        if (!fs.existsSync(annotation.exportedPath)) {
          this.db.run('DELETE FROM markdown_annotations WHERE id = ?', [
            annotation.id,
          ]);
          changed = true;
        }
        continue;
      }

      if (documentTitle) {
        const exportedPath = this.exportMarkdownAnnotationFile(
          annotation,
          documentTitle
        );
        this.db.run(
          'UPDATE markdown_annotations SET exported_path = ? WHERE id = ?',
          [exportedPath, annotation.id]
        );
        changed = true;
      }
    }

    if (changed) {
      this.persist();
    }
  }

  public getMarkdownAnnotations(
    documentHash: string,
    documentTitle?: string
  ): MarkdownAnnotationRecord[] {
    this.syncMarkdownAnnotationFiles(documentHash, documentTitle);
    return this.selectMarkdownAnnotations(documentHash);
  }

  public getMarkdownAnnotation(
    documentHash: string,
    id: number,
    documentTitle?: string
  ): MarkdownAnnotationRecord | undefined {
    this.syncMarkdownAnnotationFiles(documentHash, documentTitle);
    return row<MarkdownAnnotationRecord>(
      this.db,
      `SELECT
        id,
        document_uri as documentUri,
        document_hash as documentHash,
        selected_text as selectedText,
        prefix_text as prefixText,
        suffix_text as suffixText,
        text_offset as textOffset,
        content,
        updated_at as updatedAt,
        exported_path as exportedPath
      FROM markdown_annotations
      WHERE document_hash = ? AND id = ?`,
      [documentHash, id]
    );
  }

  public saveMarkdownAnnotation(input: {
    documentUri: string;
    documentHash: string;
    documentTitle?: string;
    selectedText?: string;
    prefixText?: string;
    suffixText?: string;
    textOffset?: number;
    content: string;
    id?: number;
  }): MarkdownAnnotationRecord {
    const now = new Date().toISOString();
    const selectedText = (input.selectedText || '').trim();
    const content = input.content.trim();
    if (!selectedText) {
      throw new Error('Markdown annotation selection cannot be empty.');
    }
    if (!content) {
      throw new Error('Markdown annotation content cannot be empty.');
    }

    if (input.id) {
      this.db.run(
        `UPDATE markdown_annotations
        SET document_uri = ?, selected_text = ?, prefix_text = ?, suffix_text = ?, text_offset = ?, content = ?, updated_at = ?
        WHERE id = ? AND document_hash = ?`,
        [
          input.documentUri,
          selectedText,
          input.prefixText || '',
          input.suffixText || '',
          Number.isFinite(input.textOffset) ? input.textOffset : -1,
          content,
          now,
          input.id,
          input.documentHash,
        ]
      );
    } else {
      this.db.run(
        `INSERT INTO markdown_annotations
        (document_uri, document_hash, selected_text, prefix_text, suffix_text, text_offset, content, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.documentUri,
          input.documentHash,
          selectedText,
          input.prefixText || '',
          input.suffixText || '',
          Number.isFinite(input.textOffset) ? input.textOffset : -1,
          content,
          now,
          now,
        ]
      );
      const created = row<{ id: number }>(
        this.db,
        'SELECT last_insert_rowid() as id'
      );
      input.id = created ? created.id : undefined;
    }

    if (!input.id) {
      throw new Error('Unable to save Markdown annotation.');
    }

    const annotation = this.getMarkdownAnnotation(input.documentHash, input.id);
    if (!annotation) {
      throw new Error('Unable to load saved Markdown annotation.');
    }
    const exportedPath = this.exportMarkdownAnnotationFile(
      annotation,
      input.documentTitle ||
        path.basename(input.documentUri) ||
        input.documentHash
    );
    this.db.run(
      'UPDATE markdown_annotations SET exported_path = ? WHERE id = ?',
      [exportedPath, annotation.id]
    );
    this.persist();
    return { ...annotation, exportedPath };
  }

  public deleteMarkdownAnnotation(documentHash: string, id: number): void {
    const annotation = row<{ exportedPath: string }>(
      this.db,
      'SELECT exported_path as exportedPath FROM markdown_annotations WHERE document_hash = ? AND id = ?',
      [documentHash, id]
    );
    if (annotation?.exportedPath && fs.existsSync(annotation.exportedPath)) {
      fs.unlinkSync(annotation.exportedPath);
    }
    this.db.run(
      'DELETE FROM markdown_annotations WHERE document_hash = ? AND id = ?',
      [documentHash, id]
    );
    this.persist();
  }
}
