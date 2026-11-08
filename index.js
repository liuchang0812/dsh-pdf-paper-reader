/**
 * PDF paper reader — Host half.
 *
 * Owns the workspace paper library, the PDF text model, the authenticated
 * browser Fetch routes used by the reader UI, and the agent tools that let the
 * chat model read and search papers and save reading notes.
 *
 * All network and model work happens here; the browser half only renders.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaperStore, PaperError } from './lib/store.js';
import { buildDigest, askPrompt, briefPrompt, explainPrompt, notesPrompt, outputLanguage, pageBriefPrompt, surroundingContext, termsPrompt, translatePrompt } from './lib/prompts.js';
import { completeText, modelLabel, streamCompletion } from './lib/llm.js';

const MAX_SELECTION_CHARS = 8000;
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;
const UPLOAD_DIR = 'papers';
const EXPLAIN_CACHE_LIMIT = 60;
const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), 'vendor');
const VENDOR_FILES = new Map([
  ['pdf', { file: 'pdf.min.js', type: 'text/javascript; charset=utf-8' }],
  ['worker', { file: 'pdf.worker.min.js', type: 'text/javascript; charset=utf-8' }],
]);

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 * @param {Record<string, unknown>} [config] row config
 */
export function apply(ctx, config = {}) {
  const rootDir = resolveRoot(ctx, config);
  const notesDir = typeof config?.notesDir === 'string' && config.notesDir.trim().length > 0 ? config.notesDir.trim() : 'paper-notes';
  const store = new PaperStore({ rootDir, notesDir });
  /** @type {Map<string, {text: string, model: string}>} */
  const explainCache = new Map();
  const runtime = createRuntime(ctx, { configuredRoot: configuredRoot(config), notesDir, store, rootDir, explainCache });

  ctx.inject(['connection'], (scope) => {
    const services = { get: (name) => scope.get(name), scope };
    for (const route of ROUTES) {
      scope.effect(
        () =>
          scope.connection.fetch.register({
            path: route.path,
            methods: route.methods,
            requestBody: route.requestBody ?? 'buffered',
            fetch: (request) =>
              route.handle(runtime, services, request).catch((error) => failure(error)),
          }),
        `pdf-paper-reader: ${route.path}`,
      );
    }
  });

  ctx.inject(['tools'], (scope) => {
    const services = { get: (name) => scope.get(name), scope };
    for (const definition of createTools(runtime, services)) {
      scope.effect(() => scope.tools.register(definition), `pdf-paper-reader: tool ${definition.name}`);
    }
  });
}

/**
 * @typedef {object} PluginRuntime
 * @property {any} ctx
 * @property {string | undefined} configuredRoot
 * @property {string} notesDir
 * @property {Map<string, PaperStore>} stores
 * @property {Map<string, {text: string, model: string}>} explainCache
 * @property {string} rootDir
 * @property {PaperStore} store
 * @property {(services: any, agent?: any) => PaperStore} storeFor
 */

/**
 * Build the shared runtime, including a store per effective workspace root so
 * the reader follows the session's working directory instead of one global
 * folder.
 * @param {any} ctx plugin context
 * @param {{configuredRoot?: string, notesDir: string, store: PaperStore, rootDir: string, explainCache: Map<string, {text: string, model: string}>}} input runtime inputs
 * @returns {PluginRuntime} runtime
 */
function createRuntime(ctx, input) {
  const stores = new Map();
  stores.set(input.rootDir, input.store);
  const runtime = {
    ctx,
    configuredRoot: input.configuredRoot,
    notesDir: input.notesDir,
    explainCache: input.explainCache,
    rootDir: input.rootDir,
    store: input.store,
    stores,
    storeFor(services, agent) {
      const root = effectiveRoot(ctx, services, input.configuredRoot, agent);
      let store = stores.get(root);
      if (store === undefined) {
        store = new PaperStore({ rootDir: root, notesDir: input.notesDir });
        stores.set(root, store);
        runtime.rootDir = root;
        runtime.store = store;
        while (stores.size > 4) {
          const oldest = stores.keys().next();
          if (oldest.done) break;
          if (oldest.value === root) break;
          stores.delete(oldest.value);
        }
      }
      return store;
    },
  };
  return runtime;
}

function configuredRoot(config) {
  return typeof config?.rootDir === 'string' && config.rootDir.trim().length > 0 ? resolve(config.rootDir.trim()) : undefined;
}

