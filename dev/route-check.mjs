/**
 * Host route / tool check with a fake Cordis context and a fake model.
 *
 * Run from the plugin directory:  node dev/route-check.mjs
 *
 * It exercises the real HTTP handlers and agent tools against a generated
 * fixture PDF: library scan, PDF parsing, streaming summaries, selection
 * explanation, uploads, notes persistence and the four tools. No dependencies
 * are needed beyond Node.
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.js';
import { createFixturePdf, FIXTURE_PAGES, FIXTURE_TITLE } from './fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, '..');
const root = join(pluginDir, '.tmp-route-check');
const fixtureName = 'reader-fixture.pdf';
const fixturePath = `papers/${fixtureName}`;

class FakeContext {
  constructor(services) {
    this.services = services;
    this.effects = [];
    this.routes = new Map();
    this.tools = new Map();
    this.injects = [];
  }

  get(name) {
    return this.services[name];
  }

  effect(callback, label) {
    const disposer = callback();
    this.effects.push({ label, disposer });
    return () => {};
  }

  inject(names, callback) {
    const scope = {
      get: (name) => this.services[name],
      effect: (callback, label) => this.effect(callback, label),
      connection: this.services.connection,
      tools: this.services.tools,
    };
    this.injects.push(names);
    callback(scope);
  }
}

function createServices() {
  const calls = [];
  const llm = {
    stream(options) {
      calls.push(options);
      const text = 'FAKE-ANSWER';
      return (async function* generate() {
        for (const chunk of ['FAKE-', 'ANSWER']) yield { type: 'text-delta', index: 0, text: chunk };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  const routes = new Map();
  const tools = new Map();
  const services = {
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) },
    workingDirectory: { defaultDirectory: root },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
          return async () => {};
        },
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => {};
      },
    },
    calls,
    routes,
    registeredTools: tools,
  };
  return services;
}

async function call(services, path, init = {}) {
  const routePath = path.split('?')[0];
  const route = services.routes.get(routePath);
  assert.ok(route !== undefined, `route not registered: ${path}`);
  const request = new Request(`http://localhost${path}`, init);
  const response = await route.fetch(request);
  return response;
}

async function callJson(services, path, body, method = 'POST') {
  const response = await call(services, path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function readNdjson(response) {
  const text = await response.text();
  const frames = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
  return { frames, text: frames.map((frame) => frame.delta ?? '').join('') };
}

async function main() {
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, 'papers'), { recursive: true });
  const paperPath = join(root, 'papers', fixtureName);
  await writeFile(paperPath, createFixturePdf());

  const services = createServices();
  const context = new FakeContext(services);
  apply(context, {});

  // Routes are registered behind the optional `connection` service.
  assert.ok(services.routes.size >= 8, `expected routes, got ${[...services.routes.keys()]}`);
  assert.ok(services.registeredTools.size === 4, `expected 4 tools, got ${[...services.registeredTools.keys()]}`);

  // Library
  const library = await callJson(services, '/api/pdf.reader.library', undefined, 'GET');
  assert.equal(library.status, 200);
  assert.equal(library.data.entries.length, 1);
  assert.equal(library.data.entries[0].path, fixturePath);

  // Open
  const opened = await callJson(services, '/api/pdf.reader.open', { path: library.data.entries[0].path });
  assert.equal(opened.status, 200);
  const paper = opened.data.paper;
  assert.equal(paper.title, FIXTURE_TITLE, 'title detected');
  assert.equal(paper.pageCount, FIXTURE_PAGES, 'page count');
  assert.ok(paper.abstract.includes('structured reading pipeline'), 'abstract text');
  assert.ok(paper.sections.length >= 4, 'sections detected');
  assert.ok(paper.sections.some((section) => /Method/i.test(section.title)), 'method section detected');
  assert.ok(paper.sections.some((section) => /Experiments/i.test(section.title)), 'experiments section detected');
  assert.ok(opened.data.note !== undefined && opened.data.note.markdown === null, 'no note yet');

  // Path traversal must be rejected.
  const traversal = await callJson(services, '/api/pdf.reader.open', { path: '../../../etc/passwd' });
  assert.equal(traversal.status, 403, 'path traversal rejected');

  // Explanation (non-streaming).
  const explain = await callJson(services, '/api/pdf.reader.explain', {
    path: fixturePath,
    mode: 'explain',
    text: 'structured reading pipeline',
    page: 0,
    locale: 'zh',
  });
  assert.equal(explain.status, 200);
  assert.equal(explain.data.text, 'FAKE-ANSWER');
  assert.ok(services.calls.length >= 1, 'model called');
  const explainPrompt = services.calls[services.calls.length - 1].messages[0].content[0].text;
  assert.ok(explainPrompt.includes('structured reading pipeline'), 'selection in prompt');
  assert.ok(services.calls[services.calls.length - 1].provider === 'fake-provider');

  // Cached second call does not hit the model again.
  const before = services.calls.length;
  const explainAgain = await callJson(services, '/api/pdf.reader.explain', {
    path: fixturePath,
    mode: 'explain',
    text: 'structured reading pipeline',
    page: 0,
    locale: 'zh',
  });
  assert.equal(explainAgain.data.cached, true);
  assert.equal(services.calls.length, before, 'cached explain skips the model');

  // Streaming notes.
  const notesStream = await call(services, '/api/pdf.reader.summarize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: fixturePath, style: 'notes', locale: 'zh' }),
  });
  assert.equal(notesStream.status, 200);
  const notes = await readNdjson(notesStream);
  assert.equal(notes.text, 'FAKE-ANSWER');
  assert.ok(notes.frames.some((frame) => frame.done === true), 'done frame');
  const notesPrompt = services.calls[services.calls.length - 1].messages[0].content[0].text;
  assert.ok(notesPrompt.includes('## 研究问题'), 'notes structure requested');
  assert.ok(notesPrompt.includes(paper.title), 'title in notes prompt');

  // Streaming page brief + ask.
  const brief = await readNdjson(
    await call(services, '/api/pdf.reader.page-brief', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: fixturePath, page: 1, locale: 'en' }),
    }),
  );
  assert.equal(brief.text, 'FAKE-ANSWER');
  const ask = await readNdjson(
    await call(services, '/api/pdf.reader.ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: fixturePath,
        question: 'What is the main contribution?',
        history: [{ role: 'user', content: 'hi' }],
        locale: 'en',
      }),
    }),
  );
  assert.equal(ask.text, 'FAKE-ANSWER');

  // Digest quality: the abstract appears once, and the results sections carry
  // numbers instead of being starved by keyword ranking.
  const { buildDigest } = await import('../lib/prompts.js');
  const parsed = await (await import('../lib/pdf.js')).parsePdf(
    new Uint8Array(await readFile(paperPath)),
  );
  const digest = buildDigest(parsed, 22_000);
  const abstractOccurrences = digest.split('generates grounded reading notes for readers').length - 1;
  assert.equal(abstractOccurrences, 1, 'abstract appears exactly once in the digest');
  assert.ok(/28\.4/.test(digest), 'results numbers reach the digest');
  assert.ok(!/References/.test(digest), 'references are excluded from the digest');
  assert.ok(digest.length <= 22_500, 'digest respects its budget');

  // Notes persistence.
  const saved = await callJson(services, '/api/pdf.reader.notes', {
    path: fixturePath,
    markdown: '# My notes\n\n- structured pipeline notes',
  });
  assert.equal(saved.status, 200);
  assert.ok(saved.data.path.startsWith('paper-notes/'), saved.data.path);
  assert.ok(existsSync(join(root, saved.data.path)), 'note file exists');
  const loadedWithPath = await call(
    services,
    `/api/pdf.reader.notes?path=${encodeURIComponent(fixturePath)}`,
    { method: 'GET' },
  );
  const loadedNote = await loadedWithPath.json();
  assert.equal(loadedNote.markdown, '# My notes\n\n- structured pipeline notes');

  // Agent tools.
  const listTool = services.registeredTools.get('paper_list');
  const listResult = await listTool.execute({});
  assert.ok(listResult.text.includes('papers/'), 'paper_list lists the file');

  const readTool = services.registeredTools.get('paper_read');
  const readOverview = await readTool.execute({ path: fixturePath, maxChars: 6000 });
  assert.ok(readOverview.text.includes(paper.title), 'paper_read overview has title');
  assert.ok(readOverview.text.includes('Outline:'), 'paper_read overview has outline');
  const readSection = await readTool.execute({ path: fixturePath, section: 'method' });
  assert.ok(readSection.text.length > 500, 'paper_read section body');
  const readPages = await readTool.execute({ path: fixturePath, pages: '2-3' });
  assert.ok(readPages.text.includes('[Page 2]'), 'paper_read honours page range');
  await assert.rejects(async () => readTool.execute({ path: fixturePath, pages: 'x' }), /Invalid page range/);

  const searchTool = services.registeredTools.get('paper_search');
  const search = await searchTool.execute({ path: fixturePath, query: 'pipeline' });
  assert.ok(/match\(es\)/.test(search.text), 'paper_search finds matches');
  assert.ok(search.text.toLowerCase().includes('pipeline'));

  const noteTool = services.registeredTools.get('paper_save_note');
  const appended = await noteTool.execute({
    path: fixturePath,
    markdown: '\n## Extra\n- appended by tool',
    mode: 'append',
  });
  assert.ok(appended.text.includes('Saved'), 'note tool saves');
  const noteFile = await readFile(join(root, saved.data.path), 'utf8');
  assert.ok(noteFile.includes('appended by tool'), 'append kept existing note');

  // Upload: a real PDF lands in papers/, non-PDF content is rejected.
  const uploadBytes = new Uint8Array(await readFile(paperPath));
  const upload = await call(services, '/api/pdf.reader.upload', {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', 'x-paper-filename': encodeURIComponent('uploaded-paper.pdf') },
    body: uploadBytes,
  });
  const uploadResult = await upload.json();
  assert.equal(upload.status, 200, 'upload accepted');
  assert.equal(uploadResult.path, 'papers/uploaded-paper.pdf');
  assert.ok(existsSync(join(root, uploadResult.path)), 'uploaded file written');
  const fakeUpload = await call(services, '/api/pdf.reader.upload', {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', 'x-paper-filename': encodeURIComponent('evil.pdf') },
    body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
  });
  assert.equal(fakeUpload.status, 415, 'non-PDF upload rejected');
  const openedUpload = await callJson(services, '/api/pdf.reader.open', { path: uploadResult.path });
  assert.equal(openedUpload.status, 200, 'uploaded paper opens');

  // Invalid PDFs surface a clean error.
  await writeFile(join(root, 'broken.pdf'), 'not a pdf at all');
  const broken = await callJson(services, '/api/pdf.reader.open', { path: 'broken.pdf' });
  assert.ok(broken.status >= 400, 'broken pdf rejected');

  // Cleanup generated artifacts.
  await rm(join(root, 'paper-notes'), { recursive: true, force: true });
  await rm(join(root, 'broken.pdf'), { force: true });
  await rm(root, { recursive: true, force: true });

  console.log('route-check: ok');
  console.log(`  paper: ${paper.title} (${paper.pageCount} pages, ${paper.sections.length} sections)`);
  console.log(`  tools: ${[...services.registeredTools.keys()].join(', ')}`);
}

main().catch((error) => {
  console.error('route-check FAILED');
  console.error(error);
  process.exitCode = 1;
});
