/**
 * Seniority detection + match factor.
 *
 * Used to penalize Lead/Principal jobs ranking high for mid-level resumes,
 * which the title-cosine + skills-overlap signals can't catch on their own
 * ("Principal AI Engineer" embeds very close to "AI Engineer" in vector
 * space, but it's a real eligibility gap).
 *
 * Levels:
 *   0  intern / graduate / cadet / trainee
 *   1  junior / associate / entry
 *   2  mid (default IC)
 *   3  senior
 *   4  lead / principal / staff / manager
 *   5  head / director / vp / chief
 */

const LEVEL_LABELS = {
  0: 'Entry / Graduate',
  1: 'Junior',
  2: 'Mid-level',
  3: 'Senior',
  4: 'Lead / Principal',
  5: 'Director / Head',
};

// Order matters: check higher-specificity markers first so "senior manager"
// resolves to 4 (manager), not 3 (senior).
const TITLE_PATTERNS = [
  { level: 5, re: /\b(chief|cto|cio|cfo|vp|vice president|head of|director)\b/i },
  { level: 4, re: /\b(principal|staff engineer|tech lead|team lead|engineering manager|manager)\b/i },
  { level: 4, re: /\blead\b/i },
  { level: 3, re: /\b(senior|sr\.?|snr\.?)\b/i },
  { level: 1, re: /\b(junior|jr\.?|associate|entry[- ]level)\b/i },
  { level: 0, re: /\b(intern|graduate|grad|cadet|trainee)\b/i },
];

/**
 * Detect seniority level from a job title.
 * Returns 2 (mid) if no marker found — most "Software Engineer" / "Data Engineer"
 * postings without prefix are mid-level IC roles.
 */
function detectJobSeniority(title) {
  const t = (title || '').trim();
  if (!t) return 2;
  for (const { level, re } of TITLE_PATTERNS) {
    if (re.test(t)) return level;
  }
  return 2;
}

const TECH_TITLE_RE = /(engineer|developer|programmer|analyst|scientist|architect|administrator|devops|consultant|specialist|technician|designer|qa|tester|technologist|founder)/i;

function isTechExperience(entry) {
  const title = (entry?.title || '').toLowerCase();
  if (!title) return false;
  return TECH_TITLE_RE.test(title);
}

/**
 * Infer seniority from a resume.
 *
 * Strategy:
 *   1. Most recent (first) tech experience title — explicit Lead/Senior/Junior
 *      wins outright.
 *   2. Otherwise infer from count of tech-relevant entries:
 *      0-1 → junior, 2 → mid, 3-4 → senior, 5+ → lead.
 *
 * Note: we deliberately don't trust startDate/endDate yet — many parsers
 * (including ours) drop them or normalize them to "present", so date-based
 * year-counting would be wildly unreliable. Title + entry count is a more
 * stable signal.
 */
function detectResumeSeniority(resume) {
  let experience = [];
  try {
    experience = resume?.experience_json ? JSON.parse(resume.experience_json) : [];
    if (!Array.isArray(experience)) experience = [];
  } catch { experience = []; }

  const techEntries = experience.filter(isTechExperience);

  // Tier 1 — explicit marker on most recent tech title
  if (techEntries.length > 0) {
    const mostRecent = techEntries[0];
    const explicit = detectJobSeniorityIfMarked(mostRecent.title);
    if (explicit !== null) return explicit;
  }

  // Tier 2 — count-based heuristic
  const count = techEntries.length;
  if (count <= 1) return 1;       // Junior
  if (count === 2) return 2;      // Mid
  if (count <= 4) return 3;       // Senior
  return 4;                        // Lead+
}

// Same as detectJobSeniority but returns null when no marker — used by
// resume seniority to know "explicit" vs "fall through to count".
function detectJobSeniorityIfMarked(title) {
  const t = (title || '').trim();
  if (!t) return null;
  for (const { level, re } of TITLE_PATTERNS) {
    if (re.test(t)) return level;
  }
  return null;
}

/**
 * Multiplier for role_score based on level gap.
 * gap > 0 means job demands more seniority than resume offers.
 *
 *   gap <= -2  : 0.70  (resume far above — very overqualified)
 *   gap == -1  : 0.85  (one level above — slight overqualification)
 *   gap == 0   : 1.00  (perfect match)
 *   gap == 1   : 0.70  (Senior job, Mid resume)
 *   gap == 2   : 0.40  (Lead job, Mid resume — likely to be filtered out)
 *   gap >= 3   : 0.20  (Principal job, Junior resume — almost no chance)
 */
function seniorityFactor(jobLevel, resumeLevel) {
  const gap = jobLevel - resumeLevel;
  if (gap >= 3) return 0.20;
  if (gap === 2) return 0.40;
  if (gap === 1) return 0.70;
  if (gap === 0) return 1.00;
  if (gap === -1) return 0.85;
  return 0.70; // gap <= -2
}

function seniorityLabel(level) {
  return LEVEL_LABELS[level] || 'Unknown';
}

/**
 * Build a one-line summary for the UI / breakdown JSON.
 */
function describeSeniority(jobLevel, resumeLevel) {
  const gap = jobLevel - resumeLevel;
  const jobLbl = seniorityLabel(jobLevel);
  const resLbl = seniorityLabel(resumeLevel);
  if (gap === 0) return `${jobLbl} role aligns with your seniority.`;
  if (gap === 1) return `${jobLbl} role — one level above your current seniority (${resLbl}).`;
  if (gap >= 2) return `${jobLbl} role — you appear ${gap} levels below the seniority typically required (your level: ${resLbl}). Likely to be filtered out by recruiters.`;
  if (gap === -1) return `${jobLbl} role — slightly below your seniority (${resLbl}). You may be considered overqualified.`;
  return `${jobLbl} role — well below your seniority (${resLbl}). Likely overqualified.`;
}

module.exports = {
  detectJobSeniority,
  detectResumeSeniority,
  seniorityFactor,
  seniorityLabel,
  describeSeniority,
  LEVEL_LABELS,
};
