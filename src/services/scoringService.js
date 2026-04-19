const { hasOpenAIKey, generateEmbedding, chatCompletion } = require('./openAIClient');
const fitScoresRepo = require('../repositories/fitScoresRepo');
const resumesRepo = require('../repositories/resumesRepo');
const jobsRepo = require('../repositories/jobsRepo');
const skillEmbeddingsRepo = require('../repositories/skillEmbeddingsRepo');
const { OPENAI_EMBEDDING_MODEL, SEMANTIC_KEYWORD_MATCH_THRESHOLD } = require('../config');
const {
  decodeEmbedding,
  bufferFromFloats,
} = require('./embeddingService');
const { getLogger } = require('../logger');

const logger = getLogger('scoringService');

// Weights per SYSTEM_DESIGN.md Section 4.3
const W_SEMANTIC = 0.40;
const W_KEYWORD = 0.30;
const W_ROLE = 0.20;
const W_LOCATION = 0.10;

// Australian states for location matching
const AUSTRALIAN_STATES = {
  nsw: 'nsw', 'new south wales': 'nsw', sydney: 'nsw', newcastle: 'nsw', wollongong: 'nsw',
  vic: 'vic', victoria: 'vic', melbourne: 'vic', geelong: 'vic',
  qld: 'qld', queensland: 'qld', brisbane: 'qld', 'gold coast': 'qld',
  wa: 'wa', 'western australia': 'wa', perth: 'wa',
  sa: 'sa', 'south australia': 'sa', adelaide: 'sa',
  tas: 'tas', tasmania: 'tas', hobart: 'tas',
  act: 'act', canberra: 'act', 'australian capital territory': 'act',
  nt: 'nt', 'northern territory': 'nt', darwin: 'nt',
};

/**
 * Cosine similarity between two float arrays.
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Clamp a value between min and max.
 */
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Normalize text for comparison.
 */
function normalize(text) {
  return (text || '').toLowerCase().trim();
}

/**
 * Extract a flat array of skill strings from resume.skills_json.
 */
function extractSkills(resume) {
  let skills = [];
  try {
    skills = resume.skills_json ? JSON.parse(resume.skills_json) : [];
  } catch {
    skills = [];
  }
  if (!Array.isArray(skills)) skills = [];

  return skills
    .map((s) => {
      if (!s) return null;
      if (typeof s === 'string') return s.trim();
      if (typeof s === 'object') {
        if (s.name) return String(s.name).trim();
        if (s.skill) return String(s.skill).trim();
      }
      return null;
    })
    .filter((s) => s && s.length > 0);
}

/**
 * Extract experience entries from resume.
 */
function extractExperience(resume) {
  try {
    const exp = resume.experience_json ? JSON.parse(resume.experience_json) : [];
    return Array.isArray(exp) ? exp : [];
  } catch {
    return [];
  }
}

/**
 * Build job text for embedding: title + company + location + description.
 * Per SYSTEM_DESIGN.md Section 4.2.
 */
function buildJobEmbeddingText(job) {
  return [
    job.title || '',
    job.company_name || '',
    job.location || '',
    job.description || '',
  ].join('\n');
}

/**
 * Build resume text for embedding.
 * Per SYSTEM_DESIGN.md Section 4.2.
 */
function buildResumeEmbeddingText(resume) {
  const skills = extractSkills(resume);
  const experience = extractExperience(resume);
  const expText = experience
    .map((e) => `${e.title || ''} ${e.company || ''} ${e.description || ''}`)
    .join('\n');

  let education = '';
  try {
    const edu = resume.education_json ? JSON.parse(resume.education_json) : [];
    if (Array.isArray(edu)) {
      education = edu.map((e) => `${e.degree || ''} ${e.institution || ''}`).join('\n');
    }
  } catch { /* ignore */ }

  return [
    resume.summary || '',
    `Skills: ${skills.join(', ')}`,
    `Experience: ${expText}`,
    `Education: ${education}`,
  ].join('\n');
}

