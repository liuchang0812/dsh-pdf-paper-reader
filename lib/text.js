/**
 * Text reconstruction for academic PDFs.
 *
 * pdf.js hands back a flat list of positioned text fragments per page. This
 * module turns those fragments into lines, detects a document-wide two-column
 * gutter, drops running headers/footers and page numbers, groups lines into
 * paragraphs, and classifies headings. Everything downstream (section slicing,
 * prompts, the page-text rail, the agent tools) reads this model.
 */

const PAGE_NUMBER_RE = /^(?:page\s*)?[-–—(]?\s*\d{1,4}\s*[-–—)]?$/i;
const NUMBERED_HEADING_RE = /^(?:\d{1,2}(?:\.\d{1,2}){0,3}\.?|[IVX]{1,4}\.)\s+\S/;
const KNOWN_HEADING_RE =
  /^(?:abstract|introduction|related work|background|preliminaries|method(?:s|ology)?|approach|model(?: architecture)?|architecture|experimental setup|experiments?|evaluation|results?(?: and (?:analysis|discussion))?|discussion|analysis|ablation(?: stud(?:y|ies))?|conclusion(?:s)?(?: and future work)?|future work|references|acknowledg(?:e)?ments?|appendix|limitations?|threats? to validity)\b/i;

/** Font sizes below this ratio to the body font are superscripts/footnotes clutter. */
const MIN_BODY_RATIO = 0.82;
/** A heading is at least this many times the body font size. */
const HEADING_SIZE_RATIO = 1.12;

/**
 * @typedef {object} PageLine
 * @property {string} text
 * @property {number} x left edge in PDF units
 * @property {number} y baseline in PDF units (origin bottom-left)
 * @property {number} size dominant font size
 * @property {number} width rendered width
 */

/**
 * @typedef {object} PageParagraph
 * @property {string} text
 * @property {number} page zero-based page index
 * @property {number} size dominant font size
 * @property {number} x left edge
 * @property {number} y baseline
 * @property {'heading'|'body'} kind
 */

/**
 * Turn raw pdf.js text items into lines ordered top to bottom.
 * @param {ReadonlyArray<{str?: string, transform?: number[], width?: number, height?: number}>} items fragments
 * @param {number} pageHeight page height in PDF units
 * @param {{gutter?: number}} [options] optional column gutter to split runs on
 * @returns {PageLine[]} lines in vertical order
 */
