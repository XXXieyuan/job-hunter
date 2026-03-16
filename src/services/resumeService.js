const fs = require('fs');
const path = require('path');
const {
  getResumeCount,
  insertResume,
  getAllResumes,
  getResumeById,
  getMainResume,
  deleteResume,
  setMainResume,
} = require('../repositories/resumesRepo');
const mammoth = require('mammoth');
const { chatCompletion, hasOpenAIKey } = require('./openAIClient');
const { getLogger } = require('../logger');

const logger = getLogger('resumeService');

async function ensureSampleResumeSeeded() {
  const count = getResumeCount();
  if (count > 0) return;

  const filePath = path.join(__dirname, '..', '..', 'data', 'sample-resume.json');
  const raw = fs.readFileSync(filePath, 'utf8');
  const json = JSON.parse(raw);

  const resume = {
    name: json.name,
    summary: json.summary,
    skills_json: JSON.stringify(json.skills || []),
    experience_json: JSON.stringify(json.experience || []),
    education_json: JSON.stringify(json.education || []),
    raw_json: JSON.stringify(json),
    file_name: null,
    file_type: null,
    storage_path: null,
    is_main: 1,
    parsed_data: JSON.stringify(json),
  };

  const id = insertResume(resume);
  logger.info('Seeded sample resume', { resumeId: id });
}

function getPrimaryResume() {
  const main = getMainResume();
  if (main) return main;
  const resumes = getAllResumes();
  return resumes[0] || null;
}

async function extractTextFromFile(filePath, fileType) {
  // Prefer real file extension from path, but also handle common DOCX MIME type
  const ext = (path.extname(filePath) || '').toLowerCase();
  const type = (fileType || '').toLowerCase();
  const isDocxMime = type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  if (ext === '.docx' || ext.endsWith('.docx') || isDocxMime) {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || '';
  }

  // Fallback: treat as plain text
  return fs.readFileSync(filePath, 'utf8');
}

function safeParseJson(content) {
  if (!content || typeof content !== 'string') return null;
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    // Try to find JSON block if AI included markdown or extra text
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

function normalizeExtraction(rawText, parsed) {
  const result = {
    name: parsed.name || parsed.full_name || '未命名简历',
    summary: parsed.summary || parsed.professional_summary || rawText.slice(0, 500),
    skills: [],
    experience: [],
    education: [],
    raw_text: rawText,
  };

  // Normalize skills
  if (Array.isArray(parsed.skills)) {
    result.skills = parsed.skills.map(String);
  } else if (typeof parsed.skills === 'string') {
    result.skills = parsed.skills.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
  }

  // Normalize experience
  if (Array.isArray(parsed.experience)) {
    result.experience = parsed.experience.filter(i => i && typeof i === 'object');
  } else if (parsed.experience && typeof parsed.experience === 'object') {
    result.experience = [parsed.experience];
  }

  // Normalize education
  if (Array.isArray(parsed.education)) {
    result.education = parsed.education.filter(i => i && typeof i === 'object');
  } else if (parsed.education && typeof parsed.education === 'object') {
    result.education = [parsed.education];
  }

  return result;
}

async function extractResumeFieldsWithAI(rawText) {
  if (!hasOpenAIKey()) {
    return {
      name: '未命名简历',
      summary: rawText.slice(0, 500),
      skills: [],
      experience: [],
      education: [],
      raw_text: rawText,
    };
  }

  const systemPrompt = [
    'You are an expert resume parser. Extract structured information from resume text.',
    'You must return a valid JSON object only, with no other text, markdown blocks, or comments.',
    'Required keys:',
    '- name: Full name string',
    '- summary: Professional summary string',
    '- skills: Array of strings representing technical or soft skills',
    '- experience: Array of objects (company, title, start_date, end_date, description)',
    '- education: Array of objects (school, degree, start_date, end_date, description)',
  ].join('\n');

  const userPrompt = `Extract information from the following resume text:\n\n${rawText}`;

  const content = await chatCompletion([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);

  const parsed = safeParseJson(content);
  if (!parsed) {
    return {
      name: '未命名简历',
      summary: rawText.slice(0, 500),
      skills: [],
      experience: [],
      education: [],
      raw_text: rawText,
      ai_raw: content,
    };
  }

  const normalized = normalizeExtraction(rawText, parsed);
  normalized.ai_raw = content; // Keep raw output for debugging
  return normalized;
}

async function createResumeFromUpload(file) {
  const filePath = file.path;
  const fileName = file.originalname;
  const fileType = file.mimetype || path.extname(file.originalname);

  const rawText = await extractTextFromFile(filePath, fileType);
  const extracted = await extractResumeFieldsWithAI(rawText);

  const resume = {
    name: extracted.name,
    summary: extracted.summary,
    skills_json: JSON.stringify(extracted.skills || []),
    experience_json: JSON.stringify(extracted.experience || []),
    education_json: JSON.stringify(extracted.education || []),
    raw_json: JSON.stringify(extracted),
    file_name: fileName,
    file_type: fileType,
    storage_path: filePath,
    is_main: 0,
    parsed_data: JSON.stringify(extracted),
  };

  const id = insertResume(resume);
  logger.info('Inserted uploaded resume', {
    resumeId: id,
    // Avoid logging raw text or file path; only basic metadata
    fileType,
  });

  // If this is the first real user resume (not sample), set it as main
  const resumes = getAllResumes();
  const userResumes = resumes.filter(r => r.file_name !== null);
  if (userResumes.length === 1 && userResumes[0].id === id) {
    setMainResume(id);
  }

  return getResumeById(id);
}

function deleteResumeWithFile(id) {
  const resume = getResumeById(id);
  if (!resume) return false;

  const wasMain = !!resume.is_main;

  if (resume.storage_path && fs.existsSync(resume.storage_path)) {
    try {
      fs.unlinkSync(resume.storage_path);
    } catch (err) {
      // Log but do not fail the operation if file removal fails
      logger.warn('Failed to delete resume file from disk', {
        resumeId: id,
        error: err && err.message,
      });
    }
  }

  deleteResume(id);

  // If the deleted resume was main, assign a new main if possible
  if (wasMain) {
    const remaining = getAllResumes();
    if (remaining.length > 0) {
      // Set the newest remaining resume as main
      setMainResume(remaining[0].id);
    }
  }

  return true;
}

module.exports = {
  ensureSampleResumeSeeded,
  getPrimaryResume,
  getResumeById,
  getAllResumes,
  createResumeFromUpload,
  deleteResumeWithFile,
  setMainResume,
};
