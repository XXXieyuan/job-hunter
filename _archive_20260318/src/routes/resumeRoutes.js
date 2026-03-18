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
  setMainResume,
} = require('../services/resumeService');
const { getLogger } = require('../logger');

const logger = getLogger('resumeRoutes');

const router = express.Router();

// Multer storage for resumes under data/uploads/resumes
const uploadsRoot = path.join(__dirname, '..', '..', 'data', 'uploads', 'resumes');

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
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9-_]/g, '_');
    cb(null, `${base}-${timestamp}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
});

router.get('/resumes', (req, res) => {
  const resumes = getAllResumes();
  res.render('resumes/list', { resumes });
});

router.get('/resumes/:id', (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).send('无效的简历 ID');
  }

  const resume = getResumeById(id);
  if (!resume) {
    return res.status(404).send('找不到该简历');
  }

  // Parse JSON fields safely for display
  let skills = [];
  try {
    skills = JSON.parse(resume.skills_json || '[]');
  } catch (e) {
    skills = [];
  }

  let experience = [];
  try {
    experience = JSON.parse(resume.experience_json || '[]');
  } catch (e) {
    experience = [];
  }

  let education = [];
  try {
    education = JSON.parse(resume.education_json || '[]');
  } catch (e) {
    education = [];
  }

  res.render('resumes/detail', {
    resume,
    skills,
    experience,
    education,
  });
});

router.post('/resumes/upload', upload.single('resume'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send('请选择要上传的简历文件。');
  }

  try {
    await createResumeFromUpload(req.file);
    return res.redirect('/resumes');
  } catch (err) {
    logger.error('Failed to process uploaded resume', {
      err,
      // Avoid including full file path or original name in logs
      fileSize: req.file.size,
      mimetype: req.file.mimetype,
    });
    return res.status(500).send('处理简历文件时出错，请稍后重试。');
  }
});

router.post('/resumes/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).send('无效的简历 ID');
  }

  const existing = getResumeById(id);
  if (!existing) {
    return res.status(404).send('找不到该简历');
  }

  deleteResumeWithFile(id);
  return res.redirect('/resumes');
});

router.post('/resumes/:id/main', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).send('无效的简历 ID');
  }

  const existing = getResumeById(id);
  if (!existing) {
    return res.status(404).send('找不到该简历');
  }

  setMainResume(id);
  return res.redirect('/resumes');
});

module.exports = router;
