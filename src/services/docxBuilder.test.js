'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');

const { buildDocx, buildDocxToFile, escapeXml } = require('./docxBuilder');

/**
 * Parse ZIP entries from a buffer by scanning for local file headers.
 */
function parseZipEntries(buf) {
  const entries = [];
  let offset = 0;

  while (offset < buf.length - 4) {
    // Look for local file header signature
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;

    const compressedSize = buf.readUInt32LE(offset + 18);
    const uncompressedSize = buf.readUInt32LE(offset + 22);
    const nameLength = buf.readUInt16LE(offset + 26);
    const extraLength = buf.readUInt16LE(offset + 28);
    const name = buf.slice(offset + 30, offset + 30 + nameLength).toString('utf8');
    const dataStart = offset + 30 + nameLength + extraLength;
    const compressedData = buf.slice(dataStart, dataStart + compressedSize);

    let data;
    try {
      data = zlib.inflateRawSync(compressedData);
    } catch (_) {
      data = compressedData;
    }

    entries.push({ name, data, compressedSize, uncompressedSize });
    offset = dataStart + compressedSize;
  }

  return entries;
}

describe('docxBuilder', () => {
  describe('buildDocx', () => {
    it('returns a Buffer', () => {
      const result = buildDocx('Hello');
      assert.ok(Buffer.isBuffer(result));
    });

    it('output starts with ZIP magic bytes (504b0304)', () => {
      const result = buildDocx('Test');
      assert.equal(result[0], 0x50);
      assert.equal(result[1], 0x4b);
      assert.equal(result[2], 0x03);
      assert.equal(result[3], 0x04);
    });

    it('contains word/document.xml entry', () => {
      const result = buildDocx('Content');
      const entries = parseZipEntries(result);
      const names = entries.map(e => e.name);
      assert.ok(names.includes('word/document.xml'), 'ZIP should contain word/document.xml');
    });

    it('contains [Content_Types].xml entry', () => {
      const result = buildDocx('Content');
      const entries = parseZipEntries(result);
      const names = entries.map(e => e.name);
      assert.ok(names.includes('[Content_Types].xml'), 'ZIP should contain [Content_Types].xml');
    });

    it('contains _rels/.rels entry', () => {
      const result = buildDocx('Content');
      const entries = parseZipEntries(result);
      const names = entries.map(e => e.name);
      assert.ok(names.includes('_rels/.rels'), 'ZIP should contain _rels/.rels');
    });

    it('input text appears in document.xml content', () => {
      const text = 'This is my cover letter content';
      const result = buildDocx(text);
      const entries = parseZipEntries(result);
      const docEntry = entries.find(e => e.name === 'word/document.xml');
      assert.ok(docEntry, 'document.xml entry should exist');
      const content = docEntry.data.toString('utf8');
      assert.ok(content.includes(text), 'document.xml should contain the input text');
    });

    it('empty string input produces valid ZIP', () => {
      const result = buildDocx('');
      assert.ok(Buffer.isBuffer(result));
      assert.equal(result[0], 0x50);
      assert.equal(result[1], 0x4b);
      assert.equal(result[2], 0x03);
      assert.equal(result[3], 0x04);

      const entries = parseZipEntries(result);
      assert.ok(entries.length >= 3, 'Should have at least 3 entries');
      const docEntry = entries.find(e => e.name === 'word/document.xml');
      assert.ok(docEntry, 'document.xml should exist even for empty input');
    });

    it('special characters are XML-escaped in output', () => {
      const text = 'Hello <World> & "Quotes" \'Apostrophe\'';
      const result = buildDocx(text);
      const entries = parseZipEntries(result);
      const docEntry = entries.find(e => e.name === 'word/document.xml');
      const content = docEntry.data.toString('utf8');

      assert.ok(content.includes('&lt;World&gt;'), 'angle brackets should be escaped');
      assert.ok(content.includes('&amp;'), 'ampersand should be escaped');
      assert.ok(content.includes('&quot;Quotes&quot;'), 'quotes should be escaped');
      assert.ok(content.includes('&apos;Apostrophe&apos;'), 'apostrophes should be escaped');
      // Original unescaped characters should NOT appear
      assert.ok(!content.includes('<World>'), 'unescaped angle brackets should not appear');
    });

    it('multiline text produces multiple paragraphs', () => {
      const text = 'Line 1\nLine 2\nLine 3';
      const result = buildDocx(text);
      const entries = parseZipEntries(result);
      const docEntry = entries.find(e => e.name === 'word/document.xml');
      const content = docEntry.data.toString('utf8');

      assert.ok(content.includes('Line 1'), 'should contain Line 1');
      assert.ok(content.includes('Line 2'), 'should contain Line 2');
      assert.ok(content.includes('Line 3'), 'should contain Line 3');
      // Each line should be in its own paragraph
      const pCount = (content.match(/<w:p>/g) || []).length;
      assert.ok(pCount >= 3, `should have at least 3 paragraphs, got ${pCount}`);
    });
  });

  describe('buildDocxToFile', () => {
    it('writes to a temp file and cleanup works', () => {
      const fs = require('fs');
      const { path: filePath, cleanup } = buildDocxToFile('File test content');

      assert.ok(fs.existsSync(filePath), 'temp file should exist');
      assert.ok(filePath.endsWith('.docx'), 'file should have .docx extension');

      const content = fs.readFileSync(filePath);
      assert.equal(content[0], 0x50, 'file should start with ZIP magic byte');
      assert.equal(content[1], 0x4b);

      cleanup();
      assert.ok(!fs.existsSync(filePath), 'temp file should be removed after cleanup');
    });
  });

  describe('escapeXml', () => {
    it('escapes all XML special characters', () => {
      assert.equal(escapeXml('&'), '&amp;');
      assert.equal(escapeXml('<'), '&lt;');
      assert.equal(escapeXml('>'), '&gt;');
      assert.equal(escapeXml('"'), '&quot;');
      assert.equal(escapeXml("'"), '&apos;');
    });

    it('handles empty string', () => {
      assert.equal(escapeXml(''), '');
    });

    it('passes through plain text unchanged', () => {
      assert.equal(escapeXml('Hello World'), 'Hello World');
    });
  });
});
