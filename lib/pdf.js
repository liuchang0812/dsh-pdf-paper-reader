/**
 * PDF ingestion: parse bytes with pdf.js (Node legacy build), reconstruct page
 * text, resolve the bookmark outline, and derive title, authors, abstract and
 * section structure.
 *
 * Parsing is pure CPU work on the Host; the browser receives a compact model.
 */

import pdfjsLib from './load-pdfjs.cjs';
import {
  applyReadingOrder,
  buildLines,
  buildParagraphs,
  detectGutter,
  buildSections,
  dropRepeatedMargins,
  estimateBodySize,
  findAbstract,
  paragraphsToText,
} from './text.js';

/**
 * @typedef {object} ParsedPaper
 * @property {string} title
 * @property {string} authors
 * @property {number} pageCount
 * @property {number} bodySize
 * @property {string} abstract
 * @property {{index: number, width: number, height: number, text: string}[]} pages
 * @property {{title: string, level: number, page: number, text: string}[]} sections
 * @property {string} fullText
 * @property {string[]} outlineTitles
 */

/**
 * Parse one PDF buffer.
 * @param {Uint8Array} data PDF bytes
 * @returns {Promise<ParsedPaper>} the parsed paper model
 */
export async function parsePdf(data) {
  const loadingTask = pdfjsLib.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    disableAutoFetch: true,
    disableStream: true,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  try {
    const pageCount = doc.numPages;
    const metadata = await doc.getMetadata().catch(() => null);
    const outline = await readOutline(doc);
    const pages = [];
    for (let index = 1; index <= pageCount; index += 1) {
      const page = await doc.getPage(index);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        pages.push({
          index: index - 1,
          width: viewport.width,
          height: viewport.height,
          items: content.items,
          lines: buildLines(content.items, viewport.height),
        });
      } finally {
        page.cleanup();
      }
    }

    dropRepeatedMargins(pages);
    dropLicenseNotices(pages);
    const firstPassLines = pages.flatMap((page) => page.lines);
    const firstPassBodySize = estimateBodySize(firstPassLines);
    const gutter = detectGutter(pages, firstPassBodySize);
    // Re-run the line pass with the known gutter so a short left-column line
    // never swallows the right column's first fragment, then re-apply the
    // margin/license filters the rebuild discarded.
    for (const page of pages) {
      if (gutter !== undefined) page.lines = buildLines(page.items, page.height, { gutter });
      delete page.items;
    }
    dropRepeatedMargins(pages);
    dropLicenseNotices(pages);
    dropTableOfContents(pages);
    const bodySize = estimateBodySize(
      pages.flatMap((page) => page.lines),
    );
    const paragraphs = [];
    for (const page of pages) {
      page.lines = applyReadingOrder(page.lines, gutter);
      const pageParagraphs = buildParagraphs(page.lines, bodySize);
      for (const paragraph of pageParagraphs) paragraph.page = page.index;
      page.paragraphs = pageParagraphs;
      page.text = paragraphsToText(pageParagraphs);
      paragraphs.push(...pageParagraphs);
    }

    const { title, authors } = detectFrontMatter(pages, paragraphs, bodySize, metadata);
    markFrontMatter(paragraphs, title, authors);
    const abstract = findAbstract(paragraphs);
    const sections = buildSections(paragraphs, outline);
    const fullText = pages
      .map((page) => `[Page ${page.index + 1}]\n${page.text}`)
      .join('\n\n')
      .trim();

    return {
      title: title.length > 0 ? title : 'Untitled paper',
      authors,
      pageCount,
      bodySize,
      abstract,
      pages,
      sections,
      fullText,
      outlineTitles: outline.map((entry) => entry.title),
    };
  } finally {
    await doc.destroy().catch(() => {});
  }
}

/**
 * Compact wire form for the browser: text without the layout internals.
 * @param {ParsedPaper} paper parsed paper
 * @returns {object} JSON-safe document
 */
export function toWirePaper(paper) {
  return {
    title: paper.title,
    authors: paper.authors,
    pageCount: paper.pageCount,
    abstract: paper.abstract,
    bodySize: paper.bodySize,
    pages: paper.pages.map((page) => ({
      index: page.index,
      width: Math.round(page.width),
      height: Math.round(page.height),
      text: page.text,
    })),
    sections: paper.sections.map((section) => ({
      title: section.title,
      level: section.level,
      page: section.page,
    })),
    outlineTitles: paper.outlineTitles,
    fullTextLength: paper.fullText.length,
  };
}

