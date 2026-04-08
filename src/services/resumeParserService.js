const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const { chatCompletion, hasOpenAIKey } = require('./openAIClient');
const resumesRepo = require('../repositories/resumesRepo');
const { getLogger } = require('../logger');

const logger = getLogger('resumeParserService');

const PROMPT_VERSION = 'resume-parser-v2';

/**
 * Extract raw text from a DOCX file using mammoth.
 * DOCX-only per validated requirements (PDF removed).
 *
 * @param {string} filePath - Absolute path to the .docx file
 * @returns {Promise<string>} Extracted text
 */
async function extractText(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value || '';
}

/**
 * Safely parse a JSON string, attempting to locate a JSON object if the raw
 * string contains surrounding markdown or prose.
 */
function safeParseJson(content) {
  if (!content || typeof content !== 'string') return null;
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Use AI to structure extracted text into skills, experience, education,
 * certifications arrays.
 *
 * @param {string} rawText - The extracted plain text from the resume file
 * @returns {Promise<object>} Structured resume data
 */
async function structureWithAI(rawText) {
  const fallback = {
    name: 'Unnamed Resume',
    summary: rawText.slice(0, 500),
    skills: [],
    experience: [],
    education: [],
    certifications: [],
  };

  if (!hasOpenAIKey()) {
    return fallback;
  }

  const systemPrompt = [
    'You are an expert resume parser. Extract structured information from resume text.',
    'You must return a valid JSON object only, with no other text, markdown blocks, or comments.',
    'Required keys:',
    '- name: Full name string',
    '- summary: Professional summary string (1-3 sentences)',
    '- skills: Array of objects with keys: name (string), category (one of "technical", "soft", "domain"), proficiency (one of "beginner", "intermediate", "advanced") — infer proficiency from context in the resume',
    '- experience: Array of objects with keys: title, employer, start_date, end_date, description',
    '- education: Array of objects with keys: degree, field, institution, start_date, end_date',
    '- certifications: Array of objects with keys: name, issuer, date (all strings; set to null if unknown)',
  ].join('\n');

  // Truncate to avoid exceeding context limits
  const truncated = rawText.length > 12000 ? rawText.slice(0, 12000) : rawText;

  const userPrompt = `Extract structured information from the following resume text:\n\n${truncated}`;

  try {
    const content = await chatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.2, max_tokens: 4096 }
    );

    const parsed = safeParseJson(content);
    if (!parsed) {
      logger.warn('AI resume parsing returned unparseable JSON');
      return { ...fallback, ai_raw: content };
    }

    // Normalize arrays
    const normalizeArray = (val) => {
      if (Array.isArray(val)) return val;
      if (typeof val === 'string') return val.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      return [];
    };

    // Normalize skills to {name, category, proficiency} objects
    const normalizeSkills = (val) => {
      const arr = normalizeArray(val);
      return arr.map((s) => {
        if (typeof s === 'string') {
          return { name: s, category: 'technical', proficiency: 'intermediate' };
        }
        if (s && typeof s === 'object') {
          return {
            name: String(s.name || s.skill || ''),
            category: ['technical', 'soft', 'domain'].includes(s.category) ? s.category : 'technical',
            proficiency: ['beginner', 'intermediate', 'advanced'].includes(s.proficiency) ? s.proficiency : 'intermediate',
          };
        }
        return null;
      }).filter((s) => s && s.name);
    };

    // Normalize experience entries to {title, employer, start_date, end_date, description}
    const normalizeExperience = (val) => {
      if (!Array.isArray(val)) return [];
      return val.filter((i) => i && typeof i === 'object').map((e) => ({
        title: String(e.title || e.role || ''),
        employer: String(e.employer || e.company || e.organisation || ''),
        start_date: e.start_date || null,
        end_date: e.end_date || null,
        description: String(e.description || ''),
      }));
    };

    // Normalize education entries to {degree, field, institution, start_date, end_date}
    const normalizeEducation = (val) => {
      if (!Array.isArray(val)) return [];
      return val.filter((i) => i && typeof i === 'object').map((e) => ({
        degree: String(e.degree || ''),
        field: String(e.field || e.major || e.area || ''),
        institution: String(e.institution || e.school || e.university || ''),
        start_date: e.start_date || null,
        end_date: e.end_date || null,
      }));
    };

    // Normalize certifications to [{name, issuer, date}]
    const normalizeCertifications = (val) => {
      const arr = normalizeArray(val);
      return arr.map((c) => {
        if (typeof c === 'string') {
          return { name: c, issuer: null, date: null };
        }
        if (c && typeof c === 'object') {
          return {
            name: String(c.name || c.title || ''),
            issuer: c.issuer || c.organization || null,
            date: c.date || c.year || null,
          };
        }
        return null;
      }).filter((c) => c && c.name);
    };

    return {
      name: parsed.name || parsed.full_name || fallback.name,
      summary: parsed.summary || parsed.professional_summary || fallback.summary,
      skills: normalizeSkills(parsed.skills),
      experience: normalizeExperience(parsed.experience),
      education: normalizeEducation(parsed.education),
      certifications: normalizeCertifications(parsed.certifications),
      ai_raw: content,
    };
  } catch (err) {
    logger.error('AI resume structuring failed', { error: err.message });
    return fallback;
  }
}