/**
 * Pick the workspace a request should read from: the calling agent's session
 * directory when known, otherwise the most recently created live session, and
 * finally the deployment default.
 * @param {any} ctx plugin context
 * @param {any} services injected scope
 * @param {string | undefined} pinned configured root
 * @param {any} [agent] calling agent for tool executions
 * @returns {string} absolute root directory
 */
function effectiveRoot(ctx, services, pinned, agent) {
  if (pinned !== undefined) return pinned;
  const workingDirectory = services?.get?.('workingDirectory') ?? ctx.get('workingDirectory');
  if (agent !== undefined && typeof workingDirectory?.get === 'function') {
    try {
      const cwd = workingDirectory.get(agent.session);
      if (typeof cwd === 'string' && cwd.length > 0) return cwd;
    } catch {
      /* fall through to the registry */
    }
  }
  const agents = services?.get?.('agents') ?? ctx.get('agents');
  let best = null;
  if (typeof agents?.list === 'function') {
    try {
      for (const candidate of agents.list()) {
        const cwd = candidate?.session?.header?.cwd;
        if (typeof cwd !== 'string' || cwd.length === 0) continue;
        const createdAt = Number(candidate.session.header.createdAt) || 0;
        if (best === null || createdAt >= best.createdAt) best = { createdAt, cwd };
      }
    } catch {
      /* fall through */
    }
  }
  if (best !== null) return best.cwd;
  if (typeof workingDirectory?.defaultDirectory === 'string' && workingDirectory.defaultDirectory.length > 0) {
    return workingDirectory.defaultDirectory;
  }
  return process.cwd();
}

/**
 * Resolve the workspace root the library is scanned from.
 * @param {any} ctx plugin context
 * @param {Record<string, unknown>} config row config
 * @returns {string} absolute root directory
 */
function resolveRoot(ctx, config) {
  const configured = typeof config?.rootDir === 'string' ? config.rootDir.trim() : '';
  if (configured.length > 0) return resolve(configured);
  const deploymentDefault = ctx.get('workingDirectory')?.defaultDirectory;
  if (typeof deploymentDefault === 'string' && deploymentDefault.length > 0) return deploymentDefault;
  return process.cwd();
}

// #region HTTP helpers

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}

function failure(error) {
  const status = error instanceof PaperError ? error.status : 500;
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: message }, status);
}

/**
 * Read a JSON body with a bounded size.
 * @param {Request} request incoming request
 * @returns {Promise<Record<string, any>>} parsed body
 */
async function readJsonBody(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 1_500_000) {
    throw new PaperError('The request body is too large.', 413);
  }
  let text;
  try {
    text = await request.text();
  } catch {
    throw new PaperError('The request body could not be read.', 400);
  }
  if (text.length > 1_500_000) throw new PaperError('The request body is too large.', 413);
  if (text.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new PaperError('The request body must be a JSON object.', 400);
  }
}

/**
 * Stream newline-delimited JSON frames as plain text chunks, surfacing model
 * failures as a final `error` frame instead of a broken body.
 * @param {AsyncGenerator<Record<string, unknown>>} frames frames to encode
 * @returns {Response} streaming response
 */
