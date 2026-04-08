/**
 * File validator middleware -- checks magic bytes to ensure uploaded files
 * match their claimed type.
 *
 * Supported formats:
 *   - PDF:  starts with %PDF  (hex: 25 50 44 46)
 *   - DOCX: starts with PK    (hex: 50 4B 03 04) -- ZIP/OOXML container
 */

const fs = require('fs');
const { getLogger } = require('../logger');

const logger = getLogger('fileValidator');

// Magic byte signatures.
const SIGNATURES = {
  pdf: Buffer.from([0x25, 0x50, 0x44, 0x46]), // %PDF
  docx: Buffer.from([0x50, 0x4b, 0x03, 0x04]), // PK\x03\x04
};

/**
 * Read the first N bytes of a file synchronously.
 * @param {string} filePath
 * @param {number} numBytes
 * @returns {Buffer}
 */
function readMagicBytes(filePath, numBytes) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(numBytes);
  fs.readSync(fd, buf, 0, numBytes, 0);
  fs.closeSync(fd);
  return buf;
}

/**
 * Validate that the uploaded file's magic bytes match one of the allowed types.
 *
 * Must be used AFTER multer middleware so that `req.file` is populated.
 *
 * @param {string[]} allowedTypes - Array of allowed type keys, e.g. ['pdf', 'docx'].
 * @returns {function} Express middleware
 */
function validateFileType(allowedTypes = ['pdf', 'docx']) {
  return (req, res, next) => {
    if (!req.file) {
      return next(); // No file uploaded -- let downstream handle it.
    }

    const filePath = req.file.path;
    if (!filePath) {
      return next();
    }

    try {
      const maxSigLen = Math.max(...allowedTypes.map((t) => (SIGNATURES[t] || Buffer.alloc(0)).length));
      const header = readMagicBytes(filePath, maxSigLen);

      const matched = allowedTypes.some((type) => {
        const sig = SIGNATURES[type];
        if (!sig) return false;
        return header.slice(0, sig.length).equals(sig);
      });

      if (!matched) {
        // Clean up the rejected file.
        try {
          fs.unlinkSync(filePath);
        } catch {
          // Best-effort cleanup.
        }

        logger.warn('File rejected: magic bytes do not match allowed types', {
          originalname: req.file.originalname,
          allowedTypes,
        });

        return res.status(400).json({
          error: `Invalid file type. Allowed types: ${allowedTypes.join(', ')}. File content does not match.`,
        });
      }

      next();
    } catch (err) {
      logger.error('Error validating file magic bytes', { error: err.message });
      return res.status(500).json({ error: 'Failed to validate uploaded file.' });
    }
  };
}

/**
 * Validate that the uploaded file is specifically a DOCX file (ZIP/OOXML container).
 * Returns JSON error responses suitable for API endpoints.
 *
 * Must be used AFTER multer middleware so that `req.file` is populated.
 *
 * @returns {function} Express middleware
 */
function validateDocxOnly() {
  return (req, res, next) => {
    if (!req.file) return next();
    const filePath = req.file.path;
    if (!filePath) return next();
    try {
      const header = readMagicBytes(filePath, 4);
      const isDocx = header.equals(SIGNATURES.docx);
      if (!isDocx) {
        try { fs.unlinkSync(filePath); } catch {}
        return res.status(400).json({
          error: { code: 'INVALID_FILE_TYPE', message: 'Only DOCX files are accepted' }
        });
      }
      next();
    } catch (err) {
      logger.error('Error validating DOCX magic bytes', { error: err.message });
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to validate file' } });
    }
  };
}

module.exports = { validateFileType, validateDocxOnly };
