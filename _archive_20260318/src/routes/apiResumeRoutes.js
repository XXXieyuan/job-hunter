const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const {
  getAllResumes,
  getResumeById,
} = require('../repositories/resumesRepo');
const {
  createResumeFromUpload,
  deleteResumeWithFile,
} = require('../services/resumeService');
const { getLogger } = require('../logger');

const logger = getLogger('apiResumeRoutes');

const router = express.Router();

const uploadsRoot = path.join(
  __dirname,
  '..',
  '..',
  'data',
  'uploads',
  'resumes',
);

if (!fs.existsSync(uploadsRoot)) {
  fs.mkdirSync(uploadsRoot, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsRoot);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname) || '';
    const base = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9-_]/g, '_');
    cb(null, `${base}-${timestamp}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
});

function mapResume(row) {
  if (!row) return null;
  let parsed = null;
  try {
    parsed = row.parsed_data ? JSON.parse(row.parsed_data) : null;
  } catch {
    parsed = null;
  }

  const skills =
    parsed && Array.isArray(parsed.skills)
      ? parsed.skills.map((s) => String(s))
      : undefined;
  const domains =
    parsed && Array.isArray(parsed.domains)
      ? parsed.domains.map((d) => String(d))
      : undefined;
  const seniority =
    parsed && typeof parsed.seniority === 'string'
      ? parsed.seniority
      : undefined;
  const rawText =
    parsed && typeof parsed.raw_text === 'string'
      ? parsed.raw_text
      : undefined;

  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    skills,
    domains,
    seniority,
    raw_text_preview: rawText ? rawText.slice(0, 300) : undefined,
  };
}

router.get('/api/resumes', (req, res) => {
  const resumes = getAllResumes();
  res.json(resumes.map(mapResume));
});

router.post(
  '/api/resumes/upload',
  upload.single('file'),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
      const resume = await createResumeFromUpload(req.file);
      const payload = mapResume(resume);
      return res.json(payload);
    } catch (err) {
      logger.error('Failed to process uploaded resume (API)', {
        err,
        fileSize: req.file.size,
        mimetype: req.file.mimetype,
      });
      return res
        .status(500)
        .json({ error: err && err.message ? err.message : 'Failed to process resume' });
    }
  },
);

router.delete('/api/resumes/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'Invalid resume id' });
  }

  const existing = getResumeById(id);
  if (!existing) {
    return res.status(404).json({ error: 'Resume not found' });
  }

  const ok = deleteResumeWithFile(id);
  if (!ok) {
    return res.status(500).json({ error: 'Failed to delete resume' });
  }

  // Frontend expects JSON from delete() helper; return a simple success flag.
  return res.json({ success: true });
});

module.exports = router;

