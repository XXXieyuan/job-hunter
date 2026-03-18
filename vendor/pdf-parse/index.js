'use strict';

function extractText(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return '';
  }

  const source = buffer.toString('latin1');
  const segments = source.match(/\(([^()]{1,500})\)/g) || [];
  const text = segments
    .map((segment) => segment.slice(1, -1))
    .join(' ')
    .replace(/\\[rn]/g, ' ')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\d{3}/g, ' ')
    .replace(/[^\x20-\x7E\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

async function pdfParse(buffer) {
  return {
    text: extractText(buffer),
    numpages: 0,
    numrender: 0,
    info: {},
    metadata: null,
    version: '0.0.0-local'
  };
}

module.exports = pdfParse;
module.exports.default = pdfParse;
