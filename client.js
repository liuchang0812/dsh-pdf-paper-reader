/**
 * PDF paper reader — Client half.
 *
 * Registers a sidebar panel entry and the reader page in the central `main`
 * slot. Renders a PDF viewer (pdf.js, selectable text layer), a section
 * outline, and an AI assistant pane. The browser never calls a model directly:
 * every AI action goes through the authenticated `/api/pdf.reader.*` routes.
 */
window.__ModuleLoader__.load({
  id: '@local/pdf-paper-reader',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'pdf-paper-reader';
    const PANEL_ID = 'pdf-paper-reader';
    const API_PREFIX = 'api/pdf.reader.';
    const STORAGE_LAST = 'ppr.lastPaper';
    const STORAGE_LANG = 'ppr.language';
    const STORAGE_ZOOM = 'ppr.zoom';

    // #region Locale

    const en = {
      'panel.label': 'PDF papers',
      'page.title': 'Paper reader',
      'page.subtitle': 'Read English CS papers with AI translation, explanations and structured notes.',
      'action.refresh': 'Refresh',
      'action.retry': 'Retry',
      'action.back': 'Library',
      'action.save': 'Save',
      'action.saving': 'Saving…',
      'action.saved': 'Saved',
      'action.edit': 'Edit',
      'action.preview': 'Preview',
      'action.copy': 'Copy',
      'action.copied': 'Copied',
      'action.close': 'Close',
      'action.cancel': 'Cancel',
      'action.generate': 'Generate notes',
      'action.regenerate': 'Regenerate',
      'action.outline': 'Outline',
      'action.hideOutline': 'Hide outline',
      'action.pageBrief': 'Summarize this page',
      'action.continue': 'Continue',
      'library.title': 'Paper library',
      'library.search': 'Filter papers…',
      'library.empty': 'No PDF papers found',
      'library.emptyHint': 'Put PDF files in {root} (the workspace). They appear here automatically.',
      'library.noMatch': 'No paper matches “{query}”.',
      'library.count': '{count} papers',
      'library.pages': '{count} pages',
      'library.root': 'Root',
      'library.readAt': 'p. {page}',
      'library.open': 'Open',
      'library.upload': 'Upload PDF',
      'library.drop': 'Drop PDFs here to add them to the library',
      'library.uploading': 'Uploading {name}…',
      'reader.loading': 'Opening paper…',
      'reader.loadError': 'Could not open this paper.',
      'reader.page': 'Page {page} / {total}',
      'reader.fit': 'Fit width',
      'reader.zoomIn': 'Zoom in',
      'reader.zoomOut': 'Zoom out',
      'reader.outline': 'Contents',
      'reader.noOutline': 'No section headings detected for this paper.',
      'reader.selectionCount': '{count} characters selected',
      'tabs.notes': 'Reading notes',
      'tabs.explain': 'Explain',
      'tabs.ask': 'Ask AI',
      'notes.title': 'Reading notes',
      'notes.hint': 'A structured summary generated from the paper, grounded in its text. Edit it, then save it into the workspace.',
      'notes.empty': 'Generate structured notes for this paper: problem, method, contributions, experiments, limitations and glossary.',
      'notes.placeholder': 'Reading notes (Markdown)…',
      'notes.generating': 'Writing notes…',
      'notes.template': 'Insert template',
      'notes.brief': 'Quick overview',
      'notes.savedTo': 'Saved to {path}',
      'notes.unsaved': 'Unsaved changes',
      'notes.loaded': 'Loaded saved notes from {path}',
      'notes.confirmRegenerate': 'Regenerating replaces the current notes. Continue?',
      'notes.confirmLeave': 'You have unsaved notes. Leave anyway?',
      'notes.confirmClear': 'Clear the notes? This cannot be undone.',
      'explain.title': 'Explanation',
      'explain.empty': 'Select text in the PDF to translate or explain it. You can also summarize the current page.',
      'explain.translate': 'Translate',
      'explain.explain': 'Explain',
      'explain.terms': 'Key terms',
      'explain.selection': 'Selection · page {page}',
      'explain.pageBrief': 'Page {page} summary',
      'explain.working': 'Thinking…',
      'explain.tooLong': 'The selection was truncated to 8000 characters.',
      'ask.title': 'Ask about this paper',
      'ask.placeholder': 'Ask anything about the paper…',
      'ask.send': 'Send',
      'ask.empty': 'Ask about the method, a formula, an experiment result, or how this paper relates to your work. Answers cite page numbers when possible.',
      'ask.thinking': 'Reading the paper…',
      'selection.translate': 'Translate',
      'selection.explain': 'Explain',
      'selection.terms': 'Terms',
      'selection.quote': 'Quote',
      'status.working': 'Working…',
      'status.model': 'Model: {model}',
      'status.truncated': 'Output stopped at the token limit.',
      'error.generic': 'Something went wrong.',
      'error.notes': 'Could not write the notes.',
      'error.explain': 'Could not explain the selection.',
      'error.ask': 'Could not answer the question.',
      'error.save': 'Could not save the notes.',
      'error.load': 'Could not load the library.',
      'error.upload': 'Could not upload that PDF.',
      'error.uploadLarge': 'That PDF is larger than the 80 MB limit.',
      'error.pdf': 'The PDF engine could not be loaded.',
      'error.noText': 'This PDF has almost no extractable text (it may be a scan).',
      'lang.toggle': '中文',
      'shortcuts': 'Keys: ←/→ page, Shift+←/→ nearest section',
      'search.placeholder': 'Search in paper…',
      'search.empty': 'No matches',
      'search.count': '{count} matches',
      'search.page': 'p. {page}',
      'empty.pick': 'Pick a paper from the library to start reading.',
    };

    const zh = {
      'panel.label': 'PDF 论文',
      'page.title': '论文阅读',
      'page.subtitle': '阅读英文计算机论文：AI 翻译、逐段讲解与结构化精读笔记。',
      'action.refresh': '刷新',
      'action.retry': '重试',
      'action.back': '论文库',
      'action.save': '保存',
      'action.saving': '保存中…',
      'action.saved': '已保存',
      'action.edit': '编辑',
      'action.preview': '预览',
      'action.copy': '复制',
      'action.copied': '已复制',
      'action.close': '关闭',
      'action.cancel': '取消',
      'action.generate': '生成精读笔记',
      'action.regenerate': '重新生成',
      'action.outline': '目录',
      'action.hideOutline': '隐藏目录',
      'action.pageBrief': '总结本页',
      'action.continue': '继续',
      'library.title': '论文库',
      'library.search': '筛选论文…',
      'library.empty': '没有找到 PDF 论文',
      'library.emptyHint': '把 PDF 放进工作区 {root}，它们会自动出现在这里。',
      'library.noMatch': '没有匹配「{query}」的论文。',
      'library.count': '共 {count} 篇',
      'library.pages': '{count} 页',
      'library.root': '根目录',
      'library.readAt': '读到第 {page} 页',
      'library.open': '打开',
      'library.upload': '上传 PDF',
      'library.drop': '把 PDF 拖到这里加入论文库',
      'library.uploading': '正在上传 {name}…',
      'reader.loading': '正在打开论文…',
      'reader.loadError': '无法打开这篇论文。',
      'reader.page': '第 {page} / {total} 页',
      'reader.fit': '适应宽度',
      'reader.zoomIn': '放大',
      'reader.zoomOut': '缩小',
      'reader.outline': '目录',
      'reader.noOutline': '未识别到这篇文章的章节标题。',
      'reader.selectionCount': '已选中 {count} 个字符',
      'tabs.notes': '精读笔记',
      'tabs.explain': '讲解',
      'tabs.ask': '问 AI',
      'notes.title': '精读笔记',
      'notes.hint': '基于论文原文生成的结构化总结。可以直接编辑，并保存到工作区。',
      'notes.empty': '生成这篇论文的精读笔记：研究问题、方法、贡献、实验、局限与术语表。',
      'notes.placeholder': '用 Markdown 写你的精读笔记…',
      'notes.generating': '正在写笔记…',
      'notes.template': '插入笔记模板',
      'notes.brief': '快速概览',
      'notes.savedTo': '已保存到 {path}',
      'notes.unsaved': '有未保存的修改',
      'notes.loaded': '已加载笔记 {path}',
      'notes.confirmRegenerate': '重新生成会覆盖当前笔记，继续吗？',
      'notes.confirmLeave': '笔记还有未保存的修改，确定离开吗？',
      'notes.confirmClear': '确定清空笔记吗？此操作不可撤销。',
      'explain.title': '讲解',
      'explain.empty': '在 PDF 中选中文字即可翻译或讲解，也可以直接总结当前页。',
      'explain.translate': '翻译',
      'explain.explain': '讲解',
      'explain.terms': '术语',
      'explain.selection': '选中内容 · 第 {page} 页',
      'explain.pageBrief': '第 {page} 页总结',
      'explain.working': '思考中…',
      'explain.tooLong': '选中内容过长，已截断到 8000 字符。',
      'ask.title': '关于这篇论文',
      'ask.placeholder': '问任何关于这篇论文的问题…',
      'ask.send': '发送',
      'ask.empty': '可以问方法细节、公式含义、实验结果，或这篇论文对你的工作有什么启发。回答会尽量标注页码。',
      'ask.thinking': '正在阅读论文…',
      'selection.translate': '翻译',
      'selection.explain': '讲解',
      'selection.terms': '术语',
      'selection.quote': '摘录',
      'status.working': '处理中…',
      'status.model': '模型：{model}',
      'status.truncated': '输出达到长度上限。',
      'error.generic': '出了点问题。',
      'error.notes': '笔记生成失败。',
      'error.explain': '讲解失败。',
      'error.ask': '回答失败。',
      'error.save': '笔记保存失败。',
      'error.load': '论文库加载失败。',
      'error.upload': '上传失败。',
      'error.uploadLarge': 'PDF 超过 80 MB 上限。',
      'error.pdf': 'PDF 引擎加载失败。',
      'error.noText': '这个 PDF 几乎没有可提取的文本（可能是扫描件）。',
      'lang.toggle': 'EN',
      'shortcuts': '快捷键：←/→ 翻页，Shift+←/→ 跳到上/下一节',
      'search.placeholder': '在论文中搜索…',
      'search.empty': '没有匹配',
      'search.count': '{count} 处匹配',
      'search.page': '第 {page} 页',
      'empty.pick': '从左侧论文库选择一篇论文开始阅读。',
    };

    // #endregion

    // #region Helpers

    function apiUrl(name, params) {
      const url = new URL(API_PREFIX + name, document.baseURI);
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
      return url.toString();
    }

    async function readJson(response) {
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const message = data !== null && typeof data.error === 'string' ? data.error : `HTTP ${response.status}`;
        throw new Error(message);
      }
      return data;
    }

    function requestJson(name, { method = 'POST', body, params, signal } = {}) {
      const init = { method, credentials: 'same-origin', signal };
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      return fetch(apiUrl(name, params), init).then(readJson);
    }

    /**
     * Consume one NDJSON stream of assistant frames.
     * @param {string} name route name
     * @param {object} body request body
     * @param {{signal?: AbortSignal, onDelta: (text: string) => void, onMeta?: (frame: object) => void}} options handlers
     * @returns {Promise<{text: string, model: string, truncated: boolean}>} full text
     */
    async function streamAssistant(name, body, options) {
      const response = await fetch(apiUrl(name), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: options.signal,
      });
      if (!response.ok || response.body === null) {
        let message = `HTTP ${response.status}`;
        try {
          const data = await response.json();
          if (data !== null && typeof data.error === 'string') message = data.error;
        } catch {
          /* keep the status text */
        }
        throw new Error(message);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let text = '';
      let model = '';
      let truncated = false;
      // Batch token deltas into one UI update per animation frame; a 4000-token
      // note otherwise re-parses the whole Markdown hundreds of times.
      let pending = '';
      let frame = 0;
      const flush = () => {
        if (pending.length === 0) return;
        const chunk = pending;
        pending = '';
        options.onDelta(chunk);
      };
      const schedule = () => {
        if (frame !== 0) return;
        if (typeof window.requestAnimationFrame === 'function') {
          frame = window.requestAnimationFrame(() => {
            frame = 0;
            flush();
          });
        } else {
          frame = window.setTimeout(() => {
            frame = 0;
            flush();
          }, 16);
        }
      };
      const handleLine = (line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;
        let frame;
        try {
          frame = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (frame !== null && typeof frame === 'object') {
          if (typeof frame.error === 'string') throw new Error(frame.error);
          if (typeof frame.delta === 'string') {
            text += frame.delta;
            pending += frame.delta;
            schedule();
          }
          if (typeof frame.model === 'string' && frame.model.length > 0) {
            model = frame.model;
            if (options.onMeta !== undefined) options.onMeta(frame);
          }
          if (frame.truncated === true) truncated = true;
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          handleLine(line);
          index = buffer.indexOf('\n');
        }
      }
      if (buffer.trim().length > 0) handleLine(buffer);
      if (frame !== 0) {
        if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame);
        window.clearTimeout(frame);
        frame = 0;
      }
      flush();
      return { text, model, truncated };
    }

    /** @type {Promise<any> | null} */
    let pdfjsPromise = null;

    function loadPdfjs() {
      if (window.pdfjsLib !== undefined) return Promise.resolve(window.pdfjsLib);
      if (pdfjsPromise !== null) return pdfjsPromise;
      pdfjsPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = apiUrl('vendor', { file: 'pdf' });
        script.async = true;
        script.onload = () => {
          const lib = window.pdfjsLib;
          if (lib === undefined) {
            reject(new Error('The PDF engine did not register.'));
            return;
          }
          lib.GlobalWorkerOptions.workerSrc = apiUrl('vendor', { file: 'worker' });
          resolve(lib);
        };
        script.onerror = () => reject(new Error('The PDF engine script failed to load.'));
        document.head.appendChild(script);
      });
      return pdfjsPromise;
    }

    function detectLanguage(ctx) {
      try {
        const stored = window.localStorage.getItem(STORAGE_LANG);
        if (stored === 'zh' || stored === 'en') return stored;
      } catch {
        /* storage may be unavailable */
      }
      try {
        const locale = ctx.locale.getLocale();
        const id = typeof locale === 'string' ? locale : locale?.active ?? locale?.id ?? locale?.locale ?? '';
        if (String(id).toLowerCase().startsWith('zh')) return 'zh';
      } catch {
        /* fall through */
      }
      return String(navigator.language ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes)) return '';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    function readStored(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    }

    function writeStored(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* ignore quota or privacy errors */
      }
    }

    // #endregion

    // #region Icons

    function Icon({ path, size = 16, strokeWidth = 1.8 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: 'false',
        },
        path.map((d, index) => h('path', { key: index, d })),
      );
    }

    const ICONS = {
      refresh: ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v6h-6'],
      back: ['M19 12H5', 'M12 19l-7-7 7-7'],
      book: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'],
      chevronLeft: ['M15 18l-6-6 6-6'],
      chevronRight: ['M9 18l6-6-6-6'],
      chevronDown: ['M6 9l6 6 6-6'],
      plus: ['M12 5v14', 'M5 12h14'],
      minus: ['M5 12h14'],
      sparkles: ['M12 3l1.8 4.6L18 9.4l-4.2 1.8L12 16l-1.8-4.8L6 9.4l4.2-1.8z', 'M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z'],
      send: ['M22 2L11 13', 'M22 2l-7 20-4-9-9-4z'],
      save: ['M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z', 'M17 21v-8H7v8', 'M7 3v5h8'],
      edit: ['M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7', 'M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z'],
      eye: ['M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
      copy: ['M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
      list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
      file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M9 13h6', 'M9 17h4'],
      check: ['M20 6L9 17l-5-5'],
      x: ['M18 6L6 18', 'M6 6l12 12'],
      alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
      sidebar: ['M4 4h16v16H4z', 'M9 4v16'],
      languages: ['M5 8h10', 'M9 4v4', 'M7 8c0 5 4 8 8 9', 'M13 20l4-9 4 9', 'M15 17h4'],
      highlight: ['M9 11l-6 6v3h3l6-6', 'M14 6l4 4', 'M13 3l8 8-4 4-8-8z'],
    };

    function StatusDot({ state }) {
      if (state !== 'loading') return null;
      return h('span', { className: 'ppr-spinner', 'aria-hidden': true });
    }

    // #endregion

    // #region Markdown

    function renderInline(text, keyPrefix) {
      const nodes = [];
      const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|\[[^\]]+\]\([^)\s]+\))/g;
      let lastIndex = 0;
      let match;
      let index = 0;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
        const token = match[0];
        const key = `${keyPrefix}-${index++}`;
        if (token.startsWith('**') || token.startsWith('__')) {
          nodes.push(h('strong', { key }, token.slice(2, -2)));
        } else if (token.startsWith('`')) {
          nodes.push(h('code', { key, className: 'ppr-inline-code' }, token.slice(1, -1)));
        } else if (token.startsWith('*')) {
          nodes.push(h('em', { key }, token.slice(1, -1)));
        } else {
          const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
          if (link !== null && /^https?:\/\//i.test(link[2])) {
            nodes.push(
              h('a', { key, href: link[2], target: '_blank', rel: 'noreferrer noopener', className: 'ppr-link' }, link[1]),
            );
          } else {
            nodes.push(token);
          }
        }
        lastIndex = pattern.lastIndex;
      }
      if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
      return nodes;
    }

    /**
     * Lightweight Markdown renderer for model output: headings, lists, tables,
     * quotes, fenced code and inline emphasis. Unknown blocks render verbatim.
     * @param {{text: string}} props component props
     * @returns {any} rendered blocks
     */
    function Markdown({ text }) {
      const blocks = useMemo(() => parseMarkdown(text ?? ''), [text]);
      return h('div', { className: 'ppr-md' }, blocks);
    }

    function parseMarkdown(source) {
      const lines = source.replace(/\r\n/g, '\n').split('\n');
      const blocks = [];
      let index = 0;
      let key = 0;
      while (index < lines.length) {
        const line = lines[index];
        if (line.trim().length === 0) {
          index += 1;
          continue;
        }
        const fence = /^```(\w*)\s*$/.exec(line);
        if (fence !== null) {
          const body = [];
          index += 1;
          while (index < lines.length && !/^```\s*$/.test(lines[index])) {
            body.push(lines[index]);
            index += 1;
          }
          index += 1;
          blocks.push(h('pre', { key: key++, className: 'ppr-code' }, h('code', null, body.join('\n'))));
          continue;
        }
        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading !== null) {
          const level = heading[1].length;
          const tag = `h${Math.min(4, level + 1)}`;
          blocks.push(h(tag, { key: key++, className: `ppr-h ppr-h${level}` }, renderInline(heading[2], `h${key}`)));
          index += 1;
          continue;
        }
        if (/^>\s?/.test(line)) {
          const body = [];
          while (index < lines.length && /^>\s?/.test(lines[index])) {
            body.push(lines[index].replace(/^>\s?/, ''));
            index += 1;
          }
          blocks.push(
            h('blockquote', { key: key++, className: 'ppr-quote' }, renderInline(body.join(' '), `q${key}`)),
          );
          continue;
        }
        if (/^\s*\|.*\|\s*$/.test(line) && index + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1])) {
          const rows = [];
          const header = splitTableRow(line);
          index += 2;
          while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
            rows.push(splitTableRow(lines[index]));
            index += 1;
          }
          blocks.push(
            h(
              'div',
              { key: key++, className: 'ppr-table-wrap' },
              h(
                'table',
                { className: 'ppr-table' },
                h('thead', null, h('tr', null, header.map((cell, cellIndex) => h('th', { key: cellIndex }, renderInline(cell, `th${cellIndex}`))))),
                h(
                  'tbody',
                  null,
                  rows.map((row, rowIndex) =>
                    h(
                      'tr',
                      { key: rowIndex },
                      row.map((cell, cellIndex) => h('td', { key: cellIndex }, renderInline(cell, `td${rowIndex}-${cellIndex}`))),
                    ),
                  ),
                ),
              ),
            ),
          );
          continue;
        }
        const listMatch = /^(\s*)([-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
        if (listMatch !== null) {
          const ordered = listMatch[3] !== undefined;
          const items = [];
          while (index < lines.length) {
            const itemMatch = /^(\s*)([-*+]|(\d+)[.)])\s+(.*)$/.exec(lines[index]);
            if (itemMatch === null) break;
            items.push(itemMatch[4]);
            index += 1;
            // Continuation lines belong to the same item until a blank line.
            while (index < lines.length && lines[index].trim().length > 0 && /^\s{2,}\S/.test(lines[index]) && /^(\s*)([-*+]|(\d+)[.)])\s+/.exec(lines[index]) === null) {
              items[items.length - 1] += ` ${lines[index].trim()}`;
              index += 1;
            }
          }
          blocks.push(
            h(
              ordered ? 'ol' : 'ul',
              { key: key++, className: 'ppr-list' },
              items.map((item, itemIndex) => h('li', { key: itemIndex }, renderInline(item, `li${key}-${itemIndex}`))),
            ),
          );
          continue;
        }
        if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
          blocks.push(h('hr', { key: key++, className: 'ppr-hr' }));
          index += 1;
          continue;
        }
        const paragraph = [line];
        index += 1;
        while (index < lines.length && lines[index].trim().length > 0) {
          const next = lines[index];
          if (/^(#{1,4})\s+/.test(next) || /^```/.test(next) || /^>\s?/.test(next) || /^\s*\|/.test(next) || /^(\s*)([-*+]|(\d+)[.)])\s+/.test(next)) break;
          paragraph.push(next);
          index += 1;
        }
        blocks.push(h('p', { key: key++, className: 'ppr-p' }, renderInline(paragraph.join(' '), `p${key}`)));
      }
      return blocks;
    }

    function splitTableRow(line) {
      return line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim());
    }

    // #endregion

    // #region Styles

    const STYLE = `
.ppr-root { display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; --ppr-on-brand: var(--dsw-alias-label-primary-inverted, #ffffff); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size:13px; line-height:1.55; }
.ppr-header { display:flex; align-items:center; gap:12px; padding:10px 16px; border-bottom:1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); flex:none; min-height:48px; }
.ppr-brand { display:flex; align-items:center; gap:8px; font-weight:600; font-size:14px; flex:none; letter-spacing:-0.01em; }
.ppr-brand-mark { width:24px; height:24px; border-radius:6px; background: linear-gradient(135deg, #4f8dfd, #6d5efc); display:flex; align-items:center; justify-content:center; color:#ffffff; flex:none; }
.ppr-header-paper { min-width:0; display:flex; flex-direction:column; gap:1px; }
.ppr-header-title { font-size:13px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ppr-header-sub { font-size:11.5px; color: var(--dsw-alias-label-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ppr-spacer { flex:1; }
.ppr-toolbar { display:flex; align-items:center; gap:6px; flex:none; }
.ppr-btn { appearance:none; display:inline-flex; align-items:center; gap:6px; border:1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font:inherit; font-size:12px; line-height:1.35; padding:5px 10px; border-radius:7px; cursor:pointer; white-space:nowrap; }
.ppr-btn:hover { border-color: var(--dsw-alias-border-l2); }
.ppr-btn:active { transform: translateY(0.5px); }
.ppr-btn[data-primary="true"] { background: var(--dsw-alias-brand-primary, #2f6fed); border-color: transparent; color: var(--ppr-on-brand); }
.ppr-btn[data-primary="true"]:hover { filter:brightness(1.06); }
.ppr-btn:disabled { opacity:.45; cursor:default; transform:none; }
.ppr-btn[data-quiet="true"] { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); }
.ppr-btn[data-quiet="true"]:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.ppr-icon-btn { appearance:none; display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; border:1px solid var(--dsw-alias-border-l1); border-radius:7px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); cursor:pointer; flex:none; }
.ppr-icon-btn:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.ppr-icon-btn:disabled { opacity:.45; cursor:default; }
.ppr-chip { appearance:none; display:inline-flex; align-items:center; gap:5px; border:1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font:inherit; font-size:11.5px; padding:3px 9px; border-radius:999px; cursor:pointer; white-space:nowrap; }
.ppr-chip:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.ppr-chip[data-active="true"] { background: var(--dsw-alias-brand-primary, #2f6fed); border-color: transparent; color: var(--ppr-on-brand); }
.ppr-lib { flex:1; min-height:0; overflow:auto; padding:22px 26px 40px; }
.ppr-lib-head { display:flex; align-items:baseline; gap:10px; margin-bottom:4px; }
.ppr-lib-title { font-size:17px; font-weight:600; letter-spacing:-0.01em; }
.ppr-lib-count { font-size:12px; color: var(--dsw-alias-label-secondary); }
.ppr-lib-sub { font-size:12px; color: var(--dsw-alias-label-secondary); margin-bottom:14px; }
.ppr-lib-sub code { font-size:11.5px; background: var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); border-radius:5px; padding:1px 5px; }
.ppr-lib-tools { display:flex; align-items:center; gap:8px; margin-bottom:14px; flex-wrap:wrap; }
.ppr-input { appearance:none; font:inherit; font-size:12.5px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:6px 10px; min-width:0; }
.ppr-input:focus { outline:2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent); outline-offset:0; border-color: var(--dsw-alias-brand-primary); }
.ppr-lib[data-dragging="true"] { outline:2px dashed var(--dsw-alias-brand-primary); outline-offset:-10px; border-radius:12px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 5%, transparent); }
.ppr-drop-hint { padding:10px 12px; margin-bottom:12px; border:1px dashed var(--dsw-alias-border-l2); border-radius:9px; font-size:12.5px; color: var(--dsw-alias-brand-primary); text-align:center; }
.ppr-lib-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap:10px; }
.ppr-card { display:flex; flex-direction:column; gap:6px; text-align:left; border:1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius:11px; padding:12px 14px; cursor:pointer; font:inherit; color:inherit; min-height:96px; }
.ppr-card:hover { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.ppr-card-top { display:flex; align-items:flex-start; gap:9px; }
.ppr-card-icon { width:28px; height:28px; border-radius:7px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); color: var(--dsw-alias-brand-primary); display:flex; align-items:center; justify-content:center; flex:none; }
.ppr-card-title { font-size:13px; font-weight:600; line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; word-break:break-word; }
.ppr-card-meta { display:flex; flex-wrap:wrap; gap:5px 10px; font-size:11.5px; color: var(--dsw-alias-label-secondary); }
.ppr-card-path { font-size:11px; color: var(--dsw-alias-label-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.85; }
.ppr-card-abstract { font-size:11.5px; line-height:1.5; color: var(--dsw-alias-label-secondary); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.ppr-card-progress { color: var(--dsw-alias-brand-primary); font-variant-numeric: tabular-nums; }
.ppr-search { position:relative; display:flex; align-items:center; }
.ppr-search input { width:150px; padding:4px 9px; font-size:12px; }
.ppr-search input:focus { width:200px; }
.ppr-search-results { position:absolute; top:calc(100% + 6px); right:0; width:330px; max-height:320px; overflow:auto; z-index:40; background: var(--dsw-alias-bg-overlay); border:1px solid var(--dsw-alias-border-l2); border-radius:10px; box-shadow: 0 12px 32px rgba(0,0,0,.24); padding:4px; }
.ppr-search-head { font-size:11px; color: var(--dsw-alias-label-secondary); padding:5px 8px 3px; }
.ppr-search-row { appearance:none; width:100%; display:flex; gap:8px; align-items:flex-start; text-align:left; border:0; background:transparent; color:inherit; font:inherit; padding:6px 8px; border-radius:7px; cursor:pointer; }
.ppr-search-row:hover { background: var(--dsw-alias-bg-layer-2); }
.ppr-search-page { flex:none; font-size:11px; color: var(--dsw-alias-brand-primary); font-variant-numeric: tabular-nums; padding-top:1px; min-width:40px; }
.ppr-search-snippet { font-size:11.5px; line-height:1.5; color: var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.ppr-search-snippet mark { background: transparent; color: var(--dsw-alias-brand-primary); font-weight:600; text-decoration: underline; text-underline-offset:2px; }
.ppr-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; gap:8px; padding:60px 24px; color: var(--dsw-alias-label-secondary); }
.ppr-empty-title { font-size:14px; font-weight:600; color: var(--dsw-alias-label-primary); }
.ppr-empty-hint { max-width:460px; font-size:12.5px; line-height:1.7; }
.ppr-reader { flex:1; min-height:0; display:flex; flex-direction:column; }
.ppr-workspace { flex:1; min-height:0; display:flex; position:relative; }
.ppr-outline[data-overlay="true"] { position:absolute; top:0; left:0; bottom:0; z-index:35; box-shadow: 0 12px 40px rgba(0,0,0,.28); }
.ppr-icon-btn[data-active="true"] { background: var(--dsw-alias-brand-primary); border-color: transparent; color: var(--ppr-on-brand); }
.ppr-outline { width:236px; flex:none; border-right:1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); display:flex; flex-direction:column; min-height:0; }
.ppr-outline-head { padding:10px 14px; font-size:11.5px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color: var(--dsw-alias-label-secondary); border-bottom:1px solid var(--dsw-alias-border-l1); flex:none; }
.ppr-outline-list { flex:1; overflow:auto; padding:6px; }
.ppr-outline-item { appearance:none; width:100%; display:flex; align-items:baseline; gap:8px; border:0; background:transparent; color: var(--dsw-alias-label-secondary); font:inherit; font-size:12px; text-align:left; padding:5px 8px; border-radius:6px; cursor:pointer; line-height:1.45; }
.ppr-outline-item:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.ppr-outline-item[data-active="true"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); color: var(--dsw-alias-label-primary); }
.ppr-outline-item[data-level="2"] { padding-left:20px; font-size:11.5px; }
.ppr-outline-item[data-level="3"] { padding-left:30px; font-size:11.5px; }
.ppr-outline-page { margin-left:auto; font-size:10.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; flex:none; }
.ppr-main { flex:1; min-width:0; min-height:0; display:flex; flex-direction:column; }
.ppr-viewer { flex:1; min-width:0; min-height:0; display:flex; flex-direction:column; background: var(--dsw-alias-bg-base); }
.ppr-viewer-bar { display:flex; align-items:center; gap:8px; padding:7px 14px; border-bottom:1px solid var(--dsw-alias-border-l1); flex:none; background: var(--dsw-alias-bg-layer-1); flex-wrap:wrap; row-gap:6px; }
.ppr-page-indicator { font-size:12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; padding:0 4px; }
.ppr-pages { flex:1; min-height:0; overflow:auto; padding:18px 18px 60px; display:flex; flex-direction:column; align-items:center; gap:16px; scroll-behavior:smooth; }
.ppr-page { position:relative; background:#fff; box-shadow: 0 1px 3px rgba(0,0,0,.16), 0 8px 24px rgba(0,0,0,.10); border-radius:2px; flex:none; overflow:hidden; }
.ppr-page[data-placeholder="true"] { display:flex; align-items:center; justify-content:center; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size:11px; box-shadow:none; border:1px dashed var(--dsw-alias-border-l1); }
.ppr-page canvas { display:block; }
.ppr-page-error { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; gap:6px; font-size:12px; color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-1); z-index:3; }
.ppr-page[data-page-loading="true"]::after { content:''; position:absolute; inset:0; background: linear-gradient(90deg, transparent, rgba(15, 17, 21, 0.06), transparent); animation: ppr-shimmer 1.2s infinite; }
@keyframes ppr-shimmer { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
.ppr-textLayer { position:absolute; text-align:initial; inset:0; overflow:hidden; opacity:0.22; line-height:1; -webkit-text-size-adjust:none; text-size-adjust:none; transform-origin:0 0; z-index:2; }
.ppr-textLayer :is(span, br) { color: transparent; position:absolute; white-space:pre; cursor:text; transform-origin:0% 0%; }
.ppr-textLayer span.markedContent { top:0; height:0; }
.ppr-textLayer ::selection { background: rgba(65, 118, 230, 0.38); }
.ppr-textLayer .endOfContent { display:block; position:absolute; inset:100% 0 0; z-index:-1; cursor:default; user-select:none; }
.ppr-selection-pop { position:fixed; z-index:60; display:flex; align-items:center; gap:2px; padding:3px; border-radius:9px; background: var(--dsw-alias-bg-overlay); border:1px solid var(--dsw-alias-border-l2); box-shadow: 0 8px 28px rgba(0,0,0,.22); }
.ppr-selection-pop .ppr-btn { border-color: transparent; background: transparent; padding:4px 9px; }
.ppr-selection-pop .ppr-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.ppr-assistant { width:390px; flex:none; border-left:1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); display:flex; flex-direction:column; min-height:0; }
.ppr-assistant-head { display:flex; align-items:center; gap:6px; padding:8px 12px; border-bottom:1px solid var(--dsw-alias-border-l1); flex:none; }
.ppr-tabs { display:flex; align-items:center; gap:2px; padding:2px; border-radius:8px; background: var(--dsw-alias-bg-layer-2); flex:1; }
.ppr-tab { appearance:none; border:0; background:transparent; color: var(--dsw-alias-label-secondary); font:inherit; font-size:12px; padding:4px 9px; border-radius:6px; cursor:pointer; flex:1; }
.ppr-tab:hover { color: var(--dsw-alias-label-primary); }
.ppr-tab[data-active="true"] { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 1px 2px rgba(0,0,0,.10); }
.ppr-pane { flex:1; min-height:0; display:flex; flex-direction:column; }
.ppr-pane-scroll { flex:1; min-height:0; overflow:auto; padding:12px 14px 20px; }
.ppr-pane-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:8px 12px; border-bottom:1px solid var(--dsw-alias-border-l1); flex:none; }
.ppr-hint { font-size:11.5px; color: var(--dsw-alias-label-secondary); line-height:1.65; }
.ppr-error { display:flex; align-items:flex-start; gap:7px; color: var(--dsw-alias-state-error-primary); font-size:12px; padding:8px 10px; border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent); border-radius:8px; background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent); line-height:1.5; }
.ppr-warn { color: var(--dsw-alias-state-warn-primary); font-size:11.5px; }
.ppr-status { display:flex; align-items:center; gap:7px; font-size:12px; color: var(--dsw-alias-label-secondary); padding:6px 0; }
.ppr-spinner { width:12px; height:12px; border-radius:50%; border:2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary); animation: ppr-spin .8s linear infinite; flex:none; display:inline-block; }
@keyframes ppr-spin { to { transform: rotate(360deg); } }
.ppr-selection-quote { border-left:2px solid var(--dsw-alias-brand-primary); padding:2px 0 2px 10px; margin:0 0 10px; font-size:12px; color: var(--dsw-alias-label-secondary); font-style:italic; overflow-wrap:anywhere; max-height:88px; overflow:hidden; }
.ppr-md { font-size:12.8px; line-height:1.68; overflow-wrap:anywhere; }
.ppr-md .ppr-h { font-weight:600; line-height:1.4; margin:14px 0 7px; }
.ppr-md .ppr-h1 { font-size:16px; margin-top:4px; }
.ppr-md .ppr-h2 { font-size:14px; }
.ppr-md .ppr-h3 { font-size:13px; }
.ppr-md .ppr-h4 { font-size:12.5px; color: var(--dsw-alias-label-secondary); }
.ppr-md .ppr-p { margin:0 0 9px; }
.ppr-md .ppr-list { margin:0 0 9px; padding-left:20px; }
.ppr-md .ppr-list li { margin:2px 0; }
.ppr-md .ppr-quote { margin:0 0 10px; padding:4px 10px; border-left:2px solid var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-radius:0 6px 6px 0; }
.ppr-md .ppr-code { margin:0 0 10px; padding:9px 11px; border-radius:8px; background: var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); overflow:auto; font-size:11.5px; line-height:1.5; }
.ppr-md code, .ppr-md .ppr-inline-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11.8px; background: var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); border-radius:4px; padding:0.5px 4px; }
.ppr-md .ppr-code code { background:transparent; border:0; padding:0; }
.ppr-md .ppr-table-wrap { overflow-x:auto; margin:0 0 10px; }
.ppr-md .ppr-table { border-collapse:collapse; font-size:11.8px; width:100%; }
.ppr-md .ppr-table th, .ppr-md .ppr-table td { border:1px solid var(--dsw-alias-border-l1); padding:4px 8px; text-align:left; vertical-align:top; }
.ppr-md .ppr-table th { background: var(--dsw-alias-bg-layer-2); font-weight:600; }
.ppr-md .ppr-hr { border:0; border-top:1px solid var(--dsw-alias-border-l1); margin:12px 0; }
.ppr-md .ppr-link { color: var(--dsw-alias-brand-primary); text-decoration:none; }
.ppr-md .ppr-link:hover { text-decoration:underline; }
.ppr-note-toolbar { display:flex; align-items:center; gap:6px; padding:7px 12px; border-bottom:1px solid var(--dsw-alias-border-l1); flex:none; flex-wrap:wrap; }
.ppr-note-status { font-size:11px; color: var(--dsw-alias-label-secondary); margin-left:auto; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:180px; }
.ppr-textarea { width:100%; min-height:320px; resize:vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; line-height:1.6; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:10px 12px; box-sizing:border-box; }
.ppr-textarea:focus { outline:2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent); border-color: var(--dsw-alias-brand-primary); }
.ppr-chat { display:flex; flex-direction:column; gap:14px; }
.ppr-msg { display:flex; flex-direction:column; gap:4px; }
.ppr-msg-role { font-size:10.5px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; color: var(--dsw-alias-label-secondary); }
.ppr-msg[data-role="user"] .ppr-bubble { background: var(--dsw-alias-bg-layer-2); border-radius:10px 10px 10px 3px; padding:7px 11px; font-size:12.5px; white-space:pre-wrap; }
.ppr-msg[data-role="assistant"] .ppr-bubble { padding:0; }
.ppr-chat-input { flex:none; border-top:1px solid var(--dsw-alias-border-l1); padding:9px 12px; display:flex; gap:7px; align-items:flex-end; }
.ppr-chat-input textarea { flex:1; resize:none; min-height:36px; max-height:120px; font:inherit; font-size:12.5px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:7px 10px; line-height:1.45; }
.ppr-chat-input textarea:focus { outline:2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent); border-color: var(--dsw-alias-brand-primary); }
.ppr-suggest { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
.ppr-suggest .ppr-chip { font-size:11px; }
.ppr-saved { display:inline-flex; align-items:center; gap:4px; font-size:11px; color: var(--dsw-alias-state-success-primary); }
.ppr-muted { color: var(--dsw-alias-label-secondary); }
.ppr-mono-sm { font-variant-numeric: tabular-nums; }
.ppr-root[data-narrow="true"] .ppr-assistant { width:100%; border-left:0; border-top:1px solid var(--dsw-alias-border-l1); }
.ppr-root[data-narrow="true"] .ppr-workspace { flex-direction:column; }
.ppr-root[data-narrow="true"] .ppr-outline { display:none; }
.ppr-root[data-narrow="true"] .ppr-viewer { min-height:50%; }
.ppr-root[data-narrow="true"] .ppr-main { flex:1 1 50%; min-height:0; }
.ppr-root[data-narrow="true"] .ppr-assistant { flex:1 1 50%; min-height:0; }
.ppr-root[data-narrow="true"] .ppr-search input { width:110px; }
.ppr-root[data-narrow="true"] .ppr-search input:focus { width:150px; }
.ppr-root[data-narrow="true"] .ppr-page-indicator { font-size:11.5px; }
`;

    // #endregion

    // #region Components: library

    function PaperMark({ size = 15 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 64 64', 'aria-hidden': true, focusable: 'false' },
        h('rect', { x: 10, y: 5, width: 44, height: 54, rx: 7, fill: 'currentColor', opacity: 0.16 }),
        h('path', { d: 'M22 22h20M22 31h20M22 40h13', stroke: 'currentColor', strokeWidth: 5, strokeLinecap: 'round' }),
      );
    }

    function Library({ library, query, onQuery, onOpen, onRefresh, t, openingPath, getProgress, onUpload, upload }) {
      const [dragging, setDragging] = useState(false);
      const inputRef = useRef(null);
      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (needle.length === 0) return library.items;
        return library.items.filter((item) => {
          const haystack = `${item.title ?? ''} ${item.name} ${item.path}`.toLowerCase();
          return haystack.includes(needle);
        });
      }, [library.items, query]);

      const empty = library.status === 'ready' && library.items.length === 0;
      const pickFile = () => {
        if (inputRef.current !== null) inputRef.current.click();
      };
      const handleFiles = (fileList) => {
        const file = Array.from(fileList ?? []).find((candidate) => candidate.type === 'application/pdf' || /\.pdf$/i.test(candidate.name));
        if (file !== undefined) onUpload(file);
      };
      return h(
        'div',
        {
          className: 'ppr-lib',
          'data-dragging': dragging ? 'true' : 'false',
          onDragOver: (event) => {
            event.preventDefault();
            setDragging(true);
          },
          onDragLeave: (event) => {
            if (event.currentTarget.contains(event.relatedTarget)) return;
            setDragging(false);
          },
          onDrop: (event) => {
            event.preventDefault();
            setDragging(false);
            handleFiles(event.dataTransfer?.files);
          },
        },
        h('input', {
          ref: inputRef,
          type: 'file',
          accept: 'application/pdf,.pdf',
          style: { display: 'none' },
          onChange: (event) => {
            handleFiles(event.target.files);
            event.target.value = '';
          },
        }),
        h(
          'div',
          { className: 'ppr-lib-head' },
          h('span', { className: 'ppr-lib-title' }, t('library.title')),
          h('span', { className: 'ppr-lib-count' }, t('library.count', { count: library.items.length })),
        ),
        h('div', { className: 'ppr-lib-sub' }, t('library.root'), ': ', h('code', null, library.root ?? '—')),
        h(
          'div',
          { className: 'ppr-lib-tools' },
          h('input', {
            className: 'ppr-input',
            style: { minWidth: '220px', flex: '0 1 320px' },
            placeholder: t('library.search'),
            value: query,
            onChange: (event) => onQuery(event.target.value),
            spellCheck: false,
          }),
          h('span', { className: 'ppr-spacer' }),
          h(
            'button',
            { type: 'button', className: 'ppr-btn', onClick: onRefresh, disabled: library.status === 'loading' || upload.status === 'loading' },
            h(StatusDot, { state: library.status === 'loading' ? 'loading' : 'idle' }),
            h(Icon, { path: ICONS.refresh, size: 13 }),
            t('action.refresh'),
          ),
          h(
            'button',
            { type: 'button', className: 'ppr-btn', 'data-primary': 'true', onClick: pickFile, disabled: upload.status === 'loading' },
            h(Icon, { path: ICONS.plus, size: 13 }),
            t('library.upload'),
          ),
        ),
        dragging ? h('div', { className: 'ppr-drop-hint' }, t('library.drop')) : null,
        upload.status === 'loading'
          ? h('div', { className: 'ppr-status' }, h(StatusDot, { state: 'loading' }), t('library.uploading', { name: upload.name }))
          : upload.status === 'error'
            ? h('div', { className: 'ppr-error' }, h(Icon, { path: ICONS.alert, size: 14 }), h('span', null, upload.error))
            : null,
        library.status === 'error'
          ? h('div', { className: 'ppr-error' }, h(Icon, { path: ICONS.alert, size: 14 }), h('span', null, library.error ?? t('error.load')))
          : null,
        empty
          ? h(
              'div',
              { className: 'ppr-empty' },
              h('div', { className: 'ppr-empty-title' }, t('library.empty')),
              h('div', { className: 'ppr-empty-hint' }, t('library.emptyHint', { root: library.root ?? '—' })),
            )
          : null,
        library.status === 'ready' && filtered.length === 0 && library.items.length > 0
          ? h('div', { className: 'ppr-empty' }, h('div', { className: 'ppr-empty-hint' }, t('library.noMatch', { query })))
          : null,
        library.status === 'loading'
          ? h('div', { className: 'ppr-status' }, h(StatusDot, { state: 'loading' }), t('status.working'))
          : null,
        filtered.length > 0
          ? h(
              'div',
              { className: 'ppr-lib-grid' },
              filtered.map((item) =>
                h(
                  'button',
                  {
                    type: 'button',
                    key: item.path,
                    className: 'ppr-card',
                    onClick: () => onOpen(item.path),
                    disabled: openingPath !== null,
                    'data-opening': openingPath === item.path ? 'true' : 'false',
                  },
                  h(
                    'div',
                    { className: 'ppr-card-top' },
                    h('span', { className: 'ppr-card-icon' }, h(PaperMark, { size: 16 })),
                    h(
                      'span',
                      { className: 'ppr-card-title' },
                      openingPath === item.path ? t('reader.loading') : item.title ?? item.name,
                    ),
                  ),
                  h(
                    'div',
                    { className: 'ppr-card-meta' },
                    item.pageCount !== null ? h('span', null, t('library.pages', { count: item.pageCount })) : null,
                    h('span', null, formatBytes(item.size)),
                    getProgress(item.path) > 0 ? h('span', { className: 'ppr-card-progress' }, t('library.readAt', { page: getProgress(item.path) })) : null,
                  ),
                  item.abstract !== undefined && item.abstract !== null && item.abstract.length > 0
                    ? h('div', { className: 'ppr-card-abstract' }, item.abstract)
                    : h('div', { className: 'ppr-card-path' }, item.path),
                ),
              ),
            )
          : null,
      );
    }

    // #endregion

    // #region Components: PDF viewer

    function useElementWidth(ref) {
      const [width, setWidth] = useState(0);
      useEffect(() => {
        const element = ref.current;
        if (element === null) return undefined;
        const update = () => setWidth(element.clientWidth);
        update();
        if (typeof ResizeObserver === 'undefined') {
          window.addEventListener('resize', update);
          return () => window.removeEventListener('resize', update);
        }
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
      }, [ref]);
      return width;
    }

    function usePdfDocument(path) {
      const [state, setState] = useState({ status: 'loading', doc: null, lib: null, error: null });
      useEffect(() => {
        let cancelled = false;
        const controller = new AbortController();
        setState({ status: 'loading', doc: null, lib: null, error: null });
        (async () => {
          const lib = await loadPdfjs();
          const response = await fetch(apiUrl('file', { path }), { credentials: 'same-origin', signal: controller.signal });
          if (!response.ok) throw new Error(`Could not read the PDF (HTTP ${response.status}).`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          const doc = await lib.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true }).promise;
          if (cancelled) {
            doc.destroy().catch(() => {});
            return;
          }
          setState({ status: 'ready', doc, lib, error: null });
        })().catch((error) => {
          if (cancelled || error?.name === 'AbortError') return;
          setState({ status: 'error', doc: null, lib: null, error: error instanceof Error ? error.message : String(error) });
        });
        return () => {
          cancelled = true;
          controller.abort();
        };
      }, [path]);

      useEffect(() => {
        const doc = state.doc;
        return () => {
          if (doc !== null) doc.destroy().catch(() => {});
        };
      }, [state.doc]);

      return state;
    }

    function PdfPage({ lib, doc, index, displayWidth, displayHeight, scale, visible, registerRef }) {
      const containerRef = useRef(null);
      const canvasRef = useRef(null);
      const layerRef = useRef(null);
      const [status, setStatus] = useState('idle');

      useEffect(() => {
        if (!visible || doc === null) return undefined;
        let cancelled = false;
        let renderTask = null;
        setStatus('rendering');
        (async () => {
          const page = await doc.getPage(index + 1);
          if (cancelled) return;
          const viewport = page.getViewport({ scale });
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const canvas = canvasRef.current;
          if (canvas === null) return;
          canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
          canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          const context2d = canvas.getContext('2d');
          renderTask = page.render({
            canvasContext: context2d,
            viewport,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
          });
          await renderTask.promise;
          if (cancelled) return;
          const textContent = await page.getTextContent();
          if (cancelled) return;
          const layer = layerRef.current;
          if (layer === null) return;
          layer.textContent = '';
          layer.style.setProperty('--scale-factor', String(scale));
          await lib.renderTextLayer({ textContentSource: textContent, container: layer, viewport, textDivs: [] }).promise;
          if (!cancelled) setStatus('ready');
        })().catch((error) => {
          if (cancelled || error?.name === 'RenderingCancelledException') return;
          setStatus('error');
        });
        return () => {
          cancelled = true;
          if (renderTask !== null) {
            try {
              renderTask.cancel();
            } catch {
              /* already finished */
            }
          }
          if (layerRef.current !== null) layerRef.current.textContent = '';
        };
      }, [visible, scale, doc, index, lib]);

      return h(
        'div',
        {
          className: 'ppr-page',
          'data-page': index,
          'data-page-loading': visible && status === 'rendering' ? 'true' : 'false',
          'data-placeholder': visible ? 'false' : 'true',
          ref: (element) => {
            containerRef.current = element;
            registerRef(index, element);
          },
          style: { width: `${displayWidth}px`, height: `${displayHeight}px`, '--scale-factor': String(scale) },
        },
        !visible
          ? h('span', null, `${index + 1}`)
          : null,
        visible ? h('canvas', { ref: canvasRef, 'aria-label': `Page ${index + 1}` }) : null,
        visible ? h('div', { className: 'ppr-textLayer', ref: layerRef }) : null,
        status === 'error'
          ? h('div', { className: 'ppr-page-error' }, h(Icon, { path: ICONS.alert, size: 16 }), ' rendering failed')
          : null,
      );
    }

    function PdfViewer({
      paper,
      path,
      t,
      currentPage,
      onCurrentPage,
      zoom,
      setZoom,
      registerScrollTo,
      onSelection,
      pageRefs,
      initialPage,
    }) {
      const scrollRef = useRef(null);
      const width = useElementWidth(scrollRef);
      const state = usePdfDocument(path);
      const [visible, setVisible] = useState(() => new Set([initialPage]));
      const [needsInit, setNeedsInit] = useState(true);

      const pageCount = paper.pages.length;
      const padding = 36;
      const fitWidth = Math.max(180, width - padding);
      const factor = zoom === 'fit' ? 1 : zoom;
      const firstPage = paper.pages[0] ?? { width: 612, height: 792 };

      const pageWidths = useMemo(() => {
        return paper.pages.map((page) => {
          const displayWidth = Math.round((fitWidth * factor * (page.width / firstPage.width)));
          const displayHeight = Math.round(displayWidth * (page.height / page.width));
          return { displayWidth, displayHeight, scale: displayWidth / page.width };
        });
      }, [paper.pages, fitWidth, factor, firstPage.width]);

      useEffect(() => {
        if (state.status !== 'ready') return undefined;
        const root = scrollRef.current;
        if (root === null) return undefined;
        const observer = new IntersectionObserver(
          (entries) => {
            setVisible((previous) => {
              let changed = false;
              const next = new Set(previous);
              for (const entry of entries) {
                const index = Number(entry.target.getAttribute('data-page'));
                if (!Number.isFinite(index)) continue;
                if (entry.isIntersecting) {
                  if (!next.has(index)) {
                    next.add(index);
                    changed = true;
                  }
                } else if (next.size > 1 && next.delete(index)) {
                  changed = true;
                }
              }
              return changed ? next : previous;
            });
          },
          { root, rootMargin: '900px 0px' },
        );
        const elements = root.querySelectorAll('[data-page]');
        elements.forEach((element) => observer.observe(element));
        return () => observer.disconnect();
      }, [state.status, pageCount]);

      useEffect(() => {
        if (state.status !== 'ready') return undefined;
        const root = scrollRef.current;
        if (root === null) return undefined;
        const observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const index = Number(entry.target.getAttribute('data-page'));
              if (Number.isFinite(index)) onCurrentPage(index);
            }
          },
          { root, rootMargin: '-45% 0px -50% 0px' },
        );
        const elements = root.querySelectorAll('[data-page]');
        elements.forEach((element) => observer.observe(element));
        return () => observer.disconnect();
      }, [state.status, pageCount, onCurrentPage]);

      useEffect(() => {
        registerScrollTo((pageIndex) => {
          const root = scrollRef.current;
          if (root === null) return;
          const target = pageRefs.current[pageIndex];
          if (target === undefined || target === null) return;
          const targetRect = target.getBoundingClientRect();
          const rootRect = root.getBoundingClientRect();
          root.scrollTop += targetRect.top - rootRect.top - 10;
          onCurrentPage(pageIndex);
        });
      }, [registerScrollTo, pageRefs, onCurrentPage]);

      useEffect(() => {
        if (state.status !== 'ready' || !needsInit) return;
        const target = pageRefs.current[initialPage];
        if (target !== undefined && target !== null && scrollRef.current !== null) {
          const targetRect = target.getBoundingClientRect();
          const rootRect = scrollRef.current.getBoundingClientRect();
          scrollRef.current.scrollTop += targetRect.top - rootRect.top - 10;
        }
        setNeedsInit(false);
      }, [state.status, needsInit, initialPage, pageRefs]);

      const captureSelection = useCallback(() => {
        const selection = window.getSelection();
        if (selection === null || selection.isCollapsed) {
          onSelection(null);
          return;
        }
        const text = selection.toString().replace(/\s+/g, ' ').trim();
        if (text.length < 3) {
          onSelection(null);
          return;
        }
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        const node = range.startContainer;
        const element = node.nodeType === 1 ? node : node.parentElement;
        const pageElement = element === null || element === undefined ? null : element.closest('[data-page]');
        const page = pageElement === null ? currentPage : Number(pageElement.getAttribute('data-page'));
        onSelection({
          text: text.slice(0, 8000),
          truncated: text.length > 8000,
          page: Number.isFinite(page) ? page : currentPage,
          rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        });
      }, [currentPage, onSelection]);

      const handleKeyUp = useCallback(
        (event) => {
          if (event.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            captureSelection();
          }
        },
        [captureSelection],
      );

      function registerPage(index, element) {
        if (element === null) delete pageRefs.current[index];
        else pageRefs.current[index] = element;
      }

      return h(
        'div',
        { className: 'ppr-viewer' },
        state.status === 'error'
          ? h('div', { className: 'ppr-empty' }, h('div', { className: 'ppr-empty-title' }, t('error.pdf')), h('div', { className: 'ppr-empty-hint' }, state.error))
          : h(
              'div',
              { className: 'ppr-pages', ref: scrollRef, onMouseUp: captureSelection, onKeyUp: handleKeyUp },
              state.status === 'loading'
                ? h('div', { className: 'ppr-status', style: { paddingTop: '40px' } }, h(StatusDot, { state: 'loading' }), t('reader.loading'))
                : paper.pages.map((page, index) =>
                    h(PdfPage, {
                      key: index,
                      lib: state.lib,
                      doc: state.doc,
                      index,
                      displayWidth: pageWidths[index].displayWidth,
                      displayHeight: pageWidths[index].displayHeight,
                      scale: pageWidths[index].scale,
                      visible: visible.has(index),
                      registerRef: registerPage,
                    }),
                  ),
            ),
      );
    }

    function OutlinePane({ paper, currentPage, onJump, t, overlay }) {
      const sections = paper.sections ?? [];
      return h(
        'aside',
        { className: 'ppr-outline', 'data-overlay': overlay ? 'true' : 'false' },
        h('div', { className: 'ppr-outline-head' }, t('reader.outline')),
        h(
          'div',
          { className: 'ppr-outline-list' },
          sections.length === 0
            ? h('div', { className: 'ppr-hint', style: { padding: '8px' } }, t('reader.noOutline'))
            : sections.map((section, index) =>
                h(
                  'button',
                  {
                    type: 'button',
                    key: `${index}-${section.title}`,
                    className: 'ppr-outline-item',
                    'data-level': String(Math.min(3, Math.max(1, section.level))),
                    'data-active': section.page === currentPage ? 'true' : 'false',
                    title: section.title,
                    onClick: () => onJump(section.page),
                  },
                  h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, section.title),
                  h('span', { className: 'ppr-outline-page' }, String(section.page + 1)),
                ),
              ),
        ),
        h('div', { className: 'ppr-hint', style: { padding: '8px 14px', borderTop: '1px solid var(--dsw-alias-border-l1)' } }, t('shortcuts')),
      );
    }

    function SelectionPopup({ selection, onAction, onDismiss, t }) {
      const [placement, setPlacement] = useState(null);
      useEffect(() => {
        if (selection === null) {
          setPlacement(null);
          return;
        }
        const width = 330;
        const height = 38;
        const left = clamp(selection.rect.left + selection.rect.width / 2 - width / 2, 8, window.innerWidth - width - 8);
        const above = selection.rect.top - height - 8;
        const top = above > 8 ? above : Math.min(window.innerHeight - height - 8, selection.rect.bottom + 8);
        setPlacement({ left, top });
      }, [selection]);

      useEffect(() => {
        if (selection === null) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onDismiss();
        };
        const dismiss = () => onDismiss();
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('scroll', dismiss, true);
        window.addEventListener('resize', dismiss);
        return () => {
          window.removeEventListener('keydown', onKeyDown);
          window.removeEventListener('scroll', dismiss, true);
          window.removeEventListener('resize', dismiss);
        };
      }, [selection, onDismiss]);

      if (selection === null || placement === null) return null;
      return h(
        'div',
        { className: 'ppr-selection-pop', style: { left: `${placement.left}px`, top: `${placement.top}px` }, role: 'toolbar' },
        h(
          'button',
          { type: 'button', className: 'ppr-btn', onClick: () => onAction('translate'), title: t('selection.translate') },
          h(Icon, { path: ICONS.languages, size: 14 }),
          t('selection.translate'),
        ),
        h(
          'button',
          { type: 'button', className: 'ppr-btn', onClick: () => onAction('explain'), title: t('selection.explain') },
          h(Icon, { path: ICONS.sparkles, size: 14 }),
          t('selection.explain'),
        ),
        h(
          'button',
          { type: 'button', className: 'ppr-btn', onClick: () => onAction('terms'), title: t('selection.terms') },
          h(Icon, { path: ICONS.list, size: 14 }),
          t('selection.terms'),
        ),
        h(
          'button',
          { type: 'button', className: 'ppr-btn', onClick: () => onAction('quote'), title: t('selection.quote') },
          h(Icon, { path: ICONS.highlight, size: 14 }),
          t('selection.quote'),
        ),
        h(
          'button',
          { type: 'button', className: 'ppr-btn', onClick: onDismiss, title: t('action.close') },
          h(Icon, { path: ICONS.x, size: 14 }),
        ),
      );
    }

    // #endregion

    // #region Components: reader + assistant

    function useLocale(ctx) {
      const [, setTick] = useState(0);
      useEffect(() => ctx.locale.subscribe(() => setTick((value) => value + 1)), [ctx]);
      // Stable across renders: resolving the dictionary happens per call, so a
      // locale change still picks up the new dictionary without invalidating
      // every effect that depends on `t`.
      return useCallback((key, params) => ctx.locale.bind(NS)(key, params), [ctx]);
    }

    function sectionForPage(paper, page) {
      let match = '';
      for (const section of paper.sections ?? []) {
        if (section.page <= page) match = section.title;
        else break;
      }
      return match;
    }

    function NotesPane({ t, notes, onGenerate, onSave, onEditToggle, onCopy, onClear, onChangeText, onInsertTemplate }) {
      const hasText = notes.text.trim().length > 0;
      const busy = notes.status === 'loading';
      return h(
        'div',
        { className: 'ppr-pane' },
        h(
          'div',
          { className: 'ppr-note-toolbar' },
          h(
            'button',
            {
              type: 'button',
              className: 'ppr-btn',
              'data-primary': hasText ? 'false' : 'true',
              disabled: busy,
              onClick: onGenerate,
            },
            h(StatusDot, { state: busy ? 'loading' : 'idle' }),
            h(Icon, { path: ICONS.sparkles, size: 13 }),
            hasText ? t('action.regenerate') : t('action.generate'),
          ),
          hasText
            ? h(
                'button',
                { type: 'button', className: 'ppr-btn', disabled: busy, onClick: onEditToggle },
                h(Icon, { path: notes.editing ? ICONS.eye : ICONS.edit, size: 13 }),
                notes.editing ? t('action.preview') : t('action.edit'),
              )
            : null,
          hasText && !notes.editing
            ? h(
                'button',
                { type: 'button', className: 'ppr-btn', onClick: onCopy },
                h(Icon, { path: notes.copied ? ICONS.check : ICONS.copy, size: 13 }),
                notes.copied ? t('action.copied') : t('action.copy'),
              )
            : null,
          hasText
            ? h(
                'button',
                { type: 'button', className: 'ppr-btn', 'data-primary': 'true', disabled: busy || notes.saving, onClick: onSave },
                h(Icon, { path: ICONS.save, size: 13 }),
                notes.saving ? t('action.saving') : t('action.save'),
              )
            : null,
          hasText
            ? h(
                'button',
                { type: 'button', className: 'ppr-icon-btn', title: t('action.close'), 'aria-label': t('action.close'), onClick: onClear },
                h(Icon, { path: ICONS.x, size: 13 }),
              )
            : null,
          h(
            'span',
            { className: 'ppr-note-status', title: notes.savedPath || undefined },
            notes.error !== null
              ? h('span', { className: 'ppr-warn' }, notes.error)
              : notes.dirty
                ? t('notes.unsaved')
                : notes.savedPath.length > 0
                  ? h('span', { className: 'ppr-saved' }, h(Icon, { path: ICONS.check, size: 11 }), notes.savedPath)
                  : '',
          ),
        ),
        h(
          'div',
          { className: 'ppr-pane-scroll' },
          notes.status === 'loading' && !hasText
            ? h('div', { className: 'ppr-status' }, h(StatusDot, { state: 'loading' }), t('notes.generating'))
            : null,
          !hasText && notes.status !== 'loading'
            ? h(
                'div',
                null,
                h('div', { className: 'ppr-hint' }, t('notes.empty')),
                h('div', { className: 'ppr-hint', style: { marginTop: '6px' } }, t('notes.hint')),
                notes.error !== null ? h('div', { className: 'ppr-error', style: { marginTop: '10px' } }, notes.error) : null,
              )
            : null,
          hasText && notes.editing
            ? h('textarea', {
                className: 'ppr-textarea',
                value: notes.text,
                placeholder: t('notes.placeholder'),
                spellCheck: false,
                onChange: (event) => onChangeText(event.target.value),
              })
            : null,
          hasText && !notes.editing
            ? h(Markdown, { text: notes.text })
            : null,
          busy && hasText ? h('div', { className: 'ppr-status' }, h(StatusDot, { state: 'loading' }), t('notes.generating')) : null,
          notes.truncated === true && hasText && !notes.editing ? h('div', { className: 'ppr-warn', style: { marginTop: '10px' } }, t('status.truncated')) : null,
          notes.model.length > 0 && hasText && !notes.editing
            ? h('div', { className: 'ppr-hint', style: { marginTop: '14px' } }, t('status.model', { model: notes.model }))
            : null,
        ),
      );
    }

    function ExplainPane({ t, explain, onPageBrief, onBrief }) {
      const busy = explain.status === 'loading';
      return h(
        'div',
        { className: 'ppr-pane' },
        h(
          'div',
          { className: 'ppr-pane-actions' },
          h(
            'button',
            { type: 'button', className: 'ppr-btn', disabled: busy, onClick: onPageBrief },
            h(Icon, { path: ICONS.highlight, size: 13 }),
            t('action.pageBrief'),
          ),
          h(
            'button',
            { type: 'button', className: 'ppr-btn', disabled: busy, onClick: onBrief },
            h(Icon, { path: ICONS.sparkles, size: 13 }),
            t('notes.brief'),
          ),
        ),
        h(
          'div',
          { className: 'ppr-pane-scroll' },
          explain.selectionText.length > 0
            ? h(
                'div',
                { className: 'ppr-selection-quote' },
                h('div', { className: 'ppr-msg-role', style: { marginBottom: '3px' } }, t('explain.selection', { page: (explain.page ?? 0) + 1 })),
                explain.selectionText.slice(0, 320),
                explain.selectionText.length > 320 ? '…' : '',
              )
            : explain.kind === 'brief' || explain.kind === 'page'
              ? h('div', { className: 'ppr-msg-role', style: { marginBottom: '8px' } }, explain.label)
              : null,
          explain.status === 'idle'
            ? h('div', null, h('div', { className: 'ppr-hint' }, t('explain.empty')), h('div', { className: 'ppr-hint', style: { marginTop: '8px' } }, t('shortcuts')))
            : null,
          busy && explain.text.length === 0
            ? h('div', { className: 'ppr-status' }, h(StatusDot, { state: 'loading' }), t('explain.working'))
            : null,
          explain.error !== null ? h('div', { className: 'ppr-error', style: { marginBottom: '10px' } }, h(Icon, { path: ICONS.alert, size: 14 }), h('span', null, explain.error)) : null,
          explain.text.length > 0 ? h(Markdown, { text: explain.text }) : null,
          busy && explain.text.length > 0 ? h('div', { className: 'ppr-status' }, h(StatusDot, { state: 'loading' }), t('explain.working')) : null,
          explain.truncated === true ? h('div', { className: 'ppr-warn', style: { marginTop: '10px' } }, t('status.truncated')) : null,
          explain.status === 'ready' && explain.model.length > 0
            ? h('div', { className: 'ppr-hint', style: { marginTop: '14px' } }, t('status.model', { model: explain.model }))
            : null,
        ),
      );
    }

    function AskPane({ t, chat, onAsk, busy, suggestions }) {
      const [draft, setDraft] = useState('');
      const listRef = useRef(null);
      useEffect(() => {
        const element = listRef.current;
        if (element !== null) element.scrollTop = element.scrollHeight;
      }, [chat.messages, chat.status]);
      const submit = () => {
        const question = draft.trim();
        if (question.length === 0 || chat.status === 'loading') return;
        setDraft('');
        onAsk(question);
      };
      return h(
        'div',
        { className: 'ppr-pane' },
        h(
          'div',
          { className: 'ppr-pane-scroll', ref: listRef },
          chat.messages.length === 0
            ? h(
                'div',
                null,
                h('div', { className: 'ppr-hint' }, t('ask.empty')),
                h(
                  'div',
                  { className: 'ppr-suggest' },
                  suggestions.map((suggestion) =>
                    h(
                      'button',
                      { type: 'button', key: suggestion, className: 'ppr-chip', onClick: () => onAsk(suggestion) },
                      suggestion,
                    ),
                  ),
                ),
              )
            : null,
          h(
            'div',
            { className: 'ppr-chat' },
            chat.messages.map((message, index) =>
              h(
                'div',
                { key: index, className: 'ppr-msg', 'data-role': message.role },
                h('div', { className: 'ppr-msg-role' }, message.role === 'user' ? 'You' : 'AI'),
                h('div', { className: 'ppr-bubble' }, message.role === 'user' ? message.content : h(Markdown, { text: message.content })),
              ),
            ),
            chat.status === 'loading' ? h('div', { className: 'ppr-status' }, h(StatusDot, { state: 'loading' }), t('ask.thinking')) : null,
            chat.error !== null ? h('div', { className: 'ppr-error' }, chat.error) : null,
            chat.truncated === true ? h('div', { className: 'ppr-warn' }, t('status.truncated')) : null,
          ),
        ),
        h(
          'div',
          { className: 'ppr-chat-input' },
          h('textarea', {
            value: draft,
            placeholder: t('ask.placeholder'),
            rows: 1,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            },
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'ppr-btn',
              'data-primary': 'true',
              disabled: chat.status === 'loading' || draft.trim().length === 0,
              onClick: submit,
              title: t('ask.send'),
            },
            h(Icon, { path: ICONS.send, size: 14 }),
          ),
        ),
      );
    }

    function AssistantPane({ t, tab, onTab, notes, explain, chat, actions, suggestions }) {
      return h(
        'aside',
        { className: 'ppr-assistant' },
        h(
          'div',
          { className: 'ppr-assistant-head' },
          h(
            'div',
            { className: 'ppr-tabs' },
            h(
              'button',
              { type: 'button', className: 'ppr-tab', 'data-active': tab === 'notes' ? 'true' : 'false', onClick: () => onTab('notes') },
              t('tabs.notes'),
            ),
            h(
              'button',
              { type: 'button', className: 'ppr-tab', 'data-active': tab === 'explain' ? 'true' : 'false', onClick: () => onTab('explain') },
              t('tabs.explain'),
            ),
            h(
              'button',
              { type: 'button', className: 'ppr-tab', 'data-active': tab === 'ask' ? 'true' : 'false', onClick: () => onTab('ask') },
              t('tabs.ask'),
            ),
          ),
        ),
        tab === 'notes'
          ? h(NotesPane, { t, notes: notes.state, ...actions.notes })
          : tab === 'explain'
            ? h(ExplainPane, { t, explain: explain.state, ...actions.explain })
            : h(AskPane, { t, chat: chat.state, onAsk: actions.ask, busy: chat.state.status === 'loading', suggestions }),
      );
    }

    function Reader({ ctx, path, paper, note, language, onLanguage, onBack, t }) {
      const progressKey = `ppr.page.${path}`;
      const initialPage = useMemo(() => {
        const raw = readStored(progressKey);
        const page = Number(raw);
        return Number.isInteger(page) && page >= 0 && page < paper.pages.length ? page : 0;
      }, [progressKey, paper.pages.length]);
      const [currentPage, setCurrentPage] = useState(initialPage);
      const [zoom, setZoom] = useState(() => {
        const raw = readStored(STORAGE_ZOOM);
        if (raw === 'fit') return 'fit';
        const value = Number(raw);
        return Number.isFinite(value) && value > 0.2 && value <= 4 ? value : 1;
      });
      const [selection, setSelection] = useState(null);
      const [search, setSearch] = useState({ query: '', focused: false });
      const [tab, setTab] = useState('notes');
      const pageRefs = useRef({});
      const scrollToRef = useRef(() => {});
      const registerScrollTo = useCallback((fn) => {
        scrollToRef.current = fn;
      }, []);
      const rootRef = useRef(null);
      const rootWidth = useElementWidth(rootRef);
      const narrow = rootWidth > 0 && rootWidth < 1000;
      const [showOutline, setShowOutline] = useState(true);
      const abortRef = useRef(null);
      const explainSeq = useRef(0);
      const notesSeq = useRef(0);

      const [notes, setNotes] = useState(() => ({
        text: note?.markdown ?? '',
        savedPath: note?.path ?? '',
        dirty: false,
        editing: false,
        saving: false,
        copied: false,
        status: 'idle',
        error: null,
        model: '',
        truncated: false,
      }));
      const [explain, setExplain] = useState({
        status: 'idle',
        kind: null,
        label: '',
        text: '',
        error: null,
        model: '',
        page: 0,
        selectionText: '',
        truncated: false,
      });
      const [chat, setChat] = useState({ messages: [], status: 'idle', error: null, truncated: false });

      useEffect(() => {
        writeStored(progressKey, String(currentPage));
      }, [progressKey, currentPage]);
      useEffect(() => {
        if (narrow) setShowOutline(false);
      }, [narrow]);
      useEffect(() => {
        writeStored(STORAGE_ZOOM, String(zoom));
      }, [zoom]);
      useEffect(() => () => {
        if (abortRef.current !== null) abortRef.current.abort();
      }, []);

      const beginAbort = useCallback(() => {
        if (abortRef.current !== null) abortRef.current.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        return controller;
      }, []);

      const jumpToPage = useCallback(
        (page) => {
          const index = clamp(Math.round(page), 0, paper.pages.length - 1);
          scrollToRef.current(index);
        },
        [paper.pages.length],
      );

      const changePage = useCallback(
        (delta) => {
          jumpToPage(currentPage + delta);
        },
        [currentPage, jumpToPage],
      );

      const searchResults = useMemo(() => {
        const needle = search.query.trim().toLowerCase();
        if (needle.length < 2) return [];
        const results = [];
        for (const page of paper.pages) {
          const lower = page.text.toLowerCase();
          let cursor = 0;
          while (results.length < 40) {
            const at = lower.indexOf(needle, cursor);
            if (at < 0) break;
            results.push({
              page: page.index,
              snippet: page.text.slice(Math.max(0, at - 60), at + needle.length + 100).replace(/\s+/g, ' ').trim(),
            });
            cursor = at + needle.length;
          }
          if (results.length >= 40) break;
        }
        return results;
      }, [paper.pages, search.query]);

      const quoteSelection = useCallback(() => {
        if (selection === null) return;
        const text = selection.text.replace(/\s+/g, ' ').trim();
        if (text.length === 0) return;
        const source = language === 'zh' ? `第 ${selection.page + 1} 页` : `page ${selection.page + 1}`;
        const quote = `> ${text}\n>\n> — ${source}`;
        setNotes((previous) => ({
          ...previous,
          text: previous.text.trim().length > 0 ? `${previous.text.replace(/\s+$/, '')}\n\n${quote}\n` : `${quote}\n`,
          dirty: true,
          editing: false,
          status: previous.status === 'idle' ? 'ready' : previous.status,
          error: null,
        }));
        setTab('notes');
        setSelection(null);
      }, [language, selection]);

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.target !== null && ['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            if (event.shiftKey) {
              const sections = paper.sections ?? [];
              const delta = event.key === 'ArrowLeft' ? -1 : 1;
              const candidates = sections
                .map((section) => section.page)
                .filter((page) => (delta > 0 ? page > currentPage : page < currentPage));
              if (candidates.length > 0) jumpToPage(delta > 0 ? Math.min(...candidates) : Math.max(...candidates));
            } else {
              changePage(event.key === 'ArrowLeft' ? -1 : 1);
            }
          }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [changePage, currentPage, jumpToPage, paper.sections]);

      const generateNotes = useCallback(async () => {
        if (notes.text.trim().length > 0 && !window.confirm(t('notes.confirmRegenerate'))) return;
        const sequence = ++notesSeq.current;
        const controller = beginAbort();
        setTab('notes');
        setNotes((previous) => ({ ...previous, status: 'loading', error: null, text: '', editing: false, dirty: false, model: '', truncated: false }));
        try {
          const result = await streamAssistant(
            'summarize',
            { path, style: 'notes', locale: language },
            {
              signal: controller.signal,
              onDelta: (delta) => setNotes((previous) => ({ ...previous, text: previous.text + delta })),
              onMeta: (frame) => {
                if (typeof frame.model === 'string') setNotes((previous) => ({ ...previous, model: frame.model }));
              },
            },
          );
          if (sequence !== notesSeq.current) return;
          setNotes((previous) => ({ ...previous, status: 'ready', model: result.model || previous.model, dirty: true, truncated: result.truncated === true }));
        } catch (error) {
          if (sequence !== notesSeq.current) return;
          if (error?.name === 'AbortError') {
            setNotes((previous) => ({ ...previous, status: 'idle' }));
            return;
          }
          setNotes((previous) => ({ ...previous, status: 'error', error: error instanceof Error ? error.message : t('error.notes') }));
        }
      }, [beginAbort, language, notes.text, path, t]);

      const saveNotes = useCallback(async () => {
        if (notes.saving) return;
        setNotes((previous) => ({ ...previous, saving: true, error: null }));
        try {
          const saved = await requestJson('notes', { body: { path, markdown: notes.text } });
          setNotes((previous) => ({ ...previous, saving: false, dirty: false, savedPath: saved.path }));
        } catch (error) {
          setNotes((previous) => ({
            ...previous,
            saving: false,
            error: error instanceof Error ? error.message : t('error.save'),
          }));
        }
      }, [notes.saving, notes.text, path, t]);

      const insertNotesTemplate = useCallback(() => {
        const lines = [
          `# ${paper.title}`,
          '',
          '> 一句话总结：',
          '',
          '## 研究问题',
          '- ',
          '',
          '## 核心方法',
          '- ',
          '',
          '## 关键贡献',
          '- ',
          '',
          '## 实验与结果',
          '- ',
          '',
          '## 局限与可借鉴',
          '- ',
          '',
          '## 术语表',
          '| 英文术语 | 中文 | 解释 |',
          '| --- | --- | --- |',
          '|  |  |  |',
          '',
        ];
        if (Array.isArray(paper.sections) && paper.sections.length > 0) {
          lines.push('## 阅读路线');
          for (const section of paper.sections.slice(0, 14)) lines.push(`- [ ] ${section.title}（第 ${section.page + 1} 页）`);
          lines.push('');
        }
        setNotes((previous) => ({ ...previous, text: lines.join('\n'), dirty: true, editing: true, status: 'ready', error: null }));
        setTab('notes');
      }, [paper]);

      const copyNotes = useCallback(async () => {
        try {
          await navigator.clipboard.writeText(notes.text);
          setNotes((previous) => ({ ...previous, copied: true }));
          window.setTimeout(() => setNotes((previous) => ({ ...previous, copied: false })), 1600);
        } catch {
          /* clipboard may be unavailable */
        }
      }, [notes.text]);

      const runExplain = useCallback(
        async (mode) => {
          const current = selection;
          if (current === null) return;
          const sequence = ++explainSeq.current;
          const controller = beginAbort();
          setTab('explain');
          setExplain({
            status: 'loading',
            kind: mode,
            label: '',
            text: '',
            error: null,
            model: '',
            page: current.page,
            selectionText: current.text,
            truncated: false,
          });
          setSelection(null);
          try {
            const data = await requestJson('explain', {
              body: {
                path,
                mode,
                text: current.text,
                page: current.page,
                context: paper.pages[current.page]?.text ?? '',
                section: sectionForPage(paper, current.page),
                locale: language,
              },
              signal: controller.signal,
            });
            if (sequence !== explainSeq.current) return;
            setExplain((previous) => ({ ...previous, status: 'ready', text: data.text, model: data.model ?? '', truncated: data.truncated === true }));
          } catch (error) {
            if (sequence !== explainSeq.current) return;
            if (error?.name === 'AbortError') {
              setExplain((previous) => ({ ...previous, status: 'idle' }));
              return;
            }
            setExplain((previous) => ({
              ...previous,
              status: 'error',
              error: error instanceof Error ? error.message : t('error.explain'),
            }));
          }
        },
        [beginAbort, language, paper, path, selection, t],
      );

      const handleSelectionAction = useCallback(
        (mode) => {
          if (mode === 'quote') {
            quoteSelection();
            return;
          }
          runExplain(mode);
        },
        [quoteSelection, runExplain],
      );

      const streamExplain = useCallback(
        async (route, payload, kind, label) => {
          const sequence = ++explainSeq.current;
          setTab('explain');
          setExplain({ status: 'loading', kind, label, text: '', error: null, model: '', page: payload.page ?? currentPage, selectionText: '' });
          const controller = beginAbort();
          try {
            const result = await streamAssistant(route, payload, {
              signal: controller.signal,
              onDelta: (delta) => {
                if (sequence !== explainSeq.current) return;
                setExplain((previous) => ({ ...previous, text: previous.text + delta }));
              },
              onMeta: (frame) => {
                if (sequence !== explainSeq.current) return;
                if (typeof frame.model === 'string') setExplain((previous) => ({ ...previous, model: frame.model }));
              },
            });
            if (sequence !== explainSeq.current) return;
            setExplain((previous) => ({ ...previous, status: 'ready', model: result.model || previous.model, truncated: result.truncated === true }));
          } catch (error) {
            if (sequence !== explainSeq.current) return;
            if (error?.name === 'AbortError') {
              setExplain((previous) => ({ ...previous, status: 'idle' }));
              return;
            }
            setExplain((previous) => ({
              ...previous,
              status: 'error',
              error: error instanceof Error ? error.message : t('error.explain'),
            }));
          }
        },
        [beginAbort, currentPage, t],
      );

      const pageBrief = useCallback(() => {
        streamExplain(
          'page-brief',
          { path, page: currentPage, locale: language },
          'page',
          t('explain.pageBrief', { page: currentPage + 1 }),
        );
      }, [currentPage, language, path, streamExplain, t]);

      const paperBrief = useCallback(() => {
        streamExplain('summarize', { path, style: 'brief', locale: language }, 'brief', t('notes.brief'));
      }, [language, path, streamExplain, t]);

      const ask = useCallback(
        async (question) => {
          const trimmed = question.trim();
          if (trimmed.length === 0) return;
          const history = chat.messages.map((message) => ({ role: message.role, content: message.content }));
          setTab('ask');
          setChat((previous) => ({
            messages: [...previous.messages, { role: 'user', content: trimmed }, { role: 'assistant', content: '' }],
            status: 'loading',
            error: null,
          }));
          const controller = beginAbort();
          try {
            const result = await streamAssistant(
              'ask',
              { path, question: trimmed, history, locale: language },
              {
                signal: controller.signal,
                onDelta: (delta) =>
                  setChat((previous) => {
                    const messages = previous.messages.slice();
                    const last = messages[messages.length - 1];
                    messages[messages.length - 1] = { ...last, content: last.content + delta };
                    return { ...previous, messages };
                  }),
              },
            );
            setChat((previous) => ({ ...previous, status: 'idle', truncated: result.truncated === true }));
          } catch (error) {
            if (error?.name === 'AbortError') {
              setChat((previous) => {
                const messages = previous.messages.slice();
                const last = messages[messages.length - 1];
                if (last !== undefined && last.role === 'assistant' && last.content.length === 0) messages.pop();
                return { ...previous, messages, status: 'idle', truncated: false };
              });
              return;
            }
            setChat((previous) => ({
              ...previous,
              status: 'error',
              error: error instanceof Error ? error.message : t('error.ask'),
            }));
          }
        },
        [beginAbort, chat.messages, language, path, t],
      );

      const actions = {
        notes: {
          onGenerate: generateNotes,
          onSave: saveNotes,
          onCopy: copyNotes,
          onClear: () => {
            if (notes.text.trim().length > 0 && !window.confirm(t('notes.confirmClear'))) return;
            setNotes((previous) => ({ ...previous, text: '', savedPath: '', dirty: false, editing: false, error: null }));
          },
          onEditToggle: () => setNotes((previous) => ({ ...previous, editing: !previous.editing })),
          onChangeText: (value) => setNotes((previous) => ({ ...previous, text: value, dirty: true })),
          onInsertTemplate: insertNotesTemplate,
        },
        explain: {
          onPageBrief: pageBrief,
          onBrief: paperBrief,
        },
        ask,
      };

      const suggestions = useMemo(
        () =>
          language === 'zh'
            ? ['这篇论文的核心贡献是什么？', '方法的关键步骤是什么？', '实验中最有说服力的结果是什么？', '这篇论文有什么局限？']
            : ['What is the core contribution?', 'What are the key steps of the method?', 'Which experimental result is most convincing?', 'What are the limitations?'],
        [language],
      );

      return h(
        'div',
        { className: 'ppr-root', 'data-narrow': narrow ? 'true' : 'false', ref: rootRef },
        h('style', null, STYLE),
        h(
          'div',
          { className: 'ppr-header' },
          h(
            'button',
            {
              type: 'button',
              className: 'ppr-btn',
              onClick: () => {
                if (notes.dirty && !window.confirm(t('notes.confirmLeave'))) return;
                onBack();
              },
              title: t('action.back'),
            },
            h(Icon, { path: ICONS.back, size: 14 }),
            t('action.back'),
          ),
          h(
            'div',
            { className: 'ppr-header-paper', style: { flex: 1, minWidth: 0 } },
            h('div', { className: 'ppr-header-title', title: paper.title }, paper.title),
            h(
              'div',
              { className: 'ppr-header-sub' },
              paper.authors.length > 0 ? `${paper.authors} · ` : '',
              t('library.pages', { count: paper.pageCount }),
            ),
          ),
          h(
            'div',
            { className: 'ppr-toolbar' },
            h(
              'button',
              { type: 'button', className: 'ppr-chip', onClick: () => onLanguage(language === 'zh' ? 'en' : 'zh'), title: t('lang.toggle') },
              h(Icon, { path: ICONS.languages, size: 13 }),
              language === 'zh' ? '中文输出' : 'English output',
            ),
          ),
        ),
        h(
          'div',
          { className: 'ppr-workspace' },
          !narrow || showOutline
            ? h(OutlinePane, {
                paper,
                currentPage,
                onJump: (page) => {
                  jumpToPage(page);
                  if (narrow) setShowOutline(false);
                },
                t,
                overlay: narrow,
              })
            : null,
          h(
            'div',
            { className: 'ppr-main' },
            h(
              'div',
              { className: 'ppr-viewer-bar' },
              narrow
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'ppr-icon-btn',
                      'data-active': showOutline ? 'true' : 'false',
                      title: t('reader.outline'),
                      onClick: () => setShowOutline((value) => !value),
                    },
                    h(Icon, { path: ICONS.list, size: 14 }),
                  )
                : null,
              h(
                'button',
                { type: 'button', className: 'ppr-icon-btn', onClick: () => changePage(-1), disabled: currentPage <= 0, title: t('reader.page', { page: currentPage, total: paper.pageCount }) },
                h(Icon, { path: ICONS.chevronLeft, size: 14 }),
              ),
              h(
                'button',
                { type: 'button', className: 'ppr-icon-btn', onClick: () => changePage(1), disabled: currentPage >= paper.pages.length - 1 },
                h(Icon, { path: ICONS.chevronRight, size: 14 }),
              ),
              h('span', { className: 'ppr-page-indicator' }, t('reader.page', { page: currentPage + 1, total: paper.pageCount })),
              h('span', { className: 'ppr-spacer' }),
              h(
                'div',
                { className: 'ppr-search' },
                h('input', {
                  className: 'ppr-input',
                  placeholder: t('search.placeholder'),
                  value: search.query,
                  spellCheck: false,
                  onFocus: () => setSearch((previous) => ({ ...previous, focused: true })),
                  onBlur: () => window.setTimeout(() => setSearch((previous) => ({ ...previous, focused: false })), 160),
                  onChange: (event) => setSearch({ query: event.target.value, focused: true }),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && searchResults.length > 0) {
                      jumpToPage(searchResults[0].page);
                      setSearch({ query: '', focused: false });
                    }
                  },
                }),
                search.focused && search.query.trim().length >= 2
                  ? h(
                      'div',
                      { className: 'ppr-search-results' },
                      h('div', { className: 'ppr-search-head' }, searchResults.length === 0 ? t('search.empty') : t('search.count', { count: searchResults.length })),
                      searchResults.map((result, index) =>
                        h(
                          'button',
                          {
                            type: 'button',
                            key: `${result.page}-${index}`,
                            className: 'ppr-search-row',
                            onMouseDown: (event) => event.preventDefault(),
                            onClick: () => {
                              jumpToPage(result.page);
                              setSearch({ query: '', focused: false });
                            },
                          },
                          h('span', { className: 'ppr-search-page' }, t('search.page', { page: result.page + 1 })),
                          h('span', { className: 'ppr-search-snippet' }, result.snippet),
                        ),
                      ),
                    )
                  : null,
              ),
              h(
                'button',
                { type: 'button', className: 'ppr-chip', onClick: pageBrief, title: t('action.pageBrief') },
                h(Icon, { path: ICONS.sparkles, size: 13 }),
                t('action.pageBrief'),
              ),
              h(
                'button',
                { type: 'button', className: 'ppr-icon-btn', onClick: () => setZoom(typeof zoom === 'number' ? clamp(zoom / 1.15, 0.4, 3) : 0.87), title: t('reader.zoomOut') },
                h(Icon, { path: ICONS.minus, size: 14 }),
              ),
              h(
                'button',
                { type: 'button', className: 'ppr-chip', onClick: () => setZoom('fit'), title: t('reader.fit') },
                typeof zoom === 'number' ? `${Math.round(zoom * 100)}%` : t('reader.fit'),
              ),
              h(
                'button',
                { type: 'button', className: 'ppr-icon-btn', onClick: () => setZoom(typeof zoom === 'number' ? clamp(zoom * 1.15, 0.4, 3) : 1.15), title: t('reader.zoomIn') },
                h(Icon, { path: ICONS.plus, size: 14 }),
              ),
            ),
            paper.pages.length === 0
              ? h(
                  'div',
                  { className: 'ppr-empty' },
                  h('div', { className: 'ppr-empty-title' }, t('error.noText')),
                  h('div', { className: 'ppr-empty-hint' }, t('reader.loadError')),
                )
              : h(PdfViewer, {
                  paper,
                  path,
                  t,
                  currentPage,
                  onCurrentPage: setCurrentPage,
                  zoom,
                  setZoom,
                  registerScrollTo,
                  onSelection: setSelection,
                  pageRefs,
                  initialPage,
                }),
          ),
          h(AssistantPane, {
            t,
            tab,
            onTab: setTab,
            notes: { state: notes },
            explain: { state: explain },
            chat: { state: chat },
            actions,
            suggestions,
          }),
        ),
        h(SelectionPopup, { selection, onAction: handleSelectionAction, onDismiss: () => setSelection(null), t }),
      );
    }

    // #endregion

    // #region App

    function PaperReaderApp({ ctx }) {
      const t = useLocale(ctx);
      const [language, setLanguageState] = useState(() => detectLanguage(ctx));
      const [library, setLibrary] = useState({ status: 'loading', items: [], root: '', error: null });
      const [query, setQuery] = useState('');
      const [openingPath, setOpeningPath] = useState(null);
      const [current, setCurrent] = useState(null);
      const [upload, setUpload] = useState({ status: 'idle', name: '', error: null });

      const setLanguage = useCallback((next) => {
        setLanguageState(next);
        writeStored(STORAGE_LANG, next);
      }, []);

      const loadLibrary = useCallback(async () => {
        setLibrary((previous) => ({ ...previous, status: 'loading', error: null }));
        try {
          const data = await requestJson('library', { method: 'GET' });
          const entries = Array.isArray(data.entries) ? data.entries : [];
          setLibrary({ status: 'ready', items: entries, root: data.root ?? '', error: null });
          // Enrich titles in the background: a handful of papers per batch
          // keeps the first paint instant in a large library.
          let current = entries;
          for (let batch = 0; batch < 3; batch += 1) {
            const untitled = current.filter((entry) => entry.title === null || entry.title === undefined);
            if (untitled.length === 0) break;
            let enriched;
            try {
              enriched = await requestJson('library', { method: 'GET', params: { titles: 6 } });
            } catch {
              break;
            }
            const rows = Array.isArray(enriched.entries) ? enriched.entries : [];
            const byPath = new Map(rows.map((entry) => [entry.path, entry]));
            current = current.map((entry) => byPath.get(entry.path) ?? entry);
            setLibrary((previous) => (previous.status === 'ready' ? { ...previous, items: current } : previous));
            const stillUntitled = rows.filter((entry) => entry.title === null || entry.title === undefined).length;
            if (stillUntitled === 0 || stillUntitled >= untitled.length) break;
          }
          return data;
        } catch (error) {
          setLibrary((previous) => ({
            ...previous,
            status: 'error',
            error: error instanceof Error ? error.message : t('error.load'),
          }));
          return null;
        }
      }, [t]);

      const openPaper = useCallback(
        async (path) => {
          setOpeningPath(path);
          try {
            const data = await requestJson('open', { body: { path } });
            setCurrent({ path, paper: data.paper, note: data.note ?? null });
            writeStored(STORAGE_LAST, path);
          } catch (error) {
            setLibrary((previous) => ({
              ...previous,
              status: 'error',
              error: error instanceof Error ? error.message : t('reader.loadError'),
            }));
          } finally {
            setOpeningPath(null);
          }
        },
        [t],
      );

      const uploadPaper = useCallback(
        async (file) => {
          if (file.size > 80 * 1024 * 1024) {
            setUpload({ status: 'error', name: file.name, error: t('error.uploadLarge') });
            return;
          }
          setUpload({ status: 'loading', name: file.name, error: null });
          try {
            const response = await fetch(apiUrl('upload'), {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/pdf', 'x-paper-filename': encodeURIComponent(file.name) },
              body: await file.arrayBuffer(),
            });
            const data = await response.json().catch(() => null);
            if (!response.ok) throw new Error(data !== null && typeof data.error === 'string' ? data.error : `HTTP ${response.status}`);
            setUpload({ status: 'idle', name: '', error: null });
            await loadLibrary();
            await openPaper(data.path);
          } catch (error) {
            setUpload({
              status: 'error',
              name: file.name,
              error: error instanceof Error ? error.message : t('error.upload'),
            });
          }
        },
        [loadLibrary, openPaper, t],
      );

      useEffect(() => {
        let cancelled = false;
        (async () => {
          const data = await loadLibrary();
          if (cancelled || data === null) return;
          const last = readStored(STORAGE_LAST);
          if (last !== null && Array.isArray(data.entries) && data.entries.some((entry) => entry.path === last)) {
            openPaper(last);
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [loadLibrary, openPaper]);

      if (current !== null) {
        return h(Reader, {
          ctx,
          path: current.path,
          paper: current.paper,
          note: current.note,
          language,
          onLanguage: setLanguage,
          onBack: () => setCurrent(null),
          t,
        });
      }

      return h(
        'div',
        { className: 'ppr-root' },
        h('style', null, STYLE),
        h(
          'div',
          { className: 'ppr-header' },
          h(
            'div',
            { className: 'ppr-brand' },
            h('span', { className: 'ppr-brand-mark' }, h(PaperMark, { size: 15 })),
            t('page.title'),
          ),
          h('div', { className: 'ppr-spacer' }),
          h(
            'button',
            { type: 'button', className: 'ppr-chip', onClick: () => setLanguage(language === 'zh' ? 'en' : 'zh') },
            h(Icon, { path: ICONS.languages, size: 13 }),
            language === 'zh' ? '中文输出' : 'English output',
          ),
        ),
        h(Library, {
          library,
          query,
          onQuery: setQuery,
          onOpen: openPaper,
          onRefresh: loadLibrary,
          t,
          openingPath,
          onUpload: uploadPaper,
          upload,
          getProgress: (path) => {
            const page = Number(readStored(`ppr.page.${path}`));
            return Number.isInteger(page) && page > 0 ? page + 1 : 0;
          },
        }),
      );
    }

    function PanelIcon({ size = 16 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 64 64', 'aria-hidden': true, focusable: 'false' },
        h('rect', { x: 11, y: 5, width: 42, height: 54, rx: 7, fill: '#4f8dfd' }),
        h('path', { d: 'M41 5h5a7 7 0 0 1 7 7v6H41z', fill: '#ffffff', opacity: 0.55 }),
        h('g', { fill: '#ffffff', opacity: 0.92 },
          h('rect', { x: 19, y: 21, width: 26, height: 3.4, rx: 1.7 }),
          h('rect', { x: 19, y: 29, width: 26, height: 3.4, rx: 1.7, opacity: 0.82 }),
          h('rect', { x: 19, y: 37, width: 19, height: 3.4, rx: 1.7, opacity: 0.7 }),
        ),
        h('path', { d: 'M49 34.5l1.9 4.6 4.6 1.9-4.6 1.9-1.9 4.6-1.9-4.6-4.6-1.9 4.6-1.9z', fill: '#ffd166' }),
      );
    }

    /** Keep one render failure from blanking the slot silently. */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      render() {
        if (this.state.error !== null) {
          const message = String(this.state.error?.message ?? this.state.error);
          return React.createElement(
            'div',
            { style: { padding: '24px', color: 'var(--dsw-alias-state-error-primary)', fontSize: '13px' } },
            `PDF paper reader failed to render: ${message}`,
          );
        }
        return this.props.children;
      }
    }

    function PanelHost({ ctx }) {
      return h(PanelBoundary, null, h(PaperReaderApp, { ctx }));
    }

    // #endregion

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'pdf-paper-reader: dictionaries');
        const label = () => ctx.locale.bind(NS)('panel.label');
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
              inject: () => ({ ctx }),
            },
            PanelHost,
          ),
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 32,
              locale: NS,
              label,
            },
            PanelIcon,
          ),
        );
      },
    };
  },
});