export function buildLines(items, pageHeight, options = {}) {
  /** @type {Array<{text: string, x: number, y: number, size: number, width: number}>} */
  const all = [];
  for (const item of items) {
    if (typeof item.str !== 'string' || item.str.length === 0) continue;
    if (!Array.isArray(item.transform) || item.transform.length < 6) continue;
    const transform = item.transform;
    const size = Math.abs(transform[3]) || Math.abs(item.height) || 10;
    const x = transform[4];
    const y = transform[5];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const width = Number.isFinite(item.width) ? item.width : 0;
    all.push({ text: normalizeFragment(item.str), x, y, size, width });
  }
  if (all.length === 0) return [];

  // Drop figure axis labels, superscripts and footnote-type fragments: text far
  // smaller than the page's dominant size, unless it is a sizeable run that is
  // itself the page's content.
  const weights = new Map();
  for (const fragment of all) {
    const key = Math.round(fragment.size * 2) / 2;
    weights.set(key, (weights.get(key) ?? 0) + fragment.text.length);
  }
  const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1]);
  const dominant = ranked[0]?.[0] ?? 10;
  const fragments = all.filter((fragment) => fragment.size >= dominant * 0.62 || fragment.text.length > 24);

  fragments.sort((a, b) => b.y - a.y || a.x - b.x);

  /** @type {Array<{y: number, size: number, parts: typeof fragments}>} */
  const rows = [];
  for (const fragment of fragments) {
    const tolerance = Math.max(1.4, fragment.size * 0.32);
    let row = null;
    for (let index = rows.length - 1; index >= 0 && index >= rows.length - 8; index -= 1) {
      const candidate = rows[index];
      if (Math.abs(candidate.y - fragment.y) <= Math.max(tolerance, candidate.size * 0.32)) {
        row = candidate;
        break;
      }
    }
    if (row === null) {
      row = { y: fragment.y, size: fragment.size, parts: [] };
      rows.push(row);
    }
    row.parts.push(fragment);
    row.y = (row.y * (row.parts.length - 1) + fragment.y) / row.parts.length;
    row.size = Math.max(row.size, fragment.size);
  }

  /** @type {PageLine[]} */
  const lines = [];
  for (const row of rows) {
    row.parts.sort((a, b) => a.x - b.x);
    /** @type {typeof row.parts} */
    const kept = [];
    let previousEnd = Number.NEGATIVE_INFINITY;
    for (const part of row.parts) {
      // Drop overlap duplicates produced by bold/italic shadow runs.
      if (part.x + part.width * 0.5 < previousEnd && kept.length > 0) {
        const last = kept[kept.length - 1];
        if (part.text.length > last.text.length && Math.abs(part.x - last.x) < 1.5) {
          kept[kept.length - 1] = part;
          previousEnd = part.x + part.width;
        }
        continue;
      }
      kept.push(part);
      previousEnd = Math.max(previousEnd, part.x + part.width);
    }

    // Split a visual row where the horizontal gap is far wider than a word
    // space: that is a column gutter, a table cell boundary, or a figure label
    // sitting beside the body text, never one sentence.
    /** @type {typeof row.parts} */
    let run = [];
    const emit = () => {
      if (run.length === 0) return;
      const line = runToLine(run);
      if (line !== null) lines.push(line);
      run = [];
    };
    for (const part of kept) {
      if (run.length > 0) {
        const previous = run[run.length - 1];
        const gap = part.x - (previous.x + previous.width);
        const crossesGutter =
          options.gutter !== undefined &&
          previous.x + previous.width <= options.gutter - 1 &&
          part.x >= options.gutter + 1;
        if (gap > Math.max(9, part.size * 1.7) || crossesGutter) emit();
      }
      run.push(part);
    }
    emit();
  }

  return dropPageNumbers(
    [...lines].sort((a, b) => b.y - a.y || a.x - b.x),
    pageHeight,
  );
}

/**
 * Join one horizontal run of fragments into a line.
 * @param {{text: string, x: number, y: number, size: number, width: number}[]} parts fragments sorted by x
 * @returns {PageLine | null} the line, or null when it carries no text
 */
function runToLine(parts) {
  let text = '';
  let previous = null;
  for (const part of parts) {
    if (previous !== null) {
      const gap = part.x - (previous.x + previous.width);
      const needsSpace = gap > Math.max(0.9, part.size * 0.16) && !/\s$/.test(text) && !/^\s/.test(part.text);
      if (needsSpace) text += ' ';
    }
    text += part.text;
    previous = part;
  }
  text = collapseSpaces(text).trim();
  if (text.length === 0) return null;
  const first = parts[0];
  const last = parts[parts.length - 1];
  return {
    text,
    x: first.x,
    y: (first.y + last.y) / 2,
    size: Math.max(...parts.map((part) => part.size)),
    width: Math.max(0, last.x + last.width - first.x),
  };
}

/**
 * Detect a document-wide column gutter. Two-column papers repeat the same two
 * left edges on almost every page; single-column papers have one. Using the
 * whole document is far more stable than judging one page with a wide figure.
 * @param {{width: number, height: number, lines: PageLine[]}[]} pages page layouts
 * @param {number} bodySize estimated body font size
 * @returns {number | undefined} the gutter x coordinate, or undefined for one column
 */