/**
 * Flatten the PDF bookmark tree into a page-resolved list.
 * @param {any} doc pdf.js document
 * @returns {Promise<{title: string, page: number, level: number}[]>} outline entries
 */
async function readOutline(doc) {
  let raw = null;
  try {
    raw = await doc.getOutline();
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const entries = [];
  const walk = async (items, level) => {
    for (const item of items) {
      if (entries.length >= 200) return;
      const title = typeof item?.title === 'string' ? item.title.replace(/\s+/g, ' ').trim() : '';
      let page = Number.NaN;
      if (title.length > 0 && item.dest !== undefined && item.dest !== null) {
        page = await resolveDestination(doc, item.dest);
      }
      if (title.length > 0) entries.push({ title, page, level: level + 1 });
      if (Array.isArray(item?.items) && level < 3) await walk(item.items, level + 1);
    }
  };
  await walk(raw, 0);
  return entries.filter((entry) => entry.title.length > 0);
}

async function resolveDestination(doc, dest) {
  try {
    const target = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(target) || target.length === 0) return Number.NaN;
    const ref = target[0];
    if (typeof ref === 'number') return Math.max(0, ref);
    return await doc.getPageIndex(ref);
  } catch {
    return Number.NaN;
  }
}

function fallbackTitle(metadata) {
  const info = metadata?.info ?? {};
  if (typeof info.Title === 'string' && info.Title.trim().length > 2) return info.Title.trim();
  return '';
}

/**
 * Drop license notices, arXiv stamps and preprint headers that survive the
 * layout pass as text but are not paper content.
 * @param {any[]} pages page layouts (mutated)
 */
function dropLicenseNotices(pages) {
  const notice = /provided proper attribution|google hereby grants|reproduce the tables|scholarly works/i;
  const stamp = /^(?:arxiv:\d|\[cs\.|doi:|https?:\/\/arxiv|preprint)/i;
  for (const page of pages) {
    page.lines = page.lines.filter((line) => !stamp.test(line.text.trim()) && !notice.test(line.text));
  }
}

/**
 * Guess the paper title (largest front-matter type) and author line.
 * @param {any[]} pages page layouts
 * @param {any[]} paragraphs all paragraphs
 * @param {number} bodySize body font size
 * @param {any} metadata pdf.js metadata
 * @returns {{title: string, authors: string}} front matter
 */
function detectFrontMatter(pages, paragraphs, bodySize, metadata) {
  const metaTitle = fallbackTitle(metadata);
  const firstPage = pages[0];
  if (firstPage === undefined) return { title: metaTitle, authors: '' };

  let best = null;
  for (const line of firstPage.lines) {
    if (line.size < bodySize * 1.25) continue;
    if (line.text.length < 4 || line.text.length > 220) continue;
    if (/^(arxiv|preprint|doi|http|www\.)/i.test(line.text)) continue;
    if (best === null || line.size > best.size + 0.4) best = line;
  }
  if (best === null) {
    return { title: metaTitle, authors: inferAuthors(firstPage, paragraphs, bodySize) };
  }

  const titleBlocks = [best.text];
  for (const line of firstPage.lines) {
    if (line === best) continue;
    if (line.size < best.size * 0.92) continue;
    if (line.text.length < 2) continue;
    if (line.y > best.y - 0.5) continue;
    if (Math.abs(line.y - best.y) > best.size * 1.8) continue;
    titleBlocks.push(line.text);
  }
  const title = titleBlocks.join(' ').replace(/\s+/g, ' ').trim();
  const authors = inferAuthors(firstPage, paragraphs, bodySize, best);
  return { title: title.length > 2 ? title : metaTitle, authors };
}

/**
 * Strip emails, affiliation boilerplate and numeric markers from a raw author
 * block so the header shows people, not the whole front matter.
 * @param {string} raw author text
 * @returns {string} cleaned author line
 */
function cleanAuthors(raw) {
  let text = raw
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\S*@\S+/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(
      /\b(?:Google|Brain|Research|University|Institute|Microsoft|Corporation|Inc|Ltd|DeepMind|Facebook|Meta|OpenAI|Amazon|NVIDIA|Stanford|Berkeley|Carnegie|Mellon|MIT|CSAIL|Laboratory|Labs?|Department|School|College|Center|Centre|Beijing|Shanghai|Hangzhou|Shenzhen|Tokyo|Paris|London|Zurich|Seattle|Allen|AI|ML|Language)\b\.?/g,
      ' ',
    )
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[,;]\s*/g, ', ')
    .replace(/^[\s,;]+|[\s,;]+$/g, ' ');
  // Drop leftover affiliation fragments such as "of Toronto" or "for AI".
  for (let pass = 0; pass < 3; pass += 1) {
    const next = text.replace(/\b(?:of|for|at)\s+[A-Z][\w.]*\b/g, ' ').replace(/\s{2,}/g, ' ');
    if (next === text) break;
    text = next;
  }
  return text
    .replace(/\b(?:of|for|at|and|the)\b/g, ' ')
    .replace(/\s*,\s*(?=,)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;]+|[\s,;]+$/g, '')
    .slice(0, 260);
}

