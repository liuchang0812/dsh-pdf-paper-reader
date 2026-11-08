/**
 * Paper store: workspace PDF discovery, parsing cache, notes persistence and
 * text search. One instance is owned by the plugin so every route and agent
 * tool observes the same parsed documents.
 */

import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { parsePdf, toWirePaper } from './pdf.js';

const MAX_PDF_BYTES = 80 * 1024 * 1024;
const MAX_LIBRARY_ENTRIES = 400;
const MAX_SCAN_DEPTH = 4;
const MAX_CACHE_ENTRIES = 6;
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.cache',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
]);

export class PaperError extends Error {
  /**
   * @param {string} message human-readable message
   * @param {number} [status] HTTP status for route responses
   */
  constructor(message, status = 400) {
    super(message);
    this.name = 'PaperError';
    this.status = status;
  }
}

/**
 * @typedef {object} CachedPaper
 * @property {string} key
 * @property {number} mtimeMs
 * @property {number} size
 * @property {import('./pdf.js').ParsedPaper} paper
 * @property {object} wire
 */

export class PaperStore {
  /**
   * @param {{rootDir: string, notesDir: string}} options store options
   */
  constructor({ rootDir, notesDir }) {
    this.rootDir = rootDir;
    this.notesDir = resolve(rootDir, notesDir);
    /** @type {Map<string, CachedPaper>} */
    this.cache = new Map();
    /** @type {Map<string, Promise<CachedPaper>>} */
    this.pending = new Map();
  }

  /**
   * Resolve a user-supplied path to an absolute PDF inside the workspace root.
   * @param {string} requested relative path (or an absolute path inside the root)
   * @returns {string} absolute path
   */
  resolvePath(requested) {
    if (typeof requested !== 'string' || requested.trim().length === 0) {
      throw new PaperError('A paper path is required.');
    }
    const absolute = resolve(this.rootDir, requested);
    if (!isInside(this.rootDir, absolute)) {
      throw new PaperError('That path is outside the paper library root.', 403);
    }
    if (extname(absolute).toLowerCase() !== '.pdf') {
      throw new PaperError('Only PDF files can be opened.', 415);
    }
    return absolute;
  }

  /** @param {string} absolute absolute path @returns {string} root-relative path */
  relativePath(absolute) {
    return relative(this.rootDir, absolute).split(sep).join('/');
  }