export function detectGutter(pages, bodySize) {
  if (pages.length < 2) return undefined;
  const pageWidth = Math.max(...pages.map((page) => page.width));
  if (!Number.isFinite(pageWidth) || pageWidth <= 0) return undefined;

  /** @type {Array<{page: number, x: number, right: number}>} */
  const starts = [];
  for (const page of pages) {
    for (const line of page.lines) {
      if (line.text.length < 28) continue;
      if (line.size > bodySize * 1.12) continue;
      if (line.size < bodySize * 0.78) continue;
      starts.push({ page: page.index, x: line.x, right: line.x + line.width });
    }
  }
  if (starts.length < 40) return undefined;

  const minX = Math.min(...starts.map((entry) => entry.x));
  const span = pageWidth - minX;
  const binSize = Math.max(2, span * 0.01);
  const bins = new Map();
  for (const entry of starts) {
    const bin = Math.floor((entry.x - minX) / binSize);
    const current = bins.get(bin) ?? { count: 0, xs: [] };
    current.count += 1;
    current.xs.push(entry);
    bins.set(bin, current);
  }
  const ranked = [...bins.entries()]
    .map(([bin, value]) => ({ bin, x: minX + (bin + 0.5) * binSize, ...value }))
    .sort((a, b) => b.count - a.count);
  if (ranked.length < 2) return undefined;

  // Pick the strongest pair of well-separated left edges. The right column can
  // easily be the most frequent start (its lines rarely end short), so scan
  // pairs instead of assuming the first peak is the left column.
  let left = null;
  let right = null;
  let score = -1;
  const peaks = ranked.slice(0, 8);
  for (const candidateLeft of peaks) {
    if (candidateLeft.x > minX + span * 0.52) continue;
    for (const candidateRight of peaks) {
      if (candidateRight.x - candidateLeft.x <= span * 0.18) continue;
      const pairScore = Math.min(candidateLeft.count, candidateRight.count);
      if (pairScore > score) {
        score = pairScore;
        left = candidateLeft;
        right = candidateRight;
      }
    }
  }
  if (left === null || right === null) return undefined;

  const pagesWith = (target) => new Set(target.xs.map((entry) => entry.page)).size;
  if (pagesWith(right) < pages.length * 0.45) return undefined;
  if (right.count < left.count * 0.3) return undefined;
  if (right.x > left.x + span * 0.85) return undefined;

  // Full-width lines (titles, captions) can also begin at the left margin, so
  // only body lines that end before the right column define the left edge.
  const leftColumn = starts.filter(
    (entry) => Math.abs(entry.x - left.x) <= span * 0.05 && entry.right < right.x,
  );
  if (leftColumn.length < 10) return undefined;
  const leftRight = Math.max(...leftColumn.map((entry) => entry.right));
  if (right.x - leftRight < span * 0.02) return undefined;
  return (leftRight + right.x) / 2;
}

/**
 * Reorder one page's lines into reading order: bands separated by full-width
 * lines read left column first, then right column.
 * @param {PageLine[]} lines lines in vertical order
 * @param {number | undefined} gutter document gutter x, when two-column
 * @returns {PageLine[]} lines in reading order
 */
export function applyReadingOrder(lines, gutter) {
  if (gutter === undefined || lines.length === 0) {
    return [...lines].sort((a, b) => b.y - a.y || a.x - b.x);
  }
  /** @type {PageLine[]} */
  const ordered = [];
  /** @type {PageLine[]} */
  let bandLeft = [];
  /** @type {PageLine[]} */
  let bandRight = [];
  const flushBand = () => {
    bandLeft.sort((a, b) => b.y - a.y || a.x - b.x);
    bandRight.sort((a, b) => b.y - a.y || a.x - b.x);
    ordered.push(...bandLeft, ...bandRight);
    bandLeft = [];
    bandRight = [];
  };
  const sorted = [...lines].sort((a, b) => b.y - a.y || a.x - b.x);
  for (const line of sorted) {
    const crosses = line.x < gutter - 2 && line.x + line.width > gutter + 2;
    if (crosses) {
      flushBand();
      ordered.push(line);
      continue;
    }
    if (line.x + line.width <= gutter + 2) bandLeft.push(line);
    else bandRight.push(line);
  }
  flushBand();
  return ordered;
}

/**
 * Detect running headers/footers by finding lines repeated near the top or
 * bottom of several pages, then drop them from the supplied layouts.
 * @param {Array<{height: number, lines: PageLine[]}>} pages mutable page layouts
 */
