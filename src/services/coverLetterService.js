const { chatCompletion, hasOpenAIKey } = require('./openAIClient');
const coverLettersRepo = require('../repositories/coverLettersRepo');
const { getLogger } = require('../logger');

const logger = getLogger('coverLetterService');

// Prompt versioning for reproducibility
const PROMPT_VERSION = 'cover-letter-v2';

// ──────────────────────────────────────────────
// Mode definitions
// ──────────────────────────────────────────────

const MODES = {
  standard: {
    language: 'en',
    mode: 'standard',
  },
  aps_selection_criteria: {
    language: 'en',
    mode: 'aps_selection_criteria',
  },
};

// ──────────────────────────────────────────────
// Prompt builders (per SYSTEM_DESIGN.md Section 4.6)
// ──────────────────────────────────────────────

function buildMatchedSkillsText(scoreBreakdown) {
  if (!scoreBreakdown) return 'N/A';
  const matched = scoreBreakdown.matched_skills;
  return Array.isArray(matched) && matched.length > 0 ? matched.join(', ') : 'N/A';
}

function buildSkillGapsText(scoreBreakdown) {
  if (!scoreBreakdown) return 'N/A';
  const gaps = scoreBreakdown.missing_skills;
  if (!Array.isArray(gaps) || gaps.length === 0) return 'None identified';
  return gaps
    .map((g) => {
      if (typeof g === 'string') return g;
      return `${g.skill} (${g.category || 'unknown'})`;
    })
    .join(', ');
}

function buildEnglishPrompt({ job, resume, scoreBreakdown, company }) {
  const matchedSkills = buildMatchedSkillsText(scoreBreakdown);
  const skillGaps = buildSkillGapsText(scoreBreakdown);
  const companyDesc = company && company.description ? company.description : '';

  const systemPrompt = `You are a professional career coach specialising in the Australian job market.
Generate a cover letter for the following job application.

Rules:
- Professional but personable tone, following Australian business letter conventions
- Address the hiring manager (use "Dear Hiring Manager" if name unknown)
- Opening paragraph: express genuine interest in the role and company
- Middle paragraphs: highlight matched skills (${matchedSkills}), address 1-2 closeable skill gaps constructively
- Closing paragraph: express enthusiasm and availability
- Keep to 350-450 words
- Do NOT use American spelling (use "organise" not "organize", "colour" not "color", etc.)
- Do NOT be generic. Reference specific details from the job description.`;

  const userPrompt = `Job title: ${job.title || 'Unknown'}
Company: ${job.company_name || 'Unknown'}
${companyDesc ? `Company background: ${companyDesc}\n` : ''}Job description: ${(job.description || '').slice(0, 3000)}
Candidate summary: ${resume.summary || ''}
Matched skills: ${matchedSkills}
Key skill gaps: ${skillGaps}`;

  return { systemPrompt, userPrompt };
}

function buildApsPrompt({ job, resume, scoreBreakdown }) {
  // Extract selection criteria from job description if present
  const description = job.description || '';
  const criteriaMatch = description.match(
    /(?:selection\s+criteria|key\s+capabilities|essential\s+requirements)[\s:]*\n?([\s\S]*?)(?:\n\n|\z)/i
  );
  const selectionCriteria = criteriaMatch ? criteriaMatch[1].trim() : description.slice(0, 3000);

  let experienceJson = '';
  try {
    experienceJson = resume.experience_json || '[]';
  } catch {
    experienceJson = '[]';
  }

  const systemPrompt = `You are an expert in Australian Public Service (APS) job applications.
Generate structured selection criteria responses for this APS role.

Rules:
- Use the STAR method (Situation, Task, Action, Result) for each criterion
- Each response should be 200-300 words
- Draw on the candidate's actual experience from their resume
- Use professional public service language
- Reference relevant APS values (impartial, committed to service, accountable, respectful, ethical)
- If a criterion cannot be addressed from the resume, note this and suggest how the candidate might address it`;

  const userPrompt = `Selection criteria extracted from job description:
${selectionCriteria}

Candidate resume summary: ${resume.summary || ''}
Candidate experience: ${experienceJson}`;

  return { systemPrompt, userPrompt };
}

// ──────────────────────────────────────────────
// Core generation function
// ──────────────────────────────────────────────

