# PDF paper reader — a DeepSeek Harness Web UI plugin

Read English computer-science papers inside the Harness Web UI: rendered PDF
pages with selectable text, one-click AI translation/explanation, structured
reading notes that are grounded in the paper, and agent tools that let the chat
model read, search and summarise papers for you.

The reader is a real page in the app (not an iframe), so it follows your theme,
locale and layout, and every AI call uses the model configured in your profile.

| | |
| --- | --- |
| Bundle package | `@local/pdf-paper-reader` (installed from a directory) |
| Host + Client | plain ESM / plain browser JS, no build step |
| PDF engine | [PDF.js](https://mozilla.github.io/pdf.js/) 3.11.174, vendored (Apache-2.0) |
| Tested against | `@deepseek-ai/dsh` 0.2.2-rc.1, Node 20+ |

## Features

- **Paper library** — scans the session workspace for PDFs, fills in titles and
  abstracts in the background, shows reading progress. Drag a PDF onto the page
  or use **Upload PDF** to add one.
- **PDF viewer** — rendered pages with a selectable text layer, zoom/fit, lazy
  page rendering, remembered reading position, arrow-key navigation.
- **Contents rail** — the paper's own outline (PDF bookmarks merged with
  heading detection, two-column aware, table-of-contents pages skipped).
- **In-paper search** — page-numbered snippets; click to jump.
- **Selection actions** — select a passage, then *Translate*, *Explain*,
  *Terms* or *Quote* (adds a cited blockquote to your notes). Output streams
  into the side pane in Chinese or English.
- **Reading notes** — one click writes structured Markdown notes (problem,
  method, contributions, experiments, limitations, glossary), then edit,
  preview, copy or save them to `paper-notes/` in the workspace. Existing notes
  load automatically; the agent can append to the same file.
- **Quick overview / page summary / Ask AI** — triage and paper-grounded Q&A;
  the prompts forbid inventing numbers and ask the model to say when something
  is not in the excerpt.
- **Agent tools** — `paper_list`, `paper_read`, `paper_search`,
  `paper_save_note` are available to the chat agent in every session after
  installation.

## Requirements

- A DeepSeek Harness Web UI profile with the `plugin_manager` plugin enabled
  (it is part of the standard `dsh-base` / `dsh-web-app` bundles).
