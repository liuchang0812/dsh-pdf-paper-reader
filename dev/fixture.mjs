/**
 * Generate a small, self-contained test PDF so the route check needs no sample
 * papers checked into the repository.
 *
 * The document deliberately contains the parts the reader relies on: a large
 * title line, an author line, "Abstract"/numbered section headings, body
 * paragraphs with numbers that must reach the digest, and a References heading.
 *
 * @returns {Uint8Array} PDF file bytes
 */

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

/**
 * Escape a string for a PDF literal string object.
 * @param {string} text raw text
 * @returns {string} escaped text
 */
function escapeText(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Build the content stream of one page.
 * @param {{text: string, size: number, y: number}[]} lines positioned lines
 * @returns {string} page content stream
 */
function pageContent(lines) {
  const parts = [];
  for (const line of lines) {
    parts.push(`BT /F1 ${line.size} Tf 1 0 0 1 72 ${line.y} Tm (${escapeText(line.text)}) Tj ET`);
  }
  return parts.join('\n');
}

const PAGES = [
  [
    { text: 'A Small Paper About Efficient Readers', size: 20, y: 720 },
    { text: 'Ada Lovelace, Grace Hopper', size: 12, y: 690 },
    { text: 'Abstract', size: 13, y: 650 },
    { text: 'We propose a structured reading pipeline for computer science', size: 11, y: 630 },
    { text: 'papers. The pipeline reconstructs section structure, extracts', size: 11, y: 616 },
    { text: 'readable text and generates grounded reading notes for readers.', size: 11, y: 602 },
    { text: '1 Introduction', size: 13, y: 560 },
    { text: 'Reading papers is slow. Our pipeline improves the reading', size: 11, y: 540 },
    { text: 'experience by combining a PDF viewer, selectable text and a', size: 11, y: 526 },
    { text: 'grounded summary assistant. It never invents numbers.', size: 11, y: 512 },
  ],
  [
    { text: '2 Method', size: 13, y: 720 },
    { text: 'The method has two stages. First we reconstruct lines and', size: 11, y: 700 },
    { text: 'paragraphs from positioned text fragments. Then we classify', size: 11, y: 686 },
    { text: 'headings and build a section aware digest for the model.', size: 11, y: 672 },
    { text: '2.1 Details', size: 13, y: 640 },
    { text: 'A document wide gutter detector handles two column papers.', size: 11, y: 620 },
    { text: 'Running headers and table of contents pages are removed.', size: 11, y: 606 },
  ],
  [
    { text: '3 Experiments', size: 13, y: 720 },
    { text: 'We evaluate on six papers. The pipeline reaches a BLEU score', size: 11, y: 700 },
    { text: 'of 28.4 in our paraphrase test and extracts 98 percent of', size: 11, y: 686 },
    { text: 'the section headings correctly. Table 1 lists all results.', size: 11, y: 672 },
    { text: '4 Conclusion', size: 13, y: 640 },
    { text: 'A structured reading pipeline makes paper reading faster and', size: 11, y: 620 },
    { text: 'the generated notes stay grounded in the source text.', size: 11, y: 606 },
    { text: 'References', size: 13, y: 570 },
    { text: '[1] A. Reader. Structured reading. In Proc. of Tests, 2024.', size: 11, y: 550 },
  ],
];

/**
 * Assemble the PDF objects, cross-reference table and trailer.
 * @returns {Uint8Array} PDF bytes
 */
export function createFixturePdf() {
  const objects = [];
  const pageObjectNumbers = PAGES.map((_, index) => 4 + index * 2);
  objects.push({ id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' });
  objects.push({
    id: 2,
    body: `<< /Type /Pages /Kids [${pageObjectNumbers.map((id) => `${id} 0 R`).join(' ')}] /Count ${PAGES.length} >>`,
  });
  objects.push({ id: 3, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' });

  const contentBase = 4 + PAGES.length * 2;
  PAGES.forEach((lines, index) => {
    const pageId = 4 + index * 2;
    const contentId = contentBase + index;
    objects.push({
      id: pageId,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    });
    const content = pageContent(lines);
    objects.push({ id: contentId, body: `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream` });
  });

  objects.sort((a, b) => a.id - b.id);
  const chunks = ['%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n'];
  let offset = Buffer.byteLength(chunks[0], 'latin1');
  const offsets = new Map();
  for (const object of objects) {
    offsets.set(object.id, offset);
    const chunk = `${object.id} 0 obj\n${object.body}\nendobj\n`;
    chunks.push(chunk);
    offset += Buffer.byteLength(chunk, 'latin1');
  }
  const maxId = objects.length;
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) {
    xref += `${String(offsets.get(id)).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(chunks.join('') + xref + trailer, 'latin1'));
}

export const FIXTURE_PAGES = PAGES.length;
export const FIXTURE_TITLE = 'A Small Paper About Efficient Readers';