function inferAuthors(firstPage, paragraphs, bodySize, titleLine = null) {
  const titleSize = titleLine?.size ?? bodySize * 1.8;
  const titleY = titleLine?.y ?? Number.POSITIVE_INFINITY;
  const collect = [];
  for (const line of firstPage.lines) {
    if (line.size >= titleSize * 0.92) continue;
    if (line.size < bodySize * 0.8) continue;
    if (line.y > titleY) continue;
    if (titleY - line.y > titleSize * 8) continue;
    if (line.text.length > 180) break;
    if (/^abstract\b/i.test(line.text)) break;
    collect.push(line.text);
    if (collect.length >= 6) break;
  }
  if (collect.length > 0) {
    const cleaned = cleanAuthors(collect.join(' '));
    if (cleaned.length > 2) return cleaned;
  }
  const authorParagraph = paragraphs.find(
    (paragraph) =>
      paragraph.page === 0 &&
      paragraph.frontMatter !== true &&
      /^[A-Z][a-z]+ [A-Z][a-z]+/.test(paragraph.text) &&
      paragraph.text.length < 200,
  );
  return authorParagraph === undefined ? '' : cleanAuthors(authorParagraph.text);
}

/**
 * Remove table-of-contents pages: dot-led entries with page numbers would
 * otherwise be read as section headings and shadow the real body outline.
 * @param {any[]} pages page layouts (mutated)
 */
function dropTableOfContents(pages) {
  const entry = /(?:\.\s*){4,}\d+\s*$/;
  for (const page of pages) {
    const lines = page.lines;
    if (lines.length === 0) continue;
    const tocCount = lines.filter((line) => entry.test(line.text)).length;
    if (tocCount >= 5) {
      page.lines = [];
      page.isTableOfContents = true;
      continue;
    }
    if (tocCount > 0) page.lines = lines.filter((line) => !entry.test(line.text));
  }
}

/**
 * Title, author and affiliation paragraphs are not sections; mark them so
 * section building and abstract discovery ignore them.
 * @param {any[]} paragraphs ordered paragraphs (mutated)
 * @param {string} title detected title
 * @param {string} authors detected author line
 */
function markFrontMatter(paragraphs, title, authors) {
  const abstractIndex = paragraphs.findIndex(
    (paragraph) => paragraph.page === 0 && /^abstract\b/i.test(paragraph.text),
  );
  if (abstractIndex > 0) {
    for (let index = 0; index < abstractIndex; index += 1) {
      if (paragraphs[index].page === 0) paragraphs[index].frontMatter = true;
    }
  }
  const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const titleKey = normalize(title);
  const surname = authors.split(/[\s,]+/).find((word) => /^[A-Z][a-z]{2,}$/.test(word)) ?? '';
  for (const paragraph of paragraphs) {
    if (paragraph.page !== 0) continue;
    const key = normalize(paragraph.text);
    const isTitle =
      titleKey.length > 6 &&
      (key === titleKey || key.startsWith(titleKey) || (key.length > 20 && titleKey.startsWith(key)));
    const isAuthor =
      paragraph.text.includes('@') || (surname.length > 2 && key.includes(surname.toLowerCase()) && key.length < 240);
    if (isTitle || isAuthor) paragraph.frontMatter = true;
  }
}