- A default model configured in **Settings → Models** (the reader uses
  `ctx.llm` + the profile's default model selection).
- Node.js 20+ (only needed to run the plugin's own dev checks; the plugin
  itself runs inside the Host process).

## Install

### 1. Clone this repository

```bash
git clone https://github.com/liuchang0812/dsh-pdf-paper-reader.git
```

### 2. Install the bundle into your profile

In the Harness Web UI, ask the agent to install the bundle from the cloned
directory (this calls the `plugin_manager` tool):

> Install the plugin bundle at `/absolute/path/to/dsh-pdf-paper-reader`.

Or use `plugin_manager` yourself with
`action: install_bundle`, `target: "/absolute/path/to/dsh-pdf-paper-reader"`.
The install links the directory into your profile and inserts one Loader row;
it survives restarts and can be toggled from **Settings → Plugins**.

Refresh the Web UI once. A **PDF papers** icon appears in the sidebar panel
list; clicking it opens the reader in the central panel.

### Uninstall

Remove the `@local/pdf-paper-reader` bundle from **Settings → Plugins**, or use
`plugin_manager` with `action: remove_bundle`. Reading notes stay in your
workspace under `paper-notes/`.

## Usage

1. Open the **PDF papers** panel.
2. Add papers by dropping PDFs on the library or with **Upload PDF**; files are
   copied to `<workspace>/papers/`. Any PDF already under the workspace root is
   listed automatically.
3. Open a paper. Use the outline or the search box to navigate.
4. Select a sentence to translate/explain it, or press **Summarize this page**.
5. Press **Generate notes** in the notes tab, edit the Markdown, then **Save**.
6. Ask follow-up questions in the **Ask AI** tab, or discuss the paper with the
   agent — it can call the paper tools directly.

Keyboard: `←/→` previous/next page, `Shift+←/→` previous/next section,
`Esc` closes the selection toolbar.

## Agent tools

| Tool | What it does |
| --- | --- |
| `paper_list` | Lists workspace PDFs with detected title and page count. |
| `paper_read` | Reads a paper: overview (outline + abstract + important sections), a section (`section: "method"`), or a page range (`pages: "4-6"`). |
| `paper_search` | Finds a word/phrase with page-numbered snippets. |
| `paper_save_note` | Saves or appends Markdown reading notes under `paper-notes/`. |

Example prompts:

> List the papers in my workspace and give me a 5-line summary of the BERT paper.
> Search the Transformer paper for the BLEU scores and quote them with page numbers.
> Append a "limitations" section to the notes of `papers/resnet.pdf`.

## Configuration

The installed Loader row accepts two optional fields (edit the row's config in
**Settings → Plugins → the bundle**, or in the profile's `cordis.patch.yml`):

```yaml
- id: pdf-paper-reader
  name: '@local/pdf-paper-reader'
  config:
    rootDir: '/absolute/path/to/papers'   # default: the calling session's workspace
    notesDir: 'paper-notes'               # relative to rootDir
```

Notes: the default library follows each session's working directory, so
switching workspaces switches the library. Paths outside `rootDir` are
rejected, including via symlinks.

## Privacy

- Parsing, search, notes and uploads stay on the machine; nothing is uploaded
  by the plugin itself.
- AI actions send only the selected passage / a size-capped paper excerpt to
  the model configured in your profile, through the Harness `llm` service.
- Prompts treat paper text as untrusted data and instruct the model to ignore
  instructions found inside documents.

## Architecture

| Part | Files | Responsibility |
| --- | --- | --- |
| Host | `index.js` | Authenticated `/api/pdf.reader.*` routes (library, vendor PDF.js, file, open, upload, explain, summarize, ask, page brief, notes) and the four agent tools. |
| Host | `lib/store.js` | Workspace scanning, path containment, parse cache, search, notes persistence. |
| Host | `lib/pdf.js` | PDF.js ingestion: text, outline, title/authors/abstract, section model. |
| Host | `lib/text.js` | Text reconstruction: lines, document-wide column gutter detection, running-header removal, paragraphs, heading classification. |
| Host | `lib/prompts.js` | Section-aware digest and all model prompts. |
| Host | `lib/llm.js` | Default-model resolution, streaming, truncation reporting. |
| Client | `client.js` | Sidebar entry, main-panel page, PDF viewer + text layer, selection toolbar, notes/explain/ask panes, Markdown renderer. |
| Bundle | `package.json`, `cordis.patch.yml` | `dsh.bundle.patch` row and the `dsh.client` web module. |
| Vendored | `vendor/` | PDF.js browser + legacy builds and their Apache-2.0 license. |

The bundle registers:

- `main` slot key `pdf-paper-reader` — the reader page;
- `sidebar.panellist` id `pdf-paper-reader` — the sidebar icon;
- four Host tools listed above.

## Development

```bash
cd dev
npm install            # react, react-dom, jsdom (dev-only)
npm run check          # route + SSR + jsdom integration checks
```

- `node dev/route-check.mjs` — drives the real HTTP handlers and tools with a
  fake Cordis context and a fake model, against a **generated fixture PDF**
  (no fixtures checked in, no network). No dependencies needed.
- `node dev/ssr-check.mjs` — evaluates the real client bundle in a sandbox and
  server-renders the library page, reader page, assistant panes and Markdown
  renderer.
- `node dev/dom-check.mjs` — mounts the client half in jsdom with a stubbed
  PDF.js engine and an authenticated fetch stub; exercises library → open →
  page rendering → streamed notes → save → ask.

Manual smoke test: `node dev/route-check.mjs` prints the parsed fixture title,
page count and the registered tool names.

## Limitations

- **Scanned PDFs** have no extractable text; the plugin reports this instead of
  generating empty notes. Viewing still works.
- Text reconstruction is heuristic. Multi-column papers, figures, tables and
  equations are handled reasonably (verified on ICLR, CVPR, ACL/NAACL and
  NeurIPS-style PDFs), but figure labels can occasionally leak into adjacent
  paragraphs or the outline.
- The reader is verified with jsdom integration tests and live slot/tool
  inspection; this repository intentionally contains no screenshots or mock
  previews.

## License

MIT — see [LICENSE](LICENSE). The vendored PDF.js build is Apache-2.0; see
[`vendor/LICENSE`](vendor/LICENSE) and the notice in `README`/`vendor`.