// ──────────────────────────────────────────────
// Semantic Score (0-100)
// ──────────────────────────────────────────────

async function computeSemanticScore(job, resume) {
  try {
    // Prefer stored embeddings; fall back to API + persist on miss so the
    // next run is free. Note the persist path uses the same BLOB shape as
    // resume confirmation (`Float64Array.buffer` wrapped in a Buffer).
    const EMB_MODEL = OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';

    let jobVec = decodeEmbedding(job.embedding);
    if (!jobVec) {
      if (!hasOpenAIKey()) return null;
      const v = await generateEmbedding(buildJobEmbeddingText(job));
      if (v) {
        jobVec = new Float64Array(v);
        try { jobsRepo.updateJobEmbedding(job.id, bufferFromFloats(v), EMB_MODEL); }
        catch (err) { logger.warn('Failed to persist job embedding', { jobId: job.id, error: err.message }); }
      }
    }

    let resumeVec = decodeEmbedding(resume.embedding);
    if (!resumeVec) {
      if (!hasOpenAIKey()) return null;
      const v = await generateEmbedding(buildResumeEmbeddingText(resume));
      if (v) {
        resumeVec = new Float64Array(v);
        try { resumesRepo.updateEmbedding(resume.id, bufferFromFloats(v), EMB_MODEL); }
        catch (err) { logger.warn('Failed to persist resume embedding', { resumeId: resume.id, error: err.message }); }
      }
    }

    if (!jobVec || !resumeVec) return null;
    const sim = cosineSimilarity(jobVec, resumeVec);
    return clamp(sim * 100, 0, 100);
  } catch (err) {
    logger.error('Semantic score failed:', err.message);
    return null;
  }
}

// ──────────────────────────────────────────────
// Keyword Score (0-100)
// ──────────────────────────────────────────────

/**
 * Build one big normalized text blob covering skills + experience +
 * education + summary. Used for Tier-B keyword matching so a skill
 * mentioned in an experience description (e.g. "built chatbot with
 * OpenAI API") counts, not just a literal match in skills[].
 */
function buildResumeSearchText(resume) {
  const skills = extractSkills(resume);
  const experience = extractExperience(resume);
  let education = [];
  try {
    education = resume.education_json ? JSON.parse(resume.education_json) : [];
    if (!Array.isArray(education)) education = [];
  } catch { education = []; }

  const expText = experience
    .map((e) => `${e.title || ''} ${e.company || e.employer || ''} ${e.description || ''}`)
    .join(' ');
  const eduText = education
    .map((e) => `${e.degree || ''} ${e.institution || ''}`)
    .join(' ');

  return normalize([
    resume.summary || '',
    skills.join(' '),
    expText,
    eduText,
  ].join(' '));
}

