'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { getDb, TABLES } = require('../db/database');
const { parseResume } = require('../services/resumeParser');
const { log } = require('../utils/logger');
const { validateFileType } = require('../utils/validators');
const { createAppError } = require('../utils/appError');

const router = express.Router();
const uploadDirectory = path.resolve(process.cwd(), 'data', 'uploads');
fs.mkdirSync(uploadDirectory, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDirectory,
  filename: (req, file, callback) => {
    const extension = path.extname(file.originalname);
    const baseName = path.basename(file.originalname, extension).replace(/[^a-zA-Z0-9-_]/g, '-');
    callback(null, `${Date.now()}-${baseName}${extension.toLowerCase()}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    if (!validateFileType(file.originalname, ['docx', 'pdf'])) {
      callback(createAppError(400, 'VALIDATION_ERROR', 'Only .docx and .pdf resumes are supported'));
      return;
    }

    callback(null, true);
  }
});

router.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    let file = req.file;

    if (!file && req.body && req.body.file_path) {
      const originalName = req.body.original_name || path.basename(req.body.file_path);
      file = {
        originalname: originalName,
        path: path.resolve(process.cwd(), req.body.file_path)
      };
    }

    if (!file) {
      throw createAppError(400, 'VALIDATION_ERROR', 'Resume file is required');
    }

    const fileType = path.extname(file.originalname).replace('.', '').toLowerCase();
    const parsedData = await parseResume(file.path, fileType);

    if (parsedData.error) {
      if (req.file) {
        fs.promises.unlink(file.path).catch(() => {});
      }
      throw createAppError(400, 'VALIDATION_ERROR', parsedData.message);
    }

    const db = getDb();
    const resumeCount = db.prepare(`SELECT COUNT(*) AS count FROM ${TABLES.RESUMES}`).get().count;
    const name = parsedData.name || path.basename(req.file.originalname, path.extname(req.file.originalname));
    const result = db.prepare(`
      INSERT INTO ${TABLES.RESUMES} (
        name,
        file_name,
        file_path,
        file_type,
        parsed_data,
        is_primary
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      name,
      file.originalname,
      file.path,
      fileType,
      JSON.stringify(parsedData),
      resumeCount === 0 ? 1 : 0
    );

    const created = db.prepare(`
      SELECT id, name, is_primary, created_at, parsed_data
      FROM ${TABLES.RESUMES}
      WHERE id = ?
    `).get(result.lastInsertRowid);

    log('info', 'RESUME_UPLOAD', `Uploaded resume ${created.id}`);

    res.json({
      id: created.id,
      name: created.name,
      parsed_data: JSON.parse(created.parsed_data)
    });
  } catch (error) {
    next(error);
  }
});

router.get('/', (req, res, next) => {
  try {
    const rows = getDb().prepare(`
      SELECT id, name, file_name, file_type, parsed_data, is_primary, created_at, updated_at
      FROM ${TABLES.RESUMES}
      ORDER BY is_primary DESC, updated_at DESC
    `).all();

    res.json(rows.map((row) => ({
      ...row,
      parsed_data: JSON.parse(row.parsed_data || '{}')
    })));
  } catch (error) {
    next(error);
  }
});

router.put('/:id/primary', (req, res, next) => {
  try {
    const db = getDb();
    const target = db.prepare(`SELECT id FROM ${TABLES.RESUMES} WHERE id = ?`).get(req.params.id);
    if (!target) {
      throw createAppError(404, 'NOT_FOUND', `Resume with id ${req.params.id} not found`);
    }

    const transaction = db.transaction((resumeId) => {
      db.prepare(`UPDATE ${TABLES.RESUMES} SET is_primary = 0, updated_at = datetime('now')`).run();
      db.prepare(`UPDATE ${TABLES.RESUMES} SET is_primary = 1, updated_at = datetime('now') WHERE id = ?`).run(resumeId);
    });

    transaction(req.params.id);
    log('info', 'RESUME_PRIMARY_UPDATED', `Primary resume set to ${req.params.id}`);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const db = getDb();
    const resume = db.prepare(`SELECT * FROM ${TABLES.RESUMES} WHERE id = ?`).get(req.params.id);
    if (!resume) {
      throw createAppError(404, 'NOT_FOUND', `Resume with id ${req.params.id} not found`);
    }

    const transaction = db.transaction((resumeId) => {
      db.prepare(`DELETE FROM ${TABLES.RESUMES} WHERE id = ?`).run(resumeId);
      const currentPrimary = db.prepare(`SELECT id FROM ${TABLES.RESUMES} WHERE is_primary = 1 LIMIT 1`).get();
      if (!currentPrimary) {
        const fallback = db.prepare(`SELECT id FROM ${TABLES.RESUMES} ORDER BY updated_at DESC LIMIT 1`).get();
        if (fallback) {
          db.prepare(`UPDATE ${TABLES.RESUMES} SET is_primary = 1 WHERE id = ?`).run(fallback.id);
        }
      }
    });

    transaction(req.params.id);
    if (!req.body || !req.body.keep_file) {
      await fs.promises.unlink(resume.file_path).catch(() => {});
    }
    log('info', 'RESUME_DELETED', `Deleted resume ${req.params.id}`);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
