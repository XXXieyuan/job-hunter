'use strict';

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Escape XML special characters.
 */
function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build a minimal ZIP file containing the given entries.
 * Each entry: { name: string, data: Buffer }
 * Returns a Buffer with valid ZIP format.
 */
function buildZip(entries) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const compressed = zlib.deflateRawSync(entry.data);

    // CRC-32 of uncompressed data
    const crc = crc32(entry.data);

    // Local file header (30 bytes + name + compressed data)
    const local = Buffer.alloc(30 + nameBuffer.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0); // Local file header signature
    local.writeUInt16LE(20, 4); // Version needed to extract (2.0)
    local.writeUInt16LE(0, 6); // General purpose bit flag
    local.writeUInt16LE(8, 8); // Compression method: deflate
    local.writeUInt16LE(0, 10); // Last mod file time
    local.writeUInt16LE(0, 12); // Last mod file date
    local.writeUInt32LE(crc, 14); // CRC-32
    local.writeUInt32LE(compressed.length, 18); // Compressed size
    local.writeUInt32LE(entry.data.length, 22); // Uncompressed size
    local.writeUInt16LE(nameBuffer.length, 26); // File name length
    local.writeUInt16LE(0, 28); // Extra field length
    nameBuffer.copy(local, 30);
    compressed.copy(local, 30 + nameBuffer.length);

    localHeaders.push(local);

    // Central directory header (46 bytes + name)
    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0); // Central directory header signature
    central.writeUInt16LE(20, 4); // Version made by
    central.writeUInt16LE(20, 6); // Version needed to extract
    central.writeUInt16LE(0, 8); // General purpose bit flag
    central.writeUInt16LE(8, 10); // Compression method: deflate
    central.writeUInt16LE(0, 12); // Last mod file time
    central.writeUInt16LE(0, 14); // Last mod file date
    central.writeUInt32LE(crc, 16); // CRC-32
    central.writeUInt32LE(compressed.length, 20); // Compressed size
    central.writeUInt32LE(entry.data.length, 24); // Uncompressed size
    central.writeUInt16LE(nameBuffer.length, 28); // File name length
    central.writeUInt16LE(0, 30); // Extra field length
    central.writeUInt16LE(0, 32); // File comment length
    central.writeUInt16LE(0, 34); // Disk number start
    central.writeUInt16LE(0, 36); // Internal file attributes
    central.writeUInt32LE(0, 38); // External file attributes
    central.writeUInt32LE(offset, 42); // Relative offset of local header
    nameBuffer.copy(central, 46);

    centralHeaders.push(central);
    offset += local.length;
  }

  // End of central directory record
  const centralDirOffset = offset;
  const centralDirSize = centralHeaders.reduce((sum, h) => sum + h.length, 0);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // End of central directory signature
  eocd.writeUInt16LE(0, 4); // Number of this disk
  eocd.writeUInt16LE(0, 6); // Disk where central directory starts
  eocd.writeUInt16LE(entries.length, 8); // Number of central directory records on this disk
  eocd.writeUInt16LE(entries.length, 10); // Total number of central directory records
  eocd.writeUInt32LE(centralDirSize, 12); // Size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16); // Offset of start of central directory
  eocd.writeUInt16LE(0, 20); // Comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

/**
 * CRC-32 implementation.
 */
const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crc32Table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a valid DOCX file buffer from plain text.
 * @param {string} text - The text content for the document.
 * @returns {Buffer} A valid DOCX file as a Buffer.
 */
function buildDocx(text) {
  const escapedText = escapeXml(text || '');

  // Split text into paragraphs by newlines
  const paragraphs = escapedText.split('\n');
  const paragraphXml = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join('');

  const contentTypes = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    'utf8'
  );

  const rels = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    'utf8'
  );

  const documentXml = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${paragraphXml}</w:body>
</w:document>`,
    'utf8'
  );

  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: documentXml },
  ]);
}

/**
 * Build a DOCX and write it to a temp file.
 * @param {string} text - The text content for the document.
 * @returns {{ path: string, cleanup: Function }} Path to the temp file and cleanup function.
 */
function buildDocxToFile(text) {
  const buffer = buildDocx(text);
  const tmpPath = path.join(
    os.tmpdir(),
    `jh-cover-letter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.docx`
  );
  fs.writeFileSync(tmpPath, buffer);
  return {
    path: tmpPath,
    cleanup() {
      try {
        fs.unlinkSync(tmpPath);
      } catch (_) {
        // file may already be deleted
      }
    },
  };
}

module.exports = {
  buildDocx,
  buildDocxToFile,
  escapeXml,
};