function computeKeywordScore(job, resume) {
  const resumeSkills = extractSkills(resume);
  if (resumeSkills.length === 0) return { score: 0, matched: [], missing: [], details: [] };

  // Preferred path: the job has a curated required_skills list (LLM-extracted
  // at ingest). Score = covered / required. Match is a three-tier lookup:
  //   A. literal in resume.skills array
  //   B. literal anywhere in resume text (summary + experience + education)
  //   C. semantic — cosine(skill, each resume skill vector) >= threshold,
  //      using the global skill_embeddings cache
  let jobRequired = null;
  if (job.required_skills_json) {
    try {
      const parsed = JSON.parse(job.required_skills_json);
      if (Array.isArray(parsed)) jobRequired = parsed;
    } catch { /* ignore malformed */ }
  }

  if (jobRequired && jobRequired.length > 0) {
    const resumeSkillsNorm = resumeSkills.map((s) => normalize(s)).filter(Boolean);
    const resumeSet = new Set(resumeSkillsNorm);
    const searchText = buildResumeSearchText(resume);

    // Pre-decode every resume-skill embedding we have cached (one DB hit).
    const resumeSkillVectors = [];
    try {
      const cache = skillEmbeddingsRepo.getEmbeddingsBulk(resumeSkillsNorm);
      for (const name of resumeSkillsNorm) {
        const buf = cache.get(name);
        if (buf) {
          const v = decodeEmbedding(buf);
          if (v) resumeSkillVectors.push({ name, vec: v });
        }
      }
    } catch (err) {
      logger.warn('Failed to load resume skill embeddings', { error: err.message });
    }

    const matched = [];
    const missing = [];
    const details = [];

    for (const reqRaw of jobRequired) {
      const req = normalize(reqRaw);
      if (!req) continue;

      // Tier A — literal match in resume.skills
      if (resumeSet.has(req) ||
          resumeSkillsNorm.some((r) => r.includes(req) || req.includes(r))) {
        matched.push(reqRaw);
        details.push({ skill: reqRaw, match_type: 'skills' });
        continue;
      }

      // Tier B — literal mention in full resume text (includes experience
      // descriptions). Use word-boundary-ish check to avoid super-short
      // query false matches like "ml" appearing inside "html".
      if (req.length >= 3 && searchText.includes(req)) {
        matched.push(reqRaw);
        details.push({ skill: reqRaw, match_type: 'experience' });
        continue;
      }

      // Tier C — semantic cosine match against cached skill vectors
      const reqEmbBuf = skillEmbeddingsRepo.getEmbedding(req);
      if (reqEmbBuf) {
        const reqVec = decodeEmbedding(reqEmbBuf);
        if (reqVec && resumeSkillVectors.length > 0) {
          let bestSim = 0;
          let bestSkill = null;
          for (const { name, vec } of resumeSkillVectors) {
            const sim = cosineSimilarity(reqVec, vec);
            if (sim > bestSim) { bestSim = sim; bestSkill = name; }
          }
          if (bestSim >= SEMANTIC_KEYWORD_MATCH_THRESHOLD) {
            matched.push(reqRaw);
            details.push({
              skill: reqRaw,
              match_type: 'semantic',
              matched_against: bestSkill,
              similarity: Math.round(bestSim * 1000) / 1000,
            });
            continue;
          }
        }
      }

      missing.push(reqRaw);
      details.push({ skill: reqRaw, match_type: 'missing' });
    }

    const score = clamp((matched.length / jobRequired.length) * 100, 0, 100);
    return { score, matched, missing, details };
  }

  // Fallback: no curated list yet. Resume-skill-in-job-text heuristic with a
  // capped denominator so long resumes aren't punished.
  const jobTextLower = normalize(`${job.title || ''}\n${job.description || ''}`);
  const matched = [];
  const missing = [];
  for (const skill of resumeSkills) {
    const s = normalize(skill);
    if (s && jobTextLower.includes(s)) matched.push(skill);
    else missing.push(skill);
  }
  const FULL_CREDIT_AT = 5;
  const score = clamp((matched.length / FULL_CREDIT_AT) * 100, 0, 100);
  return { score, matched, missing, details: [] };
}

// ──────────────────────────────────────────────
// Role Alignment Score (0-100)
// ──────────────────────────────────────────────

