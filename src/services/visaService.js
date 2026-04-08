const { updateVisaInfo, getJobsWithoutVisaInfo } = require('../repositories/jobsRepo');
const { getLogger } = require('../logger');

const logger = getLogger('visaService');

// ──────────────────────────────────────────────
// Pass 1: Rule-based regex patterns
// Per SYSTEM_DESIGN.md Section 4.7
// ──────────────────────────────────────────────

const VISA_PATTERNS = {
  citizens_only: [
    /australian\s+citizen(ship)?\s+(only|required|essential|must)/i,
    /must\s+be\s+(an?\s+)?australian\s+citizen/i,
    /citizenship\s+is\s+(a\s+)?requirement/i,
    /eligible\s+to\s+obtain.*security\s+clearance/i,
    /australian\s+citizens?\s+only/i,
    /only\s+australian\s+citizens?\s+(may|can|will|should)\s+apply/i,
  ],
  pr_required: [
    /permanent\s+residen(t|cy)\s+(required|only|essential)/i,
    /must\s+have\s+(the\s+)?right\s+to\s+work.*permanently/i,
    /australian\s+citizen\s+or\s+permanent\s+resident/i,
    /must\s+be\s+(an?\s+)?australian\s+(citizen\s+or\s+)?permanent\s+resident/i,
    /pr\s+(status\s+)?(required|essential|only)/i,
  ],
  visa_holders_welcome: [
    /visa\s+sponsor(ship)?\s+(available|offered|provided)/i,
    /willing\s+to\s+sponsor/i,
    /all\s+visa\s+types?\s+(welcome|considered|accepted)/i,
    /right\s+to\s+work\s+in\s+australia/i,
    /work\s+rights?\s+in\s+australia/i,
    /sponsorship\s+(is\s+)?(available|offered)/i,
    /open\s+to\s+(all\s+)?visa\s+holders/i,
    /valid\s+work\s+(visa|permit)/i,
  ],
};

// Security clearance patterns (for APS jobs)
const CLEARANCE_PATTERNS = {
  baseline: [
    /baseline\s+(security\s+)?clearance/i,
    /baseline\s+vetting/i,
  ],
  negative_vetting_1: [
    /negative\s+vetting\s+(level\s+)?1/i,
    /nv1\s+clearance/i,
    /nv1/i,
  ],
  negative_vetting_2: [
    /negative\s+vetting\s+(level\s+)?2/i,
    /nv2\s+clearance/i,
    /nv2/i,
  ],
  positive_vetting: [
    /positive\s+vetting/i,
    /pv\s+clearance/i,
  ],
};

// ──────────────────────────────────────────────
// Pass 2: Keyword matching (broader patterns)
// ──────────────────────────────────────────────

const VISA_KEYWORDS = {
  citizens_only: [
    'australian citizen',
    'citizen only',
    'citizenship required',
    'citizens only',
  ],
  pr_required: [
    'permanent resident',
    'pr required',
    'permanent residency',
    'right to work permanently',
  ],
  visa_holders_welcome: [
    'visa sponsor',
    'sponsorship available',
    'work rights',
    'valid visa',
    'work permit',
    'all visa types',
  ],
};

const CLEARANCE_KEYWORDS = [
  'security clearance',
  'baseline clearance',
  'negative vetting',
  'positive vetting',
  'nv1', 'nv2',
  'agsva',
  'must be able to obtain',
];

/**
 * Extract visa eligibility category from job description text.
 * Two-pass: regex patterns first, then keyword matching.
 *
 * @param {string} description - Job description text
 * @returns {string} One of: citizens_only, pr_required, visa_holders_welcome, not_specified
 */
function extractVisaEligibility(description) {
  if (!description || typeof description !== 'string') {
    return null;
  }

  // Pass 1: Regex patterns (most specific, highest confidence)
  // Check citizens_only first (most restrictive)
  for (const pattern of VISA_PATTERNS.citizens_only) {
    if (pattern.test(description)) return 'citizens_only';
  }
  for (const pattern of VISA_PATTERNS.pr_required) {
    if (pattern.test(description)) return 'pr_required';
  }
  for (const pattern of VISA_PATTERNS.visa_holders_welcome) {
    if (pattern.test(description)) return 'visa_holders_welcome';
  }

  // Pass 2: Keyword matching (broader, lower confidence)
  const descLower = description.toLowerCase();

  for (const keyword of VISA_KEYWORDS.citizens_only) {
    if (descLower.includes(keyword)) return 'citizens_only';
  }
  for (const keyword of VISA_KEYWORDS.pr_required) {
    if (descLower.includes(keyword)) return 'pr_required';
  }
  for (const keyword of VISA_KEYWORDS.visa_holders_welcome) {
    if (descLower.includes(keyword)) return 'visa_holders_welcome';
  }

  return null;
}

/**
 * Extract security clearance requirements from job description.
 *
 * @param {string} description - Job description text
 * @returns {string|null} Clearance level or null if none detected
 */
function extractSecurityClearance(description) {
  if (!description || typeof description !== 'string') {
    return null;
  }

  // Check from highest to lowest clearance level
  for (const pattern of CLEARANCE_PATTERNS.positive_vetting) {
    if (pattern.test(description)) return 'positive_vetting';
  }
  for (const pattern of CLEARANCE_PATTERNS.negative_vetting_2) {
    if (pattern.test(description)) return 'negative_vetting_2';
  }
  for (const pattern of CLEARANCE_PATTERNS.negative_vetting_1) {
    if (pattern.test(description)) return 'negative_vetting_1';
  }
  for (const pattern of CLEARANCE_PATTERNS.baseline) {
    if (pattern.test(description)) return 'baseline';
  }

  // Keyword fallback
  const descLower = description.toLowerCase();
  for (const keyword of CLEARANCE_KEYWORDS) {
    if (descLower.includes(keyword)) {
      // Generic "security clearance" mention
      return 'baseline';
    }
  }

  return null;
}

/**
 * Process a single job: extract visa eligibility and security clearance,
 * then update the job record in the database.
 *
 * @param {object} job - Job record with id, description
 * @returns {object} { visa_eligibility, security_clearance }
 */
function processJob(job) {
  const visa_eligibility = extractVisaEligibility(job.description);
  const security_clearance = extractSecurityClearance(job.description);

  // Update job record via repository layer
  try {
    updateVisaInfo(job.id, { visa_eligibility, security_clearance });
  } catch (err) {
    logger.error(`Failed to update visa info for job ${job.id}:`, err.message);
  }

  return { visa_eligibility, security_clearance };
}

/**
 * Batch process all jobs that haven't had visa extraction yet.
 *
 * @param {object} opts - { onProgress: function(processed, total) }
 * @returns {object} { processed, updated }
 */
function processAllJobs(opts = {}) {
  // Get jobs without visa info via repository layer
  const jobs = getJobsWithoutVisaInfo();

  let processed = 0;
  let updated = 0;

  for (const job of jobs) {
    const result = processJob(job);
    processed++;

    if (result.visa_eligibility !== null || result.security_clearance) {
      updated++;
    }

    if (opts.onProgress && processed % 50 === 0) {
      opts.onProgress(processed, jobs.length);
    }
  }

  logger.info(`Visa extraction complete: ${processed} processed, ${updated} updated`);
  return { processed, updated };
}

module.exports = {
  extractVisaEligibility,
  extractSecurityClearance,
  processJob,
  processAllJobs,
};