function ndjson(frames) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      try {
        for await (const frame of frames) {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        controller.enqueue(encoder.encode(`${JSON.stringify({ error: message })}\n`));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
}

/** Emit one streamed completion as NDJSON delta frames plus a truncation flag. */
async function* relayCompletion(services, prompt, signal) {
  let truncated = false;
  const stream = streamCompletion(services, {
    ...prompt,
    signal,
    onTruncated: () => {
      truncated = true;
    },
  });
  for await (const delta of stream) yield { delta };
  if (truncated) yield { truncated: true };
}

// #endregion

// #region Routes

const ROUTES = [
  { path: '/api/pdf.reader.library', methods: ['GET'], handle: handleLibrary },
  { path: '/api/pdf.reader.vendor', methods: ['GET', 'HEAD'], handle: handleVendor },
  { path: '/api/pdf.reader.file', methods: ['GET', 'HEAD'], handle: handleFile },
  { path: '/api/pdf.reader.open', methods: ['POST'], handle: handleOpen },
  { path: '/api/pdf.reader.explain', methods: ['POST'], handle: handleExplain },
  { path: '/api/pdf.reader.summarize', methods: ['POST'], handle: handleSummarize },
  { path: '/api/pdf.reader.ask', methods: ['POST'], handle: handleAsk },
  { path: '/api/pdf.reader.page-brief', methods: ['POST'], handle: handlePageBrief },
  { path: '/api/pdf.reader.notes', methods: ['GET', 'POST'], handle: handleNotes },
  { path: '/api/pdf.reader.upload', methods: ['POST'], requestBody: 'streaming', handle: handleUpload },
];

async function handleLibrary(runtime, services, request) {
  const store = runtime.storeFor(services);
  const url = new URL(request.url);
  const titles = clampInteger(url.searchParams.get('titles'), 0, 0, 12);
  const library = await store.library({ titles });
  return json(library);
}

async function handleVendor(runtime, services, request) {
  void runtime;
  void services;
  const name = new URL(request.url).searchParams.get('file') ?? '';
  const entry = VENDOR_FILES.get(name);
  if (entry === undefined) throw new PaperError('Unknown vendor file.', 404);
  let body;
  try {
    body = await readFile(join(VENDOR_DIR, entry.file));
  } catch {
    throw new PaperError('The bundled PDF engine is missing.', 500);
  }
  return new Response(request.method === 'HEAD' ? null : body, {
    headers: {
      'content-type': entry.type,
      'content-length': String(body.byteLength),
      'cache-control': 'public, max-age=86400',
    },
  });
}

async function handleFile(runtime, services, request) {
  const store = runtime.storeFor(services);
  const url = new URL(request.url);
  const requested = url.searchParams.get('path') ?? '';
  const { bytes } = await store.readBytes(requested);
  return new Response(request.method === 'HEAD' ? null : bytes, {
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(bytes.byteLength),
      'cache-control': 'no-store',
    },
  });
}

async function handleOpen(runtime, services, request) {
  const body = await readJsonBody(request);
  const requested = requireString(body.path, 'path');
  const store = runtime.storeFor(services);
  const opened = await store.open(requested, { force: body.refresh === true });
  const note = await store.loadNotes(requested);
  return json({
    paper: opened.wire,
    note,
    root: runtime.rootDir,
    model: modelLabel(services),
  });
}

async function handleExplain(runtime, services, request) {
  const body = await readJsonBody(request);
  const requested = requireString(body.path, 'path');
  const selection = requireString(body.text, 'text').trim();
  if (selection.length > MAX_SELECTION_CHARS) throw new PaperError('The selection is too long.', 413);
  const mode = body.mode === 'translate' || body.mode === 'terms' || body.mode === 'explain' ? body.mode : 'explain';
  const language = outputLanguage(body.locale);
  const store = runtime.storeFor(services);
  const { paper } = await store.open(requested);
  const page = Number.isInteger(body.page) ? body.page : Number.NaN;
  const localPageText = pageText(paper, page);
  const context = surroundingContext(localPageText.length > 0 ? localPageText : typeof body.context === 'string' ? body.context : '', selection);
  const section = typeof body.section === 'string' && body.section.length > 0 ? body.section : sectionForPage(paper, page);

  const cacheKey = [mode, language, requested, page, section, selection].join('\u0000');
  const hit = runtime.explainCache.get(cacheKey);
  if (hit !== undefined) return json({ ...hit, cached: true });

  let prompt;
  const truncationLimit = mode === 'translate' ? 6000 : mode === 'terms' ? 5000 : 4000;
  if (mode === 'translate') {
    prompt = translatePrompt({ selection, context, title: paper.title, language, truncated: selection.length > truncationLimit });
  } else if (mode === 'terms') {
    prompt = termsPrompt({ selection, context, language });
  } else {
    prompt = explainPrompt({ selection, context, title: paper.title, section, page, language, truncated: selection.length > truncationLimit });
  }
  const completed = await completeText(services, { ...prompt, signal: request.signal });
  const value = { text: completed.text, truncated: completed.truncated, model: modelLabel(services), mode };
  remember(runtime.explainCache, cacheKey, value);
  return json({ ...value, cached: false });
}