async function computeRoleAlignmentScore(job, resume) {
  const experience = extractExperience(resume);
  const jobTitleNorm = normalize(job.title || '');

  if (!jobTitleNorm) return 30;

  // Extract significant words from job title (remove common filler)
  const stopWords = new Set([
    'senior', 'junior', 'lead', 'principal', 'associate', 'intern',
    'i', 'ii', 'iii', 'iv', 'v', 'the', 'a', 'an', 'and', 'or', 'of', 'for', 'in', 'at',
  ]);
  const jobTitleWords = jobTitleNorm.split(/\s+/).filter((w) => w.length > 1 && !stopWords.has(w));

  // Check for title matches in experience
  const expTitles = experience.map((e) => normalize(e.title || ''));
  let bestOverlap = 0;
  let hasExactMatch = false;

  for (const expTitle of expTitles) {
    if (!expTitle) continue;

    // Check for near-exact match (ignoring seniority prefixes)
    const expWords = expTitle.split(/\s+/).filter((w) => w.length > 1 && !stopWords.has(w));
    const expWordSet = new Set(expWords);
    const jobWordSet = new Set(jobTitleWords);

    // Count overlap
    let overlap = 0;
    for (const w of jobTitleWords) {
      if (expWordSet.has(w)) overlap++;
    }

    // Exact match (all significant words present)
    if (jobTitleWords.length > 0 && overlap === jobTitleWords.length) {
      hasExactMatch = true;
    }

    const maxLen = Math.max(jobTitleWords.length, expWords.length, 1);
    const overlapRatio = overlap / maxLen;
    if (overlapRatio > bestOverlap) bestOverlap = overlapRatio;
  }

  // Base score from word overlap
  let score = bestOverlap * 80;

  // Boost for exact/near-exact match
  if (hasExactMatch) score = Math.max(score, 90);

  // Previously this path also called the embedding API on job.title and the
  // joined experience titles. That was the #2 source of API calls per score
  // (after computeSemanticScore). Now we rely on word overlap alone — the
  // semantic embedding (of the full job vs full resume) already captures
  // title-level similarity, so the dedicated title-embedding pass was
  // double-counting and expensive.
  return clamp(score, 0, 100);
}

// ──────────────────────────────────────────────
// Location Score (0-100)
// Per SYSTEM_DESIGN.md: exact=100, same state=70, remote=90, different=30, no pref=80
// ──────────────────────────────────────────────

function resolveState(locationStr) {
  const lower = normalize(locationStr);
  for (const [key, state] of Object.entries(AUSTRALIAN_STATES)) {
    if (lower.includes(key)) return state;
  }
  return null;
}

function computeLocationScore(job, resume) {
  const jobLocation = normalize(job.location || '');
  if (!jobLocation) return 80; // no job location info -> neutral

  // Check for remote
  if (
    jobLocation.includes('remote') ||
    jobLocation.includes('work from home') ||
    jobLocation.includes('wfh')
  ) {
    return 90;
  }

  // Get user preferred locations from resume (stored in user profile or resume metadata)
  let preferredLocations = [];
  try {
    if (resume.preferred_locations) {
      preferredLocations = typeof resume.preferred_locations === 'string'
        ? JSON.parse(resume.preferred_locations)
        : resume.preferred_locations;
    }
  } catch { /* ignore */ }

  if (!Array.isArray(preferredLocations) || preferredLocations.length === 0) {
    return 80; // no preference set -> neutral
  }

  // Check exact city match
  for (const pref of preferredLocations) {
    if (jobLocation.includes(normalize(pref))) {
      return 100;
    }
  }

  // Check same state
  const jobState = resolveState(jobLocation);
  for (const pref of preferredLocations) {
    const prefState = resolveState(pref);
    if (jobState && prefState && jobState === prefState) {
      return 70;
    }
  }

  return 30; // different state
}

// ──────────────────────────────────────────────
// Skill Gap Classification (via AI)
// ──────────────────────────────────────────────