/**
 * Parse a resume file, extract text, structure it with AI, and store the
 * extracted data in the resume record.
 *
 * @param {string} filePath - Absolute path to the uploaded resume file
 * @param {string} fileType - MIME type or extension
 * @param {object} opts - { user_id, resume_id (optional, to update existing), fileName }
 * @returns {Promise<object>} The created or updated resume record
 */
async function parseAndStore(filePath, fileType, opts = {}) {
  const { user_id, resume_id, fileName } = opts;

  logger.info('Parsing resume file', { filePath, fileType, resume_id });

  // Step 1: Extract raw text from DOCX
  const rawText = await extractText(filePath);
  if (!rawText || rawText.trim().length === 0) {
    throw new Error('No text could be extracted from the resume file.');
  }

  // Step 2: Structure with AI
  const structured = await structureWithAI(rawText);

  // Step 3: Store in DB
  if (resume_id) {
    // Update existing resume record with extracted data
    resumesRepo.updateExtractedData(resume_id, user_id, {
      summary: structured.summary,
      skills_json: JSON.stringify(structured.skills),
      experience_json: JSON.stringify(structured.experience),
      education_json: JSON.stringify(structured.education),
      certifications_json: JSON.stringify(structured.certifications),
      is_confirmed: 0, // Needs user confirmation after parsing
    });
    return resumesRepo.getResumeById(resume_id);
  }

  // Insert new resume record
  const id = resumesRepo.insertResume({
    user_id: user_id || null,
    name: structured.name,
    file_path: filePath,
    file_type: fileType,
    summary: structured.summary,
    skills_json: JSON.stringify(structured.skills),
    experience_json: JSON.stringify(structured.experience),
    education_json: JSON.stringify(structured.education),
    certifications_json: JSON.stringify(structured.certifications),
    raw_text: rawText,
    is_confirmed: 0, // Needs user confirmation
  });

  logger.info('Resume parsed and stored', {
    resumeId: id,
    skillsCount: structured.skills.length,
    experienceCount: structured.experience.length,
    educationCount: structured.education.length,
    certificationsCount: structured.certifications.length,
  });

  return resumesRepo.getResumeById(id);
}

/**
 * Re-parse an existing resume record from its stored file.
 * Useful when the AI model is updated and results may improve.
 *
 * @param {number} resumeId
 * @param {number} userId
 * @returns {Promise<object>} Updated resume record
 */
async function reparseResume(resumeId, userId) {
  const resume = resumesRepo.getResumeByIdAndUser(resumeId, userId);
  if (!resume) {
    throw new Error('Resume not found');
  }
  if (!resume.file_path || !fs.existsSync(resume.file_path)) {
    throw new Error('Resume file no longer available on disk');
  }
  return parseAndStore(resume.file_path, resume.file_type, {
    user_id: userId,
    resume_id: resumeId,
  });
}

module.exports = {
  extractText,
  structureWithAI,
  parseAndStore,
  reparseResume,
  PROMPT_VERSION,
};