async function handleSummarize(runtime, services, request) {
  const body = await readJsonBody(request);
  const requested = requireString(body.path, 'path');
  const language = outputLanguage(body.locale);
  const style = body.style === 'brief' ? 'brief' : 'notes';
  const store = runtime.storeFor(services);
  const { paper } = await store.open(requested);
  if (paper.fullText.trim().length < 200) {
    throw new PaperError('This PDF has almost no extractable text (it may be a scan).', 422);
  }
  const digest = buildDigest(paper, style === 'brief' ? 18_000 : 26_000);
  const prompt = style === 'brief' ? briefPrompt({ paper, digest, language }) : notesPrompt({ paper, digest, language });
  return ndjson(
    (async function* () {
      yield { model: modelLabel(services) };
      yield* relayCompletion(services, prompt, request.signal);
      yield { done: true };
    })(),
  );
}

async function handleAsk(runtime, services, request) {
  const body = await readJsonBody(request);
  const requested = requireString(body.path, 'path');
  const question = requireString(body.question, 'question').trim().slice(0, 2000);
  const language = outputLanguage(body.locale);
  const store = runtime.storeFor(services);
  const { paper } = await store.open(requested);
  const digest = buildDigest(paper, 16_000);
  const history = Array.isArray(body.history)
    ? body.history
        .filter((turn) => turn !== null && typeof turn === 'object' && typeof turn.content === 'string')
        .map((turn) => ({ role: turn.role === 'assistant' ? 'assistant' : 'user', content: turn.content }))
    : [];
  const prompt = askPrompt({ paper, digest, question, history, language });
  return ndjson(
    (async function* () {
      yield { model: modelLabel(services) };
      yield* relayCompletion(services, prompt, request.signal);
      yield { done: true };
    })(),
  );
}

async function handlePageBrief(runtime, services, request) {
  const body = await readJsonBody(request);
  const requested = requireString(body.path, 'path');
  const page = clampInteger(body.page, 0, 0, 5000);
  const language = outputLanguage(body.locale);
  const store = runtime.storeFor(services);
  const { paper } = await store.open(requested);
  const text = pageText(paper, page);
  if (text.trim().length < 80) throw new PaperError('This page has no extractable text.', 422);
  const prompt = pageBriefPrompt({ title: paper.title, page, text, section: sectionForPage(paper, page), language });
  return ndjson(
    (async function* () {
      yield { model: modelLabel(services) };
      yield* relayCompletion(services, prompt, request.signal);
      yield { done: true };
    })(),
  );
}

async function handleUpload(runtime, services, request) {
  const store = runtime.storeFor(services);
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    throw new PaperError('That PDF is too large to open.', 413);
  }
  const rawName = safeDecode(request.headers.get('x-paper-filename') ?? '');
  const reader = request.body === null ? undefined : request.body.getReader();
  if (reader === undefined) throw new PaperError('The upload body is empty.', 400);
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    size += value.byteLength;
    if (size > MAX_UPLOAD_BYTES) throw new PaperError('That PDF is too large to open.', 413);
    chunks.push(Buffer.from(value));
  }
  if (size < 8) throw new PaperError('The uploaded file is empty.', 400);
  const bytes = Buffer.concat(chunks);
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new PaperError('That file is not a PDF.', 415);
  }
  const directory = join(store.rootDir, UPLOAD_DIR);
  await mkdir(directory, { recursive: true });
  let target = join(directory, sanitizePdfName(rawName));
  for (let suffix = 2; ; suffix += 1) {
    try {
      await stat(target);
      target = join(directory, sanitizePdfName(rawName, suffix));
    } catch {
      break;
    }
  }
  await writeFile(target, bytes);
  return json({ path: store.relativePath(target), name: basename(target), size });
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Sanitize an uploaded file name into a safe, unique PDF name.
 * @param {string} raw client-supplied name
 * @param {number} [suffix] collision suffix
 * @returns {string} safe file name
 */
function sanitizePdfName(raw, suffix = 0) {
  const base = basename(String(raw).replace(/\\/g, '/')) || 'paper.pdf';
  const stem = base
    .replace(/\.pdf$/i, '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'paper';
  return `${stem}${suffix > 1 ? `-${suffix}` : ''}.pdf`;
}

async function handleNotes(runtime, services, request) {
  const store = runtime.storeFor(services);
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const requested = url.searchParams.get('path') ?? '';
    const note = await store.loadNotes(requested);
    return json(note);
  }
  const body = await readJsonBody(request);
  const requested = requireString(body.path, 'path');
  const markdown = typeof body.markdown === 'string' ? body.markdown : '';
  const saved = await store.saveNotes(requested, markdown);
  return json(saved);
}