export function dropRepeatedMargins(pages) {
  if (pages.length < 3) return;
  /** @type {Map<string, {top: number, bottom: number}>} */
  const seen = new Map();
  for (const page of pages) {
    const keys = new Set();
    for (const line of page.lines) {
      const isTop = line.y > page.height * 0.9;
      const isBottom = line.y < page.height * 0.1;
      if (!isTop && !isBottom) continue;
      keys.add(`${isTop ? 't' : 'b'}:${line.text.replace(/\d+/g, '#').toLowerCase()}`);
    }
    for (const key of keys) {
      const entry = seen.get(key) ?? { top: 0, bottom: 0 };
      if (key.startsWith('t:')) entry.top += 1;
      else entry.bottom += 1;
      seen.set(key, entry);
    }
  }
  const threshold = Math.max(2, Math.ceil(pages.length * 0.34));
  const repeated = new Set();
  for (const [key, counts] of seen) {
    if (counts.top >= threshold || counts.bottom >= threshold) repeated.add(key);
  }
  if (repeated.size === 0) return;
  for (const page of pages) {
    page.lines = page.lines.filter((line) => {
      const isTop = line.y > page.height * 0.9;
      const isBottom = line.y < page.height * 0.1;
      if (!isTop && !isBottom) return true;
      return !repeated.has(`${isTop ? 't' : 'b'}:${line.text.replace(/\d+/g, '#').toLowerCase()}`);
    });
  }
}

function dropPageNumbers(lines, pageHeight) {
  return lines.filter((line) => {
    if (!PAGE_NUMBER_RE.test(line.text)) return true;
    // Only drop numeric lines that sit in the header/footer band.
    return !(line.y < pageHeight * 0.09 || line.y > pageHeight * 0.93);
  });
}

function normalizeFragment(text) {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/[\u2010\u2011]/g, '-');
}

function collapseSpaces(text) {
  return text.replace(/[ \t]{2,}/g, ' ');
}

/**
 * Weighted median font size: body text dominates by character count, so the
 * result is insensitive to titles, footnotes and figure labels.
 * @param {PageLine[]} lines page lines
 * @returns {number} estimated body font size
 */
export function estimateBodySize(lines) {
  if (lines.length === 0) return 10;
  const weights = new Map();
  for (const line of lines) {
    const size = Math.round(line.size * 2) / 2;
    weights.set(size, (weights.get(size) ?? 0) + line.text.length);
  }
  const entries = [...weights.entries()].sort((a, b) => b[1] - a[1]);
  return entries[0]?.[0] ?? 10;
}

/**
 * Group page lines into paragraphs and mark headings.
 * @param {PageLine[]} lines lines in reading order
 * @param {number} bodySize estimated body font size
 * @returns {PageParagraph[]} paragraphs
 */
export function buildParagraphs(lines, bodySize) {
  /** @type {PageParagraph[]} */
  const paragraphs = [];
  /** @type {PageLine[]} */
  let current = [];

  const flush = () => {
    if (current.length === 0) return;
    const text = joinLines(current);
    if (text.length === 0) {
      current = [];
      return;
    }
    const first = current[0];
    const maxSize = Math.max(...current.map((line) => line.size));
    const kind = classifyHeading(current, bodySize) ? 'heading' : 'body';
    paragraphs.push({
      text,
      page: -1,
      size: Math.round(maxSize * 10) / 10,
      x: Math.round(first.x * 10) / 10,
      y: first.y,
      kind,
    });
    current = [];
  };

  for (const line of lines) {
    if (line.size < bodySize * MIN_BODY_RATIO) {
      // Footnotes, superscripts, captions in tiny type: keep them attached.
      if (current.length > 0) current.push(line);
      continue;
    }
    if (classifyHeading([line], bodySize)) {
      // A heading owns its paragraph: never let the next body line merge into
      // it, otherwise the heading is lost to the line-length check.
      flush();
      current.push(line);
      flush();
      continue;
    }
    if (current.length === 0) {
      current.push(line);
      continue;
    }
    const previous = current[current.length - 1];
    const lineHeight = Math.max(previous.size, line.size) * 1.15;
    const gap = previous.y - line.y;
    const sizeChanged = Math.abs(previous.size - line.size) > Math.max(0.6, bodySize * 0.06);
    const indented = line.x - current[0].x > bodySize * 0.9;
    const newParagraph =
      gap > lineHeight * 1.75 || gap < -lineHeight * 0.5 || sizeChanged || (indented && gap > lineHeight * 1.1);
    if (newParagraph) flush();
    current.push(line);
  }
  flush();
  return paragraphs;
}

function joinLines(lines) {
  let text = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const piece = line.text;
    if (index > 0) {
      if (text.endsWith('-') && /^[a-z]/.test(piece)) {
        // De-hyphenate a word split across lines.
        text = text.slice(0, -1);
      } else if (!/[-–—/]$/.test(text) && !/^[)\].,;:!?]/.test(piece)) {
        text += /[\u4e00-\u9fff]/.test(text.slice(-1)) ? '' : ' ';
      }
    }
    text += piece;
  }
  return collapseSpaces(text).trim();
}

