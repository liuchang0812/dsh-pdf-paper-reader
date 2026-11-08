/**
 * DOM integration check (jsdom, no browser).
 *
 * Mounts the real client half in jsdom with stubbed `pdf.js`, an authenticated
 * fetch stub, and intersection observers that fire. Exercises the real render
 * + effect path: library -> auto-open -> PDF pages with text layer -> generate
 * notes (streaming) -> save notes -> ask the model.
 *
 * Requires jsdom + react + react-dom in dev/node_modules (`cd dev && npm install`).
 * Run: node dev/dom-check.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, '..');
const req = createRequire(join(here, 'anchor.cjs'));
const { JSDOM } = req('jsdom');

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
  url: 'http://localhost:3080/',
  pretendToBeVisual: true,
});
const { window } = dom;
const { document } = window;

// ---------------------------------------------------------------------------
// Globals the bundle expects
// ---------------------------------------------------------------------------
globalThis.window = window;
globalThis.document = document;
for (const [key, value] of Object.entries({
  HTMLElement: window.HTMLElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  Node: window.Node,
  Element: window.Element,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  getSelection: () => window.getSelection(),
})) {
  try {
    globalThis[key] = value;
  } catch {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
}

window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.devicePixelRatio = 1;
window.getSelection = () => ({ isCollapsed: true, toString: () => '', getRangeAt: () => null });

const pendingObservers = [];
class IntersectionObserverStub {
  constructor(callback) {
    this.callback = callback;
    this.targets = [];
  }

  observe(target) {
    this.targets.push(target);
    pendingObservers.push(this);
  }

  unobserve() {}

  disconnect() {
    this.targets = [];
  }
}
globalThis.IntersectionObserver = IntersectionObserverStub;
window.IntersectionObserver = IntersectionObserverStub;
class ResizeObserverStub {
  constructor(callback) {
    this.callback = callback;
  }

  observe() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub;
window.ResizeObserver = ResizeObserverStub;

function flushIntersections() {
  for (const observer of pendingObservers.splice(0)) {
    const entries = observer.targets.map((target) => ({ isIntersecting: true, target }));
    if (entries.length > 0) observer.callback(entries, observer);
  }
}

// Canvas 2D context is not implemented by jsdom; the stubbed page renderer
// never touches it.
window.HTMLCanvasElement.prototype.getContext = () => ({});

// ---------------------------------------------------------------------------
// Fake pdf.js engine
// ---------------------------------------------------------------------------
const renderedPages = [];
const fakePdfjs = {
  version: 'fake-3.11.174',
  GlobalWorkerOptions: {},
  getDocument() {
    return {
      promise: Promise.resolve({
        numPages: 3,
        getPage: async (pageNumber) => ({
          getViewport({ scale }) {
            return { width: 612 * scale, height: 792 * scale, scale, rawDims: { pageWidth: 612, pageHeight: 792 } };
          },
          render() {
            renderedPages.push(pageNumber);
            return { promise: Promise.resolve(), cancel() {} };
          },
          async getTextContent() {
            return { items: [{ str: `page ${pageNumber} text`, transform: [10, 0, 0, 10, 20, 40], width: 60, height: 10 }] };
          },
          cleanup() {},
        }),
        async destroy() {},
      }),
    };
  },
  renderTextLayer() {
    return { promise: Promise.resolve() };
  },
};
window.pdfjsLib = fakePdfjs;

// ---------------------------------------------------------------------------
// Fetch stub: authenticated API routes
// ---------------------------------------------------------------------------
const requests = [];

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function ndjsonResponse(frames) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

const fakePaper = {
  title: 'Attention Is All You Need',
  authors: 'Ashish Vaswani, Noam Shazeer',
  pageCount: 3,
  abstract: 'We propose the Transformer.',
  bodySize: 10,
  pages: [
    { index: 0, width: 612, height: 792, text: 'Abstract\n\nThe dominant sequence transduction models.' },
    { index: 1, width: 612, height: 792, text: 'Introduction body text.' },
    { index: 2, width: 612, height: 792, text: 'Conclusion.' },
  ],
  sections: [
    { title: 'Introduction', level: 1, page: 1 },
    { title: 'Model Architecture', level: 1, page: 1 },
  ],
  outlineTitles: [],
  fullTextLength: 500,
};

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), 'http://localhost:3080/');
  const path = url.pathname;
  requests.push({ path, method: init.method ?? 'GET' });
  if (path === '/api/pdf.reader.library') {
    return jsonResponse({
      entries: [{ path: 'papers/attention.pdf', name: 'attention', size: 2048, mtimeMs: 1, title: fakePaper.title, pageCount: 3, sections: 2 }],
      root: '/workspace',
      truncated: false,
    });
  }
  if (path === '/api/pdf.reader.open') {
    return jsonResponse({ paper: fakePaper, note: { markdown: null, path: 'paper-notes/attention.md' }, root: '/workspace', model: 'fake/model' });
  }
  if (path === '/api/pdf.reader.file') {
    return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 });
  }
  if (path === '/api/pdf.reader.summarize') {
    return ndjsonResponse([{ model: 'fake/model' }, { delta: '## 研究问题\n' }, { delta: '- 生成成功的测试笔记' }, { done: true }]);
  }
  if (path === '/api/pdf.reader.ask') {
    return ndjsonResponse([{ model: 'fake/model' }, { delta: '这是 **AI** 的回答。' }, { done: true }]);
  }
  if (path === '/api/pdf.reader.notes') {
    return jsonResponse({ path: 'paper-notes/attention.md', absolute: '/workspace/paper-notes/attention.md' });
  }
  if (path === '/api/pdf.reader.page-brief' || path === '/api/pdf.reader.explain') {
    return jsonResponse({ text: '本页讲解内容。', model: 'fake/model', mode: 'explain' });
  }
  return jsonResponse({ error: `unexpected route ${path}` }, 404);
};

// ---------------------------------------------------------------------------
// Load the real client bundle
// ---------------------------------------------------------------------------
let captured = null;
window.__ModuleLoader__ = {
  load(spec) {
    captured = spec;
  },
};
const source = readFileSync(join(pluginDir, 'client.js'), 'utf8').replace(
  "    return {\n      inject: ['slots', 'locale'],",
  "    window.__PPR_TEST__ = { PaperReaderApp, Reader };\n    return {\n      inject: ['slots', 'locale'],",
);
vm.runInThisContext(source, { filename: 'client.js' });
assert.ok(captured !== null, 'client bundle registered');

const React = req('react');
const { createRoot } = req('react-dom/client');
const api = captured.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require: ${name}`);
});

const dictionaries = { en: {}, zh: {} };
const fakeCtx = {
  locale: {
    register(namespace, dicts) {
      Object.assign(dictionaries, dicts);
      return () => {};
    },
    bind() {
      return (key, params) => {
        const template = dictionaries.zh?.[key] ?? dictionaries.en?.[key] ?? key;
        if (params === undefined) return template;
        return Object.keys(params).reduce((text, name) => text.replaceAll(`{${name}}`, String(params[name])), template);
      };
    },
    subscribe() {
      return () => {};
    },
    getLocale() {
      return { active: 'zh' };
    },
  },
  slots: {
    inject(target, callback) {
      callback();
      return () => {};
    },
    register() {
      return () => {};
    },
  },
  effect(callback) {
    callback();
    return () => {};
  },
};
api.apply(fakeCtx);

// Auto-open the last paper on mount.
window.localStorage.setItem('ppr.lastPaper', 'papers/attention.pdf');

const errors = [];
const originalError = console.error;
console.error = (...args) => {
  errors.push(args.map(String).join(' '));
};

const app = document.getElementById('app');
const root = createRoot(app);
root.render(React.createElement(window.__PPR_TEST__.PaperReaderApp, { ctx: fakeCtx }));

async function waitFor(predicate, label, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    flushIntersections();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`Timed out waiting for ${label}. DOM: ${document.body.innerHTML.slice(0, 1200)}`);
}

async function settle() {
  flushIntersections();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
}

try {
  // library -> auto-open -> reader
  await waitFor(() => document.querySelector('.ppr-viewer') !== null, 'reader mount');
  await waitFor(() => document.body.textContent.includes('Attention Is All You Need'), 'paper title');
  await waitFor(() => document.querySelectorAll('.ppr-page').length === 3, 'three pages');
  await waitFor(() => document.querySelectorAll('.ppr-page canvas').length === 3, 'rendered canvases');
  await waitFor(() => document.querySelectorAll('.ppr-textLayer').length === 3, 'text layers');
  assert.ok(renderedPages.length >= 1, 'pdf page render invoked');
  assert.ok(requests.some((entry) => entry.path === '/api/pdf.reader.library' && entry.method === 'GET'), 'library fetched');
  assert.ok(requests.some((entry) => entry.path === '/api/pdf.reader.open' && entry.method === 'POST'), 'open posted');
  assert.ok(requests.some((entry) => entry.path === '/api/pdf.reader.file'), 'pdf bytes fetched');

  // Outline
  assert.ok(document.querySelector('.ppr-outline').textContent.includes('Introduction'), 'outline rendered');

  // Generate notes (streaming)
  const generateButton = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('生成精读笔记'));
  assert.ok(generateButton !== undefined, 'generate notes button present');
  generateButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => document.body.textContent.includes('生成成功的测试笔记'), 'streamed notes text');
  assert.ok(requests.some((entry) => entry.path === '/api/pdf.reader.summarize' && entry.method === 'POST'), 'summarize streamed');
  await settle();
  // Streaming markdown heading rendered inside the notes pane.
  assert.ok(document.querySelector('.ppr-pane .ppr-md .ppr-h2'), 'notes markdown heading');

  // Save notes
  const saveButton = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '保存');
  assert.ok(saveButton !== undefined, 'save button present');
  saveButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => requests.some((entry) => entry.path === '/api/pdf.reader.notes' && entry.method === 'POST'), 'notes saved');
  await waitFor(() => document.body.textContent.includes('paper-notes/attention.md'), 'saved path shown');

  // Ask AI
  const askTab = [...document.querySelectorAll('.ppr-tab')].find((button) => button.textContent.includes('问 AI'));
  assert.ok(askTab !== undefined, 'ask tab present');
  askTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  const textarea = document.querySelector('.ppr-chat-input textarea');
  assert.ok(textarea !== null, 'chat textarea present');
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  valueSetter.call(textarea, '这篇论文的核心贡献是什么？');
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle();
  const sendButton = [...document.querySelectorAll('.ppr-chat-input button')].find((button) => button.title === '发送');
  assert.ok(sendButton !== undefined, 'send button present');
  sendButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => document.body.textContent.includes('这是 AI 的回答。') || document.body.innerHTML.includes('<strong>AI</strong>'), 'streamed answer');
  assert.ok(requests.some((entry) => entry.path === '/api/pdf.reader.ask' && entry.method === 'POST'), 'ask streamed');

  const realErrors = errors.filter(
    (line) => !line.includes('not wrapped in act') && !line.includes('ReactDOMTestUtils') && !line.includes('Warning: An update'),
  );
  if (realErrors.length > 0) {
    originalError('Captured console errors:');
    for (const line of realErrors) originalError(line);
  }
  assert.equal(realErrors.length, 0, 'no console errors');

  console.log('dom-check: ok');
  console.log(`  requests: ${requests.map((entry) => entry.path.replace('/api/pdf.reader.', '')).join(', ')}`);
  console.log(`  pages rendered: ${renderedPages.length}, canvases: ${document.querySelectorAll('canvas').length}`);
} finally {
  console.error = originalError;
  root.unmount();
}