/**
 * Generate a cover letter in the specified mode.
 *
 * @param {object} params
 * @param {string} params.mode - One of: english_cover_letter, chinese_cover_letter, aps_selection_criteria
 * @param {object} params.job - Job record
 * @param {object} params.resume - Resume record
 * @param {object} [params.scoreBreakdown] - Score breakdown object (from fitScore)
 * @param {object} [params.company] - Company record
 * @returns {Promise<string|null>} Generated content or null if no API key
 */
async function generateCoverLetter({ mode, job, resume, scoreBreakdown, company }) {
  if (!hasOpenAIKey()) {
    return null;
  }

  const modeConfig = MODES[mode];
  if (!modeConfig) {
    throw new Error(`Unknown cover letter mode: ${mode}. Valid modes: ${Object.keys(MODES).join(', ')}`);
  }

  // Build prompt based on mode
  let systemPrompt, userPrompt;
  switch (mode) {
    case 'standard':
      ({ systemPrompt, userPrompt } = buildEnglishPrompt({ job, resume, scoreBreakdown, company }));
      break;
    case 'aps_selection_criteria':
      ({ systemPrompt, userPrompt } = buildApsPrompt({ job, resume, scoreBreakdown }));
      break;
    default:
      throw new Error(`Unhandled mode: ${mode}`);
  }

  const maxTokens = mode === 'aps_selection_criteria' ? 6144 : 4096;
  const content = await chatCompletion(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    { temperature: 0.6, max_tokens: maxTokens }
  );

  return content;
}

/**
 * Generate a cover letter and store it via coverLettersRepo.
 *
 * @param {object} params
 * @param {string} params.mode - Cover letter mode
 * @param {object} params.job - Job record
 * @param {object} params.resume - Resume record
 * @param {object} [params.scoreBreakdown] - Score breakdown
 * @param {object} [params.company] - Company record
 * @param {number} [params.user_id] - User ID for ownership
 * @returns {Promise<{id: number, content: string}>}
 */
async function generateAndStore({ mode, job, resume, scoreBreakdown, company, user_id }) {
  const content = await generateCoverLetter({ mode, job, resume, scoreBreakdown, company });

  if (!content) {
    return { id: null, content: null };
  }

  const modeConfig = MODES[mode];

  const id = coverLettersRepo.upsertCoverLetter({
    job_id: job.id,
    resume_id: resume.id,
    user_id: user_id || null,
    language: modeConfig.language,
    mode: modeConfig.mode,
    content,
    prompt_version: PROMPT_VERSION,
  });

  logger.info('Cover letter generated and stored', {
    coverLetterId: id,
    mode,
    jobId: job.id,
    resumeId: resume.id,
  });

  return { id, content };
}

/**
 * Detect whether a job is likely an APS role requiring selection criteria.
 * @param {object} job - Job record
 * @returns {boolean}
 */
function isApsRole(job) {
  if (job.source === 'apsjobs') return true;
  const desc = (job.description || '').toLowerCase();
  return (
    desc.includes('selection criteria') ||
    desc.includes('key capabilities') ||
    desc.includes('aps values') ||
    desc.includes('australian public service')
  );
}

/**
 * Get recommended modes for a given job.
 * @param {object} job
 * @returns {string[]} Array of mode keys
 */
function getRecommendedModes(job) {
  const modes = ['standard'];
  if (isApsRole(job)) {
    modes.push('aps_selection_criteria');
  }
  return modes;
}

// Legacy backward-compatible wrapper (used by existing analysisService)
async function generateCoverLetterLegacy({ job, resume, fitScore, company }) {
  // Parse breakdown from fitScore if available
  let scoreBreakdown = null;
  if (fitScore && fitScore.breakdown) {
    scoreBreakdown = fitScore.breakdown;
  } else if (fitScore && fitScore.breakdown_json) {
    try {
      scoreBreakdown = JSON.parse(fitScore.breakdown_json);
    } catch { /* ignore */ }
  }

  const content = await generateCoverLetter({
    mode: 'standard',
    job,
    resume,
    scoreBreakdown,
    company,
  });

  return content || 'Cover letter generation failed. Please retry from the admin panel.';
}

module.exports = {
  generateCoverLetter,
  generateAndStore,
  generateCoverLetterLegacy,
  isApsRole,
  getRecommendedModes,
  MODES,
  PROMPT_VERSION,
};