function classifyHeading(lines, bodySize) {
  if (lines.length === 0) return false;
  const text = lines.map((line) => line.text).join(' ').trim();
  if (text.length === 0 || text.length > 120) return false;
  if (/provided proper attribution|google hereby grants|reproduce the tables|scholarly works/i.test(text)) return false;
  if (/[.;:,]\s*$/.test(text) && !/^(?:\d+\.?\s+)?(?:abstract|introduction)/i.test(text)) return false;
  const maxSize = Math.max(...lines.map((line) => line.size));
  const sizeHeading = maxSize >= bodySize * HEADING_SIZE_RATIO;
  const digits = (text.match(/\d/g) ?? []).length;
  const letterWords = text.split(/\s+/).filter((word) => /^[A-Za-z][A-Za-z'-]{2,}$/.test(word)).length;
  // A table row or equation number is not a heading: headings are mostly words.
  if (letterWords === 0 || digits / text.length > 0.3) return false;
  const short = text.split(' ').length <= 14;
  const CONNECTORS = new Set(['and', 'of', 'for', 'in', 'on', 'to', 'with', 'via', 'using', 'from', 'the', 'a', 'an', 'is', 'are', 'be', 'by', 'at', 'as', 'or', 'vs', 'under', 'over', 'from', 'into', 'between']);
  const strayLowerWords = text
    .replace(/^(?:\d+(?:\.\d+)*|[IVX]+)[.)]?\s+/i, '')
    .split(/\s+/)
    .filter((word) => /^[a-z][a-z-]{1,}$/.test(word) && !CONNECTORS.has(word)).length;
  const numbered =
    NUMBERED_HEADING_RE.test(text) &&
    short &&
    strayLowerWords <= 1 &&
    maxSize >= bodySize * 0.97 &&
    /^[A-Z]/.test(text.replace(/^(?:\d+(?:\.\d+)*|[IVX]+)[.)]?\s+/i, '')) &&
    !/^[\d.]/.test(text.replace(/^(?:\d+(?:\.\d+)*|[IVX]+)[.)]?\s+/i, ''));
  const stripped = text.replace(/^(?:\d+(?:\.\d+)*|[IVX]+)[.)]?\s+/i, '').trim();
  const known =
    /^(?:abstract|introduction|related work|background|preliminaries|methodology|methods?|approach|model|architecture|experimental setup|experiments?|evaluation|results?|discussion|analysis|ablation(?: study| studies)?|conclusions?|future work|references|acknowledg(?:e)?ments?|appendix|limitations?|threats to validity)$/i.test(
      stripped,
    ) &&
    text.length <= 64 &&
    /^[A-Z]/.test(text);
  const caps =
    text.length >= 6 &&
    text.length <= 64 &&
    letterWords >= 1 &&
    /^[A-Z][A-Z0-9\s&:/-]+$/.test(text) &&
    !/-$/.test(text) &&
    (sizeHeading || text.split(' ').length >= 2);
  if (!sizeHeading && !numbered && !known && !caps) return false;
  if (lines.length > 2) return false;
  if (/-$/.test(text)) return false;
  return true;
}

/**
 * Find the abstract text from paragraphs, preferring an explicit Abstract
 * heading and falling back to the leading prose on page one.
 * @param {PageParagraph[]} paragraphs ordered paper paragraphs
 * @returns {string} abstract text
 */
export function findAbstract(paragraphs) {
  const headingIndex = paragraphs.findIndex(
    (paragraph) => paragraph.frontMatter !== true && /^abstract\b/i.test(paragraph.text),
  );
  if (headingIndex >= 0) {
    const collected = [];
    for (let index = headingIndex + 1; index < paragraphs.length; index += 1) {
      const paragraph = paragraphs[index];
      if (paragraph.kind === 'heading' && collected.length > 0) break;
      collected.push(paragraph.text.replace(/^abstract[\s.:—-]+/i, ''));
      if (collected.join(' ').length > 2600) break;
    }
    const text = collected.join(' ').trim();
    if (text.length > 120) return text;
  }
  // Some templates put the abstract in a wide single paragraph without a
  // standalone heading; take the first substantial paragraphs.
  const collected = [];
  for (const paragraph of paragraphs) {
    if (paragraph.kind === 'heading' || paragraph.frontMatter === true) continue;
    if (paragraph.text.length < 180) continue;
    collected.push(paragraph.text);
    if (collected.join(' ').length > 1800) break;
  }
  return collected.join(' ').trim().slice(0, 2600);
}