async function classifySkillGaps(missingSkills, job, resume) {
  if (!missingSkills || missingSkills.length === 0) return [];

  // Default classification without AI
  const defaultGaps = missingSkills.map((skill) => ({
    skill,
    category: 'closeable',
    suggestion: `Consider learning ${skill} to strengthen your application.`,
  }));

  if (!hasOpenAIKey() || missingSkills.length === 0) return defaultGaps;

  try {
    const prompt = `You are a career advisor for the Australian job market.
Classify each missing skill into one of three categories:
- "hard_requirement": Cannot be obtained (citizenship, years of specific experience, professional license requiring years of study)
- "closeable": Can be learned/obtained within 1-6 months (specific tools, certifications, short courses)
- "reframeable": The candidate may have equivalent experience under a different name

For each skill, provide a brief, actionable suggestion.

Job title: ${job.title || 'Unknown'}
Job description excerpt: ${(job.description || '').slice(0, 2000)}
Candidate skills: ${extractSkills(resume).join(', ')}

Missing skills to classify:
${missingSkills.join('\n')}

Respond as a JSON array of objects with "skill", "category", and "suggestion" fields. Return ONLY the JSON array, no other text.`;

    const result = await chatCompletion([
      { role: 'system', content: prompt },
    ], { temperature: 0.3, max_tokens: 4096, reasoning_effort: 'medium' });

    if (result) {
      // Try to parse JSON from response
      const jsonMatch = result.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) return parsed;
      }
    }
  } catch (err) {
    logger.warn('Skill gap classification failed, using defaults:', err.message);
  }

  return defaultGaps;
}

// ──────────────────────────────────────────────
// Detail builders for breakdown_json
// Per INTERFACE_CONTRACT.md Section 2
// ──────────────────────────────────────────────

function buildRoleAlignmentDetail(job, resume, roleScore) {
  const experience = extractExperience(resume);
  const expTitles = experience
    .map((e) => e.title)
    .filter(Boolean)
    .join(', ');
  const jobTitle = job.title || 'Unknown role';

  if (roleScore >= 80) {
    return `Your experience${expTitles ? ` as '${expTitles}'` : ''} aligns well with '${jobTitle}'.`;
  }
  if (roleScore >= 50) {
    return `Your experience${expTitles ? ` as '${expTitles}'` : ''} partially aligns with '${jobTitle}'. The seniority or domain gap is the main factor.`;
  }
  return `Your experience${expTitles ? ` as '${expTitles}'` : ''} has limited direct alignment with '${jobTitle}'. Consider highlighting transferable skills.`;
}

function buildLocationDetail(job, resume, locationScore) {
  const jobLocation = job.location || 'unspecified location';
  if (locationScore >= 100) {
    return `Job is in ${jobLocation}. This matches your preferred location.`;
  }
  if (locationScore >= 90) {
    return `Job is in ${jobLocation} (remote/flexible). This is accessible from any location.`;
  }
  if (locationScore >= 70) {
    return `Job is in ${jobLocation}. This is in the same state as your preferred location.`;
  }
  if (locationScore >= 80) {
    return `Job is in ${jobLocation}. No location preference specified.`;
  }
  return `Job is in ${jobLocation}. This is in a different state from your preferred location.`;
}

function buildVisaNote(job) {
  const visa = job.visa_eligibility;
  if (!visa) return 'No visa requirement information available for this role.';

  switch (visa) {
    case 'citizens_only':
      return 'This role requires Australian citizenship.';
    case 'pr_required':
      return 'This role requires Australian permanent residency or citizenship.';
    case 'visa_holders_welcome':
      return 'This role lists visa holders as welcome — work visa holders are eligible.';
    default:
      return 'No visa requirement information available for this role.';
  }
}

function detectInternationalExperience(resume) {
  const experience = extractExperience(resume);
  const summary = normalize(resume.summary || '');

  // Check for international experience markers
  const intlKeywords = [
    'international', 'overseas', 'abroad', 'foreign',
    'china', 'india', 'uk', 'usa', 'europe', 'asia',
    'multinational', 'global', 'cross-border',
  ];

  const allText = normalize(
    experience.map((e) => `${e.title || ''} ${e.company || ''} ${e.description || ''}`).join(' ') +
    ' ' + summary
  );

  return intlKeywords.some((kw) => allText.includes(kw));
}

function computeVisaMatch(job) {
  const visa = job.visa_eligibility;
  if (!visa) return null;
  if (visa === 'visa_holders_welcome') return 1;
  if (visa === 'citizens_only' || visa === 'pr_required') return 0;
  return null;
}

