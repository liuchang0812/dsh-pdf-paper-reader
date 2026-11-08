/**
 * CommonJS loader for the vendored pdf.js legacy build.
 *
 * The legacy UMD bundle expects CommonJS (`module.exports`, `require`); the
 * package is `"type": "module"`, so the vendored copies use the `.cjs`
 * extension. The optional `canvas` polyfills are not installed, which pdf.js
 * reports through its logger on load; text extraction does not need them, so
 * that one-time notice is suppressed here.
 */
'use strict';

const path = require('node:path');

const vendorDir = path.join(__dirname, '..', 'vendor');

const originalLog = console.log;
const originalWarn = console.warn;
console.log = () => {};
console.warn = () => {};
let loaded;
try {
  loaded = require(path.join(vendorDir, 'pdf.legacy.min.cjs'));
} finally {
  console.log = originalLog;
  console.warn = originalWarn;
}

const lib = typeof loaded.getDocument === 'function' ? loaded : globalThis.pdfjsLib;
if (lib === undefined || typeof lib.getDocument !== 'function') {
  throw new Error('The vendored pdf.js build did not expose getDocument().');
}
lib.GlobalWorkerOptions.workerSrc = path.join(vendorDir, 'pdf.legacy.worker.min.cjs');
module.exports = lib;