/**
 * Segment the paper into sections using detected headings. Outline titles from
 * the PDF bookmark tree are used when they match a detected heading, so the
 * reader shows the paper's own section names.
 * @param {PageParagraph[]} paragraphs ordered paragraphs
 * @param {{title: string, page: number, level: number}[]} outline parsed bookmark tree
 * @returns {{title: string, level: number, page: number, paragraphs: string[], text: string}[]} sections
 */
export function buildSections(paragraphs, outline) {
  const sections = [];
  let current = null;
  for (const paragraph of paragraphs) {
    if (paragraph.frontMatter === true) continue;
    if (paragraph.kind === 'heading') {
      current = {
        title: cleanHeading(paragraph.text),
        level: headingLevel(paragraph.text),
        page: paragraph.page,
        paragraphs: [],
        text: '',
      };
      sections.push(current);
      continue;
    }
    if (current !== null) current.paragraphs.push(paragraph.text);
  }
  for (const section of sections) section.text = section.paragraphs.join('\n\n');

  if (sections.length >= 3) {
    applyOutlineTitles(sections, outline);
    const useOutline = outline.filter((entry) => !/^references$/i.test(entry.title)).length >= 4;
    return sections.filter((section) => {
      // Bookmark titles often differ from visual headings ("2 Approach" vs
      // "Methodology"); keep substantive numbered sections even when unmatched,
      // and drop the empty/table fragments that figure labels produce.
      if (section.outlineMatched === true || /^abstract$/i.test(section.title)) return true;
      if (useOutline) {
        if (/^references$/i.test(section.title)) return true;
        return /^\d+\.?\d*\.?\s/.test(section.title) && section.text.trim().length >= 200;
      }
      return section.text.length > 0 || section.title.length > 0;
    });
  }

  // Heading detection failed (scanned or unusual PDF): fall back to the
  // bookmark tree by locating each title in the page text.
  if (outline.length > 0) {
    const full = paragraphs.map((paragraph) => paragraph.text).join('\n\n');
    const usable = outline
      .map((entry) => ({ ...entry, index: full.indexOf(entry.title) }))
      .filter((entry) => entry.index >= 0);
    if (usable.length > 0) {
      return usable.map((entry, index) => {
        const next = usable[index + 1];
        const text = full.slice(entry.index + entry.title.length, next?.index ?? full.length).trim();
        return { title: entry.title, level: entry.level, page: entry.page, paragraphs: [text], text };
      });
    }
  }
  return sections;
}

function applyOutlineTitles(sections, outline) {
  if (outline.length === 0) return;
  const used = new Set();
  for (const section of sections) {
    let best = null;
    for (const entry of outline) {
      if (used.has(entry.title)) continue;
      if (sameHeading(section.title, entry.title)) {
        best = entry;
        break;
      }
    }
    if (best !== null) {
      used.add(best.title);
      section.title = best.title;
      section.level = best.level;
      section.outlineMatched = true;
      if (Number.isFinite(best.page)) section.page = best.page;
    }
  }
}

function sameHeading(a, b) {
  const normalize = (value) =>
    value
      .toLowerCase()
      .replace(/^[\d.]+\s*/, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const left = normalize(a);
  const right = normalize(b);
  if (left.length === 0 || right.length === 0) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function cleanHeading(text) {
  return text.replace(/\s+/g, ' ').replace(/[\s.:]+$/, '').trim();
}

function headingLevel(text) {
  const match = /^(\d+(?:\.\d+)*)[.)]?\s+/.exec(text);
  if (match !== null) return match[1].split('.').length;
  if (/^[IVX]+\.\s+/.test(text)) return 1;
  return 1;
}

/**
 * Split a page's paragraphs into a plain selectable text block with a blank
 * line between paragraphs.
 * @param {PageParagraph[]} paragraphs page paragraphs
 * @returns {string} page text
 */
export function paragraphsToText(paragraphs) {
  return paragraphs
    .map((paragraph) => paragraph.text)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