// ──────────────────────────────────────────────
// Main Scoring Function
// ──────────────────────────────────────────────

/**
 * Score a single job against a resume. Computes composite score with four signals.
 * Stores result via fitScoresRepo.
 *
 * @param {object} job - Job record from DB
 * @param {object} resume - Resume record from DB
 * @param {object} opts - Options: { skipStore: boolean, skipGapClassification: boolean }
 * @returns {object} Score result with breakdown
 */
async function scoreJobAgainstResume(job, resume, opts = {}) {
  // Compute all four sub-scores
  const [semanticScore, roleAlignmentScore] = await Promise.all([
    computeSemanticScore(job, resume),
    computeRoleAlignmentScore(job, resume),
  ]);

  const { score: keywordScore, matched, missing, details: matchDetails } = computeKeywordScore(job, resume);
  const locationScore = computeLocationScore(job, resume);

  // Composite score calculation
  // If semantic score unavailable, redistribute weight to keyword
  let overallScore;
  if (semanticScore != null) {
    overallScore =
      W_SEMANTIC * semanticScore +
      W_KEYWORD * keywordScore +
      W_ROLE * roleAlignmentScore +
      W_LOCATION * locationScore;
  } else {
    // Fallback: redistribute semantic weight proportionally
    const fallbackKeywordWeight = W_KEYWORD + W_SEMANTIC * (W_KEYWORD / (W_KEYWORD + W_ROLE + W_LOCATION));
    const fallbackRoleWeight = W_ROLE + W_SEMANTIC * (W_ROLE / (W_KEYWORD + W_ROLE + W_LOCATION));
    const fallbackLocationWeight = W_LOCATION + W_SEMANTIC * (W_LOCATION / (W_KEYWORD + W_ROLE + W_LOCATION));
    overallScore =
      fallbackKeywordWeight * keywordScore +
      fallbackRoleWeight * roleAlignmentScore +
      fallbackLocationWeight * locationScore;
  }

  overallScore = clamp(Math.round(overallScore * 100) / 100, 0, 100);

  // Classify skill gaps
  let skillGaps = [];
  if (!opts.skipGapClassification) {
    skillGaps = await classifySkillGaps(missing, job, resume);
  } else {
    skillGaps = missing.map((skill) => ({
      skill,
      category: 'closeable',
      suggestion: `Consider learning ${skill}.`,
    }));
  }

  // Build detail strings for breakdown
  const roleAlignmentDetail = buildRoleAlignmentDetail(job, resume, roleAlignmentScore);
  const locationDetail = buildLocationDetail(job, resume, locationScore);
  const visaNote = buildVisaNote(job);
  const valuesInternationalExperience = detectInternationalExperience(resume);

  // Build breakdown JSON per INTERFACE_CONTRACT.md Section 2 (lines 208-230)
  // match_details is keyed by skill name and carries the tier ('skills' |
  // 'experience' | 'semantic') plus, for semantic hits, which resume skill
  // it matched against and the similarity score. Used by the UI to show a
  // subtle chip ("via experience", "semantic") next to matched skills.
  const breakdown = {
    matched_skills: matched,
    missing_skills: skillGaps,
    match_details: matchDetails || [],
    role_alignment_detail: roleAlignmentDetail,
    location_detail: locationDetail,
    visa_note: visaNote,
  };

  // Compute visa_match: 0=ineligible, 1=eligible, null=unknown
  const visaMatch = computeVisaMatch(job);

  // Store via fitScoresRepo
  if (!opts.skipStore) {
    try {
      fitScoresRepo.upsertFitScore({
        job_id: job.id,
        resume_id: resume.id,
        overall_score: overallScore,
        semantic_score: semanticScore != null ? Math.round(semanticScore * 100) / 100 : null,
        keyword_score: Math.round(keywordScore * 100) / 100,
        role_alignment_score: Math.round(roleAlignmentScore * 100) / 100,
        location_score: locationScore,
        breakdown_json: JSON.stringify(breakdown),
        skill_gaps_json: JSON.stringify(skillGaps),
        visa_match: visaMatch,
        values_international_experience: valuesInternationalExperience ? 1 : 0,
      });
    } catch (err) {
      logger.error('Failed to store fit score:', err.message);
    }
  }

  return {
    overall_score: overallScore,
    semantic_score: semanticScore != null ? Math.round(semanticScore * 100) / 100 : null,
    keyword_score: Math.round(keywordScore * 100) / 100,
    role_alignment_score: Math.round(roleAlignmentScore * 100) / 100,
    location_score: locationScore,
    visa_match: visaMatch,
    values_international_experience: valuesInternationalExperience,
    breakdown,
    skill_gaps: skillGaps,
  };
}