  /**
   * Note file name derived from the root-relative path, so same-named PDFs in
   * different folders never share a note file.
   * @param {string} absolute absolute PDF path inside the root
   * @returns {string} slug without extension
   */
  noteSlug(absolute) {
    const relativePath = this.relativePath(absolute).replace(/\.pdf$/i, '');
    return relativePath
      .split('/')
      .map((part) => part.replace(/[\\/:*?"<>|]+/g, '-').trim())
      .filter((part) => part.length > 0 && part !== '..')
      .join('__')
      .replace(/\s+/g, ' ')
      .slice(0, 140) || 'paper';
  }

  /**
   * List PDF files in the workspace, optionally parsing a few uncached papers
   * so their real titles can be shown.
   * @param {{titles?: number}} [options] title enrichment budget
   * @returns {Promise<{entries: object[], root: string, truncated: boolean}>} library
   */
  async library(options = {}) {
    const entries = [];
    let truncated = false;
    const walk = async (directory, depth) => {
      if (depth > MAX_SCAN_DEPTH || truncated) return;
      let dirents;
      try {
        dirents = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const dirent of dirents) {
        if (entries.length >= MAX_LIBRARY_ENTRIES) {
          truncated = true;
          return;
        }
        if (dirent.name.startsWith('.')) continue;
        const absolute = join(directory, dirent.name);
        if (dirent.isDirectory()) {
          if (SKIP_DIRECTORIES.has(dirent.name)) continue;
          await walk(absolute, depth + 1);
          continue;
        }
        if (!dirent.isFile() || extname(dirent.name).toLowerCase() !== '.pdf') continue;
        let info;
        try {
          info = await stat(absolute);
        } catch {
          continue;
        }
        if (info.size === 0 || info.size > MAX_PDF_BYTES) continue;
        const relPath = this.relativePath(absolute);
        const cached = this.cachedEntry(absolute, info.mtimeMs, info.size);
        entries.push({
          path: relPath,
          name: basename(absolute, extname(absolute)),
          size: info.size,
          mtimeMs: info.mtimeMs,
          title: cached?.paper.title ?? null,
          pageCount: cached?.paper.pageCount ?? null,
          sections: cached?.paper.sections.length ?? null,
        });
      }
    };
    await walk(this.rootDir, 0);
    entries.sort((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name));
    const wanted = Math.min(12, Math.max(0, Math.round(Number(options.titles) || 0)));
    if (wanted > 0) {
      const pending = entries.filter((entry) => entry.title === null).slice(0, wanted);
      let cursor = 0;
      const workers = Array.from({ length: Math.min(2, pending.length) }, async () => {
        while (cursor < pending.length) {
          const entry = pending[cursor];
          cursor += 1;
          try {
            const opened = await this.open(entry.path);
            entry.title = opened.paper.title;
            entry.pageCount = opened.paper.pageCount;
            entry.sections = opened.paper.sections.length;
            entry.abstract = capText(opened.paper.abstract, 220);
          } catch {
            /* keep the file name; one unreadable PDF must not fail the list */
          }
        }
      });
      await Promise.all(workers);
      entries.sort((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name));
    }
    return { entries, root: this.rootDir, truncated };
  }

  /**
   * Read raw PDF bytes after validating the path.
   * @param {string} requested requested path
   * @returns {Promise<{bytes: Uint8Array, absolute: string}>} bytes and path
   */
  async readBytes(requested) {
    const absolute = this.resolvePath(requested);
    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw new PaperError(`Paper not found: ${requested}`, 404);
    }
    if (info.size > MAX_PDF_BYTES) throw new PaperError('That PDF is too large to open.', 413);
    await this.assertRealPathInside(absolute);
    const bytes = await readFile(absolute);
    return { bytes: new Uint8Array(bytes), absolute };
  }

  /**
   * Parse (or reuse) one paper.
   * @param {string} requested requested path
   * @param {{force?: boolean}} [options] parse options
   * @returns {Promise<CachedPaper & {absolute: string}>} cached paper
   */
  async open(requested, options = {}) {
    const absolute = this.resolvePath(requested);
    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw new PaperError(`Paper not found: ${requested}`, 404);
    }
    if (info.size > MAX_PDF_BYTES) throw new PaperError('That PDF is too large to open.', 413);

    await this.assertRealPathInside(absolute);
    const existing = this.cachedEntry(absolute, info.mtimeMs, info.size);
    if (existing !== undefined && options.force !== true) {
      this.touch(absolute);
      return { ...existing, absolute };
    }
    const inFlight = this.pending.get(absolute);
    if (inFlight !== undefined && options.force !== true) return { ...(await inFlight), absolute };

    const loading = (async () => {
      const bytes = await readFile(absolute);
      let paper;
      try {
        paper = await parsePdf(new Uint8Array(bytes));
      } catch (error) {
        throw new PaperError(friendlyParseError(error), 422);
      }
      if (paper.pageCount > 400) {
        throw new PaperError(`This PDF has ${paper.pageCount} pages, which is beyond the reader limit.`, 422);
      }
      const entry = {
        key: absolute,
        mtimeMs: info.mtimeMs,
        size: info.size,
        paper,
        wire: toWirePaper(paper),
      };
      this.cache.delete(absolute);
      this.cache.set(absolute, entry);
      while (this.cache.size > MAX_CACHE_ENTRIES) {
        const oldest = this.cache.keys().next();
        if (oldest.done) break;
        this.cache.delete(oldest.value);
      }
      return entry;
    })();
    this.pending.set(absolute, loading);
    try {
      return { ...(await loading), absolute };
    } finally {
      this.pending.delete(absolute);
    }
  }

  /**
   * Reject a path whose symlink target escapes the library root.
   * @param {string} absolute resolved path
   * @returns {Promise<void>} resolves when safe
   */
  async assertRealPathInside(absolute) {
    try {
      const [realRoot, realTarget] = await Promise.all([realpath(this.rootDir), realpath(absolute)]);
      if (!isInside(realRoot, realTarget)) {
        throw new PaperError('That path is outside the paper library root.', 403);
      }
    } catch (error) {
      if (error instanceof PaperError) throw error;
      // Missing paths are reported by the caller's stat/read step.
    }
  }

  cachedEntry(absolute, mtimeMs, size) {
    const entry = this.cache.get(absolute);
    if (entry === undefined) return undefined;
    if (entry.mtimeMs !== mtimeMs || entry.size !== size) {
      this.cache.delete(absolute);
      return undefined;
    }
    return entry;
  }

  touch(absolute) {
    const entry = this.cache.get(absolute);
    if (entry === undefined) return;
    this.cache.delete(absolute);
    this.cache.set(absolute, entry);
  }

  /**
   * Search one paper's text.
   * @param {string} requested requested path
   * @param {string} query search phrase
   * @param {{maxResults?: number}} [options] limits
   * @returns {Promise<{matches: {page: number, before: string, match: string, after: string}[], total: number}>} results
   */
  async search(requested, query, options = {}) {
    const { paper } = await this.open(requested);
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return { matches: [], total: 0 };
    const maxResults = clamp(options.maxResults ?? 12, 1, 40);
    const matches = [];
    let total = 0;
    for (const page of paper.pages) {
      const text = page.text;
      const lower = text.toLowerCase();
      let cursor = 0;
      while (true) {
        const index = lower.indexOf(needle, cursor);
        if (index < 0) break;
        total += 1;
        if (matches.length < maxResults) {
          matches.push({
            page: page.index,
            before: text.slice(Math.max(0, index - 160), index).replace(/\s+/g, ' ').trim(),
            match: text.slice(index, index + needle.length),
            after: text.slice(index + needle.length, index + needle.length + 160).replace(/\s+/g, ' ').trim(),
          });
        }
        cursor = index + needle.length;
      }
    }
    return { matches, total };
  }

  /**
   * Persist markdown notes for a paper.
   * @param {string} requested requested path
   * @param {string} markdown note body
   * @returns {Promise<{path: string, absolute: string}>} written note
   */
  async saveNotes(requested, markdown) {
    if (typeof markdown !== 'string') throw new PaperError('Note content must be a string.');
    if (markdown.length > 400_000) throw new PaperError('That note is too large to save.', 413);
    const absolute = this.resolvePath(requested);
    await mkdir(this.notesDir, { recursive: true });
    const target = join(this.notesDir, `${this.noteSlug(absolute)}.md`);
    await writeFile(target, markdown, 'utf8');
    return { path: this.relativePath(target), absolute: target };
  }

  /**
   * Read saved notes for a paper.
   * @param {string} requested requested path
   * @returns {Promise<{markdown: string | null, path: string}>} saved note
   */
  async loadNotes(requested) {
    const absolute = this.resolvePath(requested);
    const target = join(this.notesDir, `${this.noteSlug(absolute)}.md`);
    try {
      const markdown = await readFile(target, 'utf8');
      return { markdown, path: this.relativePath(target) };
    } catch {
      return { markdown: null, path: this.relativePath(target) };
    }
  }
}

function isInside(root, target) {
  const relativePath = relative(root, target);
  return relativePath.length > 0 && !relativePath.startsWith('..') && !relativePath.includes(`..${sep}`);
}

/**
 * Turn a pdf.js failure into a message a reader can act on.
 * @param {unknown} error parse failure
 * @returns {string} friendly message
 */
function friendlyParseError(error) {
  const name = error !== null && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'PasswordException' || /password/i.test(message)) {
    return 'This PDF is password-protected and cannot be read.';
  }
  if (name === 'InvalidPDFException' || /invalid pdf|missing pdf|no pdf header/i.test(message)) {
    return 'This file is not a readable PDF.';
  }
  return `Could not extract text from this PDF: ${message}`;
}

function capText(text, limit) {
  if (typeof text !== 'string') return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}…`;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
