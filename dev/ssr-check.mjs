/**
 * Client render smoke test (no browser).
 *
 * Evaluates the real client bundle in a sandbox with stub `window`/`document`
 * globals, captures its slot registrations, then server-renders the library
 * page, the reader page, the assistant panes and the Markdown renderer. This
 * catches crashes that registration alone would hide.
 *
 * Requires react + react-dom/server in dev/node_modules (`cd dev && npm install`).
 * Run: node dev/ssr-check.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, '..');
const ssrRequire = createRequire(join(here, 'anchor.cjs'));
const React = ssrRequire('react');
const { renderToStaticMarkup } = ssrRequire('react-dom/server');

const source = readFileSync(join(pluginDir, 'client.js'), 'utf8').replace(
  '    return {\n      inject: [\'slots\', \'locale\'],',
  '    window.__PPR_TEST__ = { Reader, PaperReaderApp, NotesPane, ExplainPane, AskPane, Library, SelectionPopup, Markdown, PanelIcon };\n    return {\n      inject: [\'slots\', \'locale\'],',
);

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.textContent = '';
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  setAttribute() {}
}

const documentStub = {
  baseURI: 'http://localhost:3080/',
  head: new FakeElement('head'),
  body: new FakeElement('body'),
  createElement(tag) {
    return new FakeElement(tag);
  },
  querySelectorAll() {
    return [];
  },
};

const localStorageStub = {
  store: new Map(),
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  },
  setItem(key, value) {
    this.store.set(key, String(value));
  },
  removeItem(key) {
    this.store.delete(key);
  },
};

const windowStub = {
  __ModuleLoader__: null,
  localStorage: localStorageStub,
  location: { href: 'http://localhost:3080/', origin: 'http://localhost:3080' },
  navigator: { language: 'en-US' },
  devicePixelRatio: 1,
  innerWidth: 1440,
  innerHeight: 900,
  matchMedia() {
    return { matches: false, addEventListener() {}, removeEventListener() {} };
  },
  addEventListener() {},
  removeEventListener() {},
  setTimeout(fn) {
    return setTimeout(fn, 0);
  },
  clearTimeout(id) {
    clearTimeout(id);
  },
  getSelection() {
    return null;
  },
};

const sandbox = {
  window: windowStub,
  document: documentStub,
  navigator: windowStub.navigator,
  localStorage: localStorageStub,
  console,
  setTimeout,
  clearTimeout,
  URL,
  URLSearchParams,
  TextDecoder,
  TextEncoder,
  fetch() {
    throw new Error('network is not available in the render smoke test');
  },
  AbortController,
  Intl,
  IntersectionObserver: class {
    observe() {}
    disconnect() {}
  },
  ResizeObserver: class {
    constructor() {}
    observe() {}
    disconnect() {}
  },
};
windowStub.window = windowStub;
windowStub.document = documentStub;

let captured = null;
windowStub.__ModuleLoader__ = {
  load(spec) {
    captured = spec;
  },
};

vm.runInNewContext(source, sandbox, { filename: 'client.js' });
assert.ok(captured !== null, 'bundle registered through __ModuleLoader__');
assert.equal(captured.id, '@local/pdf-paper-reader');
assert.equal(typeof captured.factory, 'function');

const requireStub = (name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require: ${name}`);
};
const api = captured.factory(requireStub);
assert.equal(typeof api.apply, 'function');
assert.equal(api.inject.join(','), 'slots,locale');

// Fake client context: locale dictionary + slot capture.
const dictionaries = { en: {}, zh: {} };
const registrations = [];
const fakeCtx = {
  locale: {
    register(namespace, dicts) {
      for (const [key, value] of Object.entries(dicts)) dictionaries[key] = value;
      return () => {};
    },
    bind(namespace) {
      return (key, params) => translate(namespace, key, params);
    },
    subscribe() {
      return () => {};
    },
    getLocale() {
      return { active: 'en' };
    },
  },
  slots: {
    inject(target, callback) {
      callback();
      return () => {};
    },
    register(options, Component) {
      registrations.push({ options, Component });
      return () => {};
    },
  },
  effect(callback) {
    callback();
    return () => {};
  },
};

function translate(namespace, key, params) {
  const current = dictionaries.zh?.[key] ?? dictionaries.en?.[key] ?? key;
  if (params === undefined) return current;
  return Object.keys(params).reduce((text, name) => text.replaceAll(`{${name}}`, String(params[name])), current);
}

api.apply(fakeCtx);
assert.equal(registrations.length, 2, 'two slot registrations');
const mainRegistration = registrations.find((entry) => entry.options.name === 'main');
const panelRegistration = registrations.find((entry) => entry.options.name === 'sidebar.panellist');
assert.ok(mainRegistration !== undefined, 'main panel registered');
assert.equal(mainRegistration.options.key, 'pdf-paper-reader');
assert.ok(panelRegistration !== undefined, 'sidebar panel registered');
assert.equal(panelRegistration.options.id, 'pdf-paper-reader');
assert.equal(panelRegistration.options.order, 32);

const components = windowStub.__PPR_TEST__;
assert.ok(components !== undefined, 'test hook present');

const render = (element) => renderToStaticMarkup(element);

// ---- Library page ---------------------------------------------------------
const libraryPage = render(React.createElement(components.PaperReaderApp, { ctx: fakeCtx }));
assert.ok(libraryPage.includes('论文库'), 'library title rendered');
assert.ok(libraryPage.includes('ppr-root'), 'root class rendered');
assert.ok(libraryPage.includes('ppr-lib'), 'library class rendered');
assert.ok(!libraryPage.includes('failed to render'), 'no boundary fallback');

// ---- Reader page ----------------------------------------------------------
const paper = {
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
const readerPage = render(
  React.createElement(components.Reader, {
    ctx: fakeCtx,
    path: 'papers/attention.pdf',
    paper,
    note: null,
    language: 'zh',
    onLanguage: () => {},
    onBack: () => {},
    t: (key, params) => translate('pdf-paper-reader', key, params),
  }),
);
for (const expected of ['Attention Is All You Need', 'ppr-viewer', 'ppr-assistant', '精读笔记', 'Introduction']) {
  assert.ok(readerPage.includes(expected), `reader renders ${expected}`);
}
assert.ok(readerPage.includes('第 1 / 3 页') || readerPage.includes('第 0 / 3 页'), 'page indicator rendered');

// ---- Assistant panes ------------------------------------------------------
const t = (key, params) => translate('pdf-paper-reader', key, params);

const notesEmpty = render(
  React.createElement(components.NotesPane, {
    t,
    notes: { text: '', savedPath: '', dirty: false, editing: false, saving: false, copied: false, status: 'idle', error: null, model: '' },
    onGenerate: () => {},
    onSave: () => {},
    onEditToggle: () => {},
    onCopy: () => {},
    onClear: () => {},
    onChangeText: () => {},
  }),
);
assert.ok(notesEmpty.includes('生成这篇论文的精读笔记'), 'notes empty state');

const notesFilled = render(
  React.createElement(components.NotesPane, {
    t,
    notes: { text: '# Title\n\n- bullet **bold**', savedPath: 'paper-notes/x.md', dirty: true, editing: false, saving: false, copied: false, status: 'ready', error: null, model: 'x/y' },
    onGenerate: () => {},
    onSave: () => {},
    onEditToggle: () => {},
    onCopy: () => {},
    onClear: () => {},
    onChangeText: () => {},
  }),
);
assert.ok(notesFilled.includes('<h2'), 'markdown heading rendered');
assert.ok(notesFilled.includes('<strong>'), 'markdown bold rendered');
assert.ok(notesFilled.includes('paper-notes/x.md'), 'saved path rendered');
assert.ok(notesFilled.includes('有未保存的修改'), 'dirty status rendered');

const explainPane = render(
  React.createElement(components.ExplainPane, {
    t,
    explain: {
      status: 'ready',
      kind: 'explain',
      label: '',
      text: '## 讲解\n\n- 这句话在说什么',
      error: null,
      model: 'x/y',
      page: 2,
      selectionText: 'the dominant sequence transduction models',
    },
    onPageBrief: () => {},
    onBrief: () => {},
  }),
);
assert.ok(explainPane.includes('选中内容'), 'selection quote rendered');
assert.ok(explainPane.includes('这句话在说什么'), 'explain markdown rendered');

const askPane = render(
  React.createElement(components.AskPane, {
    t,
    chat: {
      messages: [
        { role: 'user', content: 'What is the contribution?' },
        { role: 'assistant', content: 'It introduces **BERT**.' },
      ],
      status: 'idle',
      error: null,
    },
    onAsk: () => {},
    busy: false,
    suggestions: ['suggestion one'],
  }),
);
assert.ok(askPane.includes('What is the contribution?'), 'user message rendered');
assert.ok(askPane.includes('<strong>BERT</strong>'), 'assistant markdown rendered');

// ---- Markdown renderer ----------------------------------------------------
const markdown = render(
  React.createElement(components.Markdown, {
    text: [
      '# Heading one',
      '## Heading two',
      '',
      '- item with **bold** and `code`',
      '- second item',
      '',
      '> quoted line',
      '',
      '| Term | Meaning |',
      '| --- | --- |',
      '| attention | weighting |',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      'A [link](https://example.com) and a paragraph.',
    ].join('\n'),
  }),
);
assert.ok(/<h2[^>]*>Heading one<\/h2>/.test(markdown), 'h1');
assert.ok(markdown.includes('<strong>bold</strong>'), 'bold');
assert.ok(/<code[^>]*>code<\/code>/.test(markdown), 'inline code');
assert.ok(markdown.includes('<blockquote'), 'blockquote');
assert.ok(markdown.includes('<table'), 'table');
assert.ok(markdown.includes('<pre'), 'code fence');
assert.ok(markdown.includes('href="https://example.com"'), 'link');

// ---- Panel icon -----------------------------------------------------------
const icon = render(React.createElement(components.PanelIcon, { size: 16 }));
assert.ok(icon.includes('<svg'), 'icon renders');

console.log('ssr-check: ok');
console.log(`  slots: ${registrations.map((entry) => entry.options.name).join(', ')}`);
console.log(`  reader markup: ${readerPage.length} chars`);