// ──────────────────────────────────────────────
// Multi-Resume Scoring Orchestration
// Per WBS T-D.1: loop over all confirmed resumes per user
// ──────────────────────────────────────────────

/**
 * Score all given jobs against all confirmed resumes for a user.
 * For each (job, resume) pair, checks cache first and skips if already scored.
 * Single-resume users experience identical behavior to the old single-resume path.
 *
 * @param {number} userId - User ID whose confirmed resumes to score against
 * @param {object[]} jobs - Array of job records from DB
 * @param {object} [opts] - Options
 * @param {function} [opts.onProgress] - Progress callback: ({ scored, skipped, errors, total }) => void
 * @param {object} [opts.resumesRepoOverride] - Override resumesRepo (for testing)
 * @param {object} [opts.fitScoresRepoOverride] - Override fitScoresRepo (for testing)
 * @param {function} [opts.scoreOneOverride] - Override scoreJobAgainstResume (for testing)
 * @returns {Promise<{ scored: number, skipped: number, errors: number, total: number }>}
 */
async function scoreAllJobsForUser(userId, jobs, opts = {}) {
  const rRepo = opts.resumesRepoOverride || resumesRepo;
  const fsRepo = opts.fitScoresRepoOverride || fitScoresRepo;
  const scoreFn = opts.scoreOneOverride || scoreJobAgainstResume;
  const onProgress = opts.onProgress || null;

  const confirmedResumes = rRepo.getConfirmedResumesForUser(userId);
  if (!confirmedResumes || confirmedResumes.length === 0) {
    logger.info('No confirmed resumes for user, skipping scoring', { userId });
    return { scored: 0, skipped: 0, errors: 0, total: 0 };
  }

  const total = jobs.length * confirmedResumes.length;
  let scored = 0;
  let skipped = 0;
  let errors = 0;

  for (const job of jobs) {
    for (const resume of confirmedResumes) {
      // Check cache: skip if already scored
      const existing = fsRepo.getFitScore(job.id, resume.id);
      if (existing) {
        skipped++;
        continue;
      }

      try {
        await scoreFn(job, resume, { skipGapClassification: true });
        scored++;
      } catch (err) {
        errors++;
        logger.error('Failed to score job against resume', {
          jobId: job.id,
          resumeId: resume.id,
          error: err.message,
        });
      }

      // Report progress after each scoring attempt
      if (onProgress) {
        onProgress({ scored, skipped, errors, total });
      }
    }
  }

  logger.info('Multi-resume scoring complete', { userId, scored, skipped, errors, total });
  return { scored, skipped, errors, total };
}

module.exports = {
  scoreJobAgainstResume,
  scoreAllJobsForUser,
  buildResumeEmbeddingText,
  // Exported for testing
  cosineSimilarity,
  computeKeywordScore,
  computeLocationScore,
  resolveState,
  extractSkills,
  buildRoleAlignmentDetail,
  buildLocationDetail,
  buildVisaNote,
  detectInternationalExperience,
  computeVisaMatch,
};