// #endregion

// #region Tools

/**
 * Agent tools over the same store the UI uses.
 * @param {{store: PaperStore, rootDir: string}} runtime plugin runtime
 * @returns {object[]} tool definitions
 */
function createTools(runtime, services) {
  const storeFor = (exec) => runtime.storeFor(services, exec?.agent);
  return [
    {
      name: 'paper_list',
      description:
        'List PDF papers available in the current workspace. Use this before paper_read/paper_search when the user refers to a paper by title or topic.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: textOutput(),
      async execute(_args, exec) {
        const library = await storeFor(exec).library({ titles: 8 });
        if (library.entries.length === 0) {
          return { text: `No PDF files were found under ${library.root} (searched 4 directory levels).` };
        }
        const lines = library.entries.map((entry, index) => {
          const meta = entry.title !== null ? `"${entry.title}", ${entry.pageCount} pages` : `${formatBytes(entry.size)}`;
          return `${index + 1}. ${entry.path} — ${meta}`;
        });
        return {
          text: [
            `PDF papers under ${library.root} (${library.entries.length}):`,
            ...lines,
            '',
            'Use paper_read with the path (and optionally a section title or page range) to read one.',
          ].join('\n'),
        };
      },
    },
    {
      name: 'paper_read',
      description:
        'Read a PDF paper from the workspace as reconstructed text. Args: path (required, from paper_list); section (optional, case-insensitive title fragment such as "method" or "experiment"); pages (optional, e.g. "3" or "4-6"); maxChars (optional, default 14000). Without section/pages the tool returns a structured overview: metadata, outline, abstract and the most important sections. Long papers are truncated; read specific sections or pages for detail.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Paper path relative to the workspace, as returned by paper_list.' },
          section: { type: 'string', description: 'Case-insensitive section-title fragment.' },
          pages: { type: 'string', description: 'A page or range, e.g. "3" or "4-6" (1-based).' },
          maxChars: { type: 'integer', description: 'Maximum characters to return (default 14000, max 40000).' },
        },
      },
      output: textOutput(),
      async execute(args, exec) {
        const store = storeFor(exec);
        const requested = requireString(args.path, 'path');
        const maxChars = clampInteger(args.maxChars, 14_000, 1000, 40_000);
        const { paper } = await store.open(requested);
        const outline = paper.sections.map((section) => `- ${section.title} (page ${section.page + 1})`).join('\n');
        const header = [
          `Title: ${paper.title}`,
          `Authors: ${paper.authors.length > 0 ? paper.authors : 'unknown'}`,
          `Pages: ${paper.pageCount}`,
          `Path: ${store.relativePath(store.resolvePath(requested))}`,
        ].join('\n');

        if (typeof args.section === 'string' && args.section.trim().length > 0) {
          const needle = args.section.trim().toLowerCase();
          const matches = paper.sections.filter((section) => section.title.toLowerCase().includes(needle));
          if (matches.length === 0) {
            return {
              text: `${header}\n\nNo section matched "${args.section}". Sections:\n${outline}`,
            };
          }
          // A matching heading can be a container whose text lives in its
          // subsections ("Results" -> "Machine Translation"), so pull the
          // following sections until the character budget is spent.
          const start = paper.sections.indexOf(matches[0]);
          const group = [];
          let collected = 0;
          for (let index = start; index < paper.sections.length && group.length < 4; index += 1) {
            const section = paper.sections[index];
            if (section.text.trim().length === 0) continue;
            group.push(section);
            collected += section.text.length;
            if (collected >= maxChars) break;
          }
          if (group.length === 0) {
            return { text: `${header}\n\nThe section "${matches[0].title}" has no extractable text. Use pages to read it, or paper_read without a section for an overview.` };
          }
          const share = Math.max(1200, Math.floor(maxChars / group.length));
          const body = group
            .map((section) => `## ${section.title} (page ${section.page + 1})\n${capText(section.text, share)}`)
            .join('\n\n');
          return { text: `${header}\n\n${body}` };
        }

        if (typeof args.pages === 'string' && args.pages.trim().length > 0) {
          const range = parsePageRange(args.pages, paper.pageCount);
          const body = paper.pages
            .slice(range.start, range.end + 1)
            .map((page) => `[Page ${page.index + 1}]\n${page.text}`)
            .join('\n\n');
          if (body.trim().length === 0) return { text: `${header}\n\nThose pages have no extractable text.` };
          return { text: `${header}\n\n${capText(body, maxChars)}` };
        }

        const digest = buildDigest(paper, maxChars - header.length - outline.length - 40);
        return {
          text: [
            header,
            '',
            'Outline:',
            outline.length > 0 ? outline : '(no section headings were detected)',
            '',
            'Content:',
            digest,
          ].join('\n'),
        };
      },
    },
    {
      name: 'paper_search',
      description:
        'Search inside one PDF paper for a word or phrase. Returns matching pages with surrounding snippets. Use this to locate a method, dataset, number or claim before quoting it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'query'],
        properties: {
          path: { type: 'string', description: 'Paper path relative to the workspace.' },
          query: { type: 'string', description: 'Word or phrase to find (case-insensitive).' },
          maxResults: { type: 'integer', description: 'Maximum matches to return (default 12, max 40).' },
        },
      },
      output: textOutput(),
      async execute(args, exec) {
        const store = storeFor(exec);
        const requested = requireString(args.path, 'path');
        const query = requireString(args.query, 'query');
        const { matches, total } = await store.search(requested, query, {
          maxResults: clampInteger(args.maxResults, 12, 1, 40),
        });
        if (matches.length === 0) return { text: `No matches for "${query}".` };
        const lines = matches.map(
          (match) => `[page ${match.page + 1}] …${match.before} **${match.match}** ${match.after}…`,
        );
        return { text: `${total} match(es) for "${query}":\n\n${lines.join('\n\n')}` };
      },
    },
    {
      name: 'paper_save_note',
      description:
        'Save or append reading notes (Markdown) for a paper. Notes live under paper-notes/ in the workspace and are shown in the PDF reader UI. Args: path (paper path), markdown (complete note text), mode ("overwrite" default, or "append").',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'markdown'],
        properties: {
          path: { type: 'string', description: 'Paper path relative to the workspace.' },
          markdown: { type: 'string', description: 'Markdown note body.' },
          mode: { type: 'string', enum: ['overwrite', 'append'], description: 'Replace the note (default) or append to it.' },
        },
      },
      output: textOutput(),
      async execute(args, exec) {
        const store = storeFor(exec);
        const requested = requireString(args.path, 'path');
        const markdown = requireString(args.markdown, 'markdown');
        const mode = args.mode === 'append' ? 'append' : 'overwrite';
        let body = markdown;
        if (mode === 'append') {
          const existing = await store.loadNotes(requested);
          body = existing.markdown !== null && existing.markdown.trim().length > 0
            ? `${existing.markdown.replace(/\s+$/, '')}\n\n${markdown}`
            : markdown;
        }
        const saved = await store.saveNotes(requested, body);
        return { text: `Saved ${body.length} characters of notes to ${saved.path} (${mode}).` };
      },
    },
  ];
}

function textOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string' } },
    },
    render(args, value) {
      void args;
      const text = value !== null && typeof value === 'object' && typeof value.text === 'string' ? value.text : '';
      return [{ type: 'text', text }];
    },
  };
}

// #endregion

// #region Small utilities

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PaperError(`Missing required string argument: ${name}.`);
  }
  return value;
}

function sectionForPage(paper, page) {
  if (!Number.isInteger(page)) return '';
  let match = '';
  for (const section of paper.sections) {
    if (section.page <= page) match = section.title;
    else break;
  }
  return match;
}

function pageText(paper, page) {
  if (!Number.isInteger(page) || page < 0 || page >= paper.pages.length) return '';
  return paper.pages[page].text;
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function parsePageRange(text, pageCount) {
  const cleaned = text.trim();
  const range = /^(\d+)\s*(?:[-–~]\s*(\d+))?$/.exec(cleaned);
  if (range === null) throw new PaperError(`Invalid page range: "${text}". Use "3" or "4-6".`);
  const start = clampInteger(range[1], 1, 1, Math.max(1, pageCount)) - 1;
  const end = clampInteger(range[2] ?? range[1], start + 1, 1, Math.max(1, pageCount)) - 1;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function capText(text, limit) {
  if (typeof text !== 'string') return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit)).trimEnd()}\n\n…(truncated; use section or pages for more)`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function remember(map, key, value) {
  if (map.size >= EXPLAIN_CACHE_LIMIT) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

// #endregion
