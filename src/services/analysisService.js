const { getJobsWithScore, getJobCounts, getActiveJobIds } = require('../repositories/jobsRepo');
const { upsertFitScore, getStats: getFitStats } = require('../repositories/fitScoresRepo');
const { getCoverLetter, upsertCoverLetter } = require('../repositories/coverLettersRepo');
const {
  createRun,
  markRunCompleted,
  markRunFailed,
  getLastRun,
  getRunById,
  findRunning,
  updateProgress,
} = require('../repositories/analysisRunsRepo');
const { scoreJobAgainstResume } = require('./scoringService');
const { generateCoverLetter, generateAndStore, isApsRole, PROMPT_VERSION } = require('./coverLetterService');
const { ensureCompanyForJob, batchResearchCompanies } = require('./companyService');
const { getPrimaryResume } = require('./resumeService');
const backgroundQueue = require('./backgroundQueue');
const { getLogger } = require('../logger');

const logger = getLogger('analysisService');

// ──────────────────────────────────────────────
// Pipeline steps
// ──────────────────────────────────────────────

/**
 * Score all active jobs against the given resume.
 * Supports partial checkpointing via lastProcessedJobId.
 *
 * @param {object} resume - Resume record
 * @param {number} runId - Analysis run ID for progress tracking
 * @param {number|null} lastProcessedJobId - Resume from this job ID (exclusive) if recovering
 * @returns {Promise<{scored: number, errors: number}>}
 */
async function scoreAllJobs(resume, runId, lastProcessedJobId) {
  // Override the repo's default 50-job UI pagination — scoring should cover
  // every active non-duplicate job, not just the first page.
  const jobs = getJobsWithScore({ limit: 100000 });
  let scored = 0;
  let errors = 0;

  for (const job of jobs) {
    // Skip jobs already processed in a previous (failed) attempt
    if (lastProcessedJobId && job.id <= lastProcessedJobId) {
      continue;
    }

    try {
      // Bulk-scoring hundreds of jobs: skip the per-job LLM call that
      // classifies missing skills into hard/closeable/reframeable. That
      // classification was quietly the biggest per-job cost (one GPT
      // chat call per job × resume). The detail view regenerates it
      // on-demand for a single job when the user clicks into it.
      const fitScore = await scoreJobAgainstResume(job, resume, { skipGapClassification: true });
      upsertFitScore({
        job_id: job.id,
        resume_id: resume.id,
        overall_score: fitScore.overall_score,
        keyword_score: fitScore.keyword_score,
        semantic_score: fitScore.semantic_score,
        role_alignment_score: fitScore.role_alignment_score,
        location_score: fitScore.location_score,
        breakdown_json: JSON.stringify(fitScore.breakdown),
        skill_gaps_json: JSON.stringify(fitScore.skill_gaps),
        visa_match: job.visa_eligibility || null,
      });
      scored++;

      // Checkpoint progress every 10 jobs
      if (scored % 10 === 0) {
        updateProgress(runId, {
          last_processed_job_id: job.id,
          stats_json: { phase: 'scoring', scored, errors, total: jobs.length },
        });
      }
    } catch (err) {
      errors++;
      logger.error('Failed to score job', { jobId: job.id, error: err.message });
    }
  }

  return { scored, errors };
}

/**
 * Generate cover letters for all scored jobs that don't have one yet.
 *
 * @param {object} resume - Resume record
 * @param {number} runId - Analysis run ID
 * @returns {Promise<{generated: number, errors: number}>}
 */
async function generateAllCoverLetters(resume, runId) {
  const jobs = getJobsWithScore();
  let generated = 0;
  let errors = 0;

  for (const job of jobs) {
    try {
      // Generate Chinese cover letter if missing
      const existingZh = getCoverLetter(job.id, resume.id, 'zh', 'chinese_cover_letter');
      if (!existingZh) {
        // Get score breakdown for this job if available
        let scoreBreakdown = null;
        if (job.breakdown_json) {
          try {
            scoreBreakdown = JSON.parse(job.breakdown_json);
          } catch { /* ignore */ }
        }

        const company = await ensureCompanyForJob(job);
        const content = await generateCoverLetter({
          mode: 'chinese_cover_letter',
          job,
          resume,
          scoreBreakdown,
          company,
        });

        if (content) {
          upsertCoverLetter({
            job_id: job.id,
            resume_id: resume.id,
            user_id: null,
            language: 'zh',
            mode: 'chinese_cover_letter',
            content,
            prompt_version: PROMPT_VERSION,
          });
          generated++;
        }
      }

      // Generate English cover letter if missing
      const existingEn = getCoverLetter(job.id, resume.id, 'en', 'english_cover_letter');
      if (!existingEn) {
        let scoreBreakdown = null;
        if (job.breakdown_json) {
          try {
            scoreBreakdown = JSON.parse(job.breakdown_json);
          } catch { /* ignore */ }
        }

        const company = await ensureCompanyForJob(job);
        const content = await generateCoverLetter({
          mode: 'english_cover_letter',
          job,
          resume,
          scoreBreakdown,
          company,
        });

        if (content) {
          upsertCoverLetter({
            job_id: job.id,
            resume_id: resume.id,
            user_id: null,
            language: 'en',
            mode: 'english_cover_letter',
            content,
            prompt_version: PROMPT_VERSION,
          });
          generated++;
        }
      }

      // Generate APS selection criteria if applicable and missing
      if (isApsRole(job)) {
        const existingAps = getCoverLetter(job.id, resume.id, 'en', 'aps_selection_criteria');
        if (!existingAps) {
          let scoreBreakdown = null;
          if (job.breakdown_json) {
            try {
              scoreBreakdown = JSON.parse(job.breakdown_json);
            } catch { /* ignore */ }
          }

          const content = await generateCoverLetter({
            mode: 'aps_selection_criteria',
            job,
            resume,
            scoreBreakdown,
          });

          if (content) {
            upsertCoverLetter({
              job_id: job.id,
              resume_id: resume.id,
              user_id: null,
              language: 'en',
              mode: 'aps_selection_criteria',
              content,
              prompt_version: PROMPT_VERSION,
            });
            generated++;
          }
        }
      }

      // Checkpoint every 5 jobs
      if ((generated + errors) % 5 === 0 && (generated + errors) > 0) {
        updateProgress(runId, {
          stats_json: { phase: 'cover_letters', generated, errors, total: jobs.length },
        });
      }
    } catch (err) {
      errors++;
      logger.error('Failed to generate cover letter', { jobId: job.id, error: err.message });
    }
  }

  return { generated, errors };
}

// ──────────────────────────────────────────────
// Full analysis pipeline
// ──────────────────────────────────────────────

/**
 * Execute the full analysis pipeline:
 * 1. Score all jobs against resume
 * 2. Generate cover letters
 * 3. Research companies
 *
 * Supports partial recovery via lastProcessedJobId checkpointing.
 *
 * @param {number} runId - Analysis run ID
 * @param {object} [config] - Run configuration
 */
async function runFullAnalysisAsync(runId, config = {}) {
  try {
    const primaryResume = getPrimaryResume();
    if (!primaryResume) {
      const jobCounts = getJobCounts();
      markRunCompleted(runId, {
        scoredPairs: 0,
        fitStats: getFitStats(),
        jobCounts,
        resumeId: null,
        message: 'No primary resume available',
      });
      logger.info('Analysis run completed with no primary resume', { runId });
      return;
    }

    // Check if resuming from a failed run
    let lastProcessedJobId = null;
    if (config.resumeFromRunId) {
      const prevRun = getRunById(config.resumeFromRunId);
      if (prevRun && prevRun.stats_json) {
        try {
          const prevStats = JSON.parse(prevRun.stats_json);
          if (prevStats.last_processed_job_id) {
            lastProcessedJobId = prevStats.last_processed_job_id;
            logger.info('Resuming from previous run checkpoint', {
              runId,
              prevRunId: config.resumeFromRunId,
              lastProcessedJobId,
            });
          }
        } catch { /* ignore parse errors */ }
      }
    }

    // Phase 1: Score all jobs
    updateProgress(runId, {
      stats_json: { phase: 'scoring', status: 'started' },
    });
    const scoreResult = await scoreAllJobs(primaryResume, runId, lastProcessedJobId);
    logger.info('Scoring phase complete', { runId, ...scoreResult });

    // Phase 2: Generate cover letters
    updateProgress(runId, {
      stats_json: { phase: 'cover_letters', status: 'started' },
    });
    const coverLetterResult = await generateAllCoverLetters(primaryResume, runId);
    logger.info('Cover letter phase complete', { runId, ...coverLetterResult });

    // Phase 3: Research companies
    updateProgress(runId, {
      stats_json: { phase: 'company_research', status: 'started' },
    });
    const companiesResearched = await batchResearchCompanies();
    logger.info('Company research phase complete', { runId, companiesResearched });

    // Finalize
    const fitStats = getFitStats();
    const jobCounts = getJobCounts();

    const stats = {
      scoredPairs: scoreResult.scored,
      scoringErrors: scoreResult.errors,
      coverLettersGenerated: coverLetterResult.generated,
      coverLetterErrors: coverLetterResult.errors,
      companiesResearched,
      fitStats,
      jobCounts,
      resumeId: primaryResume.id,
    };

    markRunCompleted(runId, stats);
    logger.info('Full analysis run completed', { runId, stats });
  } catch (err) {
    logger.error('Analysis run failed', { runId, error: err.message, stack: err.stack });
    markRunFailed(runId, err.message || String(err));
  }
}

// ──────────────────────────────────────────────
// Background queue integration
// ──────────────────────────────────────────────

// Register analysis handlers with the background queue
backgroundQueue.registerHandler('full_analysis', async (params) => {
  await runFullAnalysisAsync(params.runId, params.config || {});
});

backgroundQueue.registerHandler('scoring', async (params) => {
  await runTypedAnalysis(params.runId, 'scoring', params.config || {});
});

backgroundQueue.registerHandler('cover_letters', async (params) => {
  await runTypedAnalysis(params.runId, 'cover_letters', params.config || {});
});

backgroundQueue.registerHandler('company_research', async (params) => {
  await runTypedAnalysis(params.runId, 'company_research', params.config || {});
});

backgroundQueue.registerHandler('embeddings', async (params) => {
  await runTypedAnalysis(params.runId, 'embeddings', params.config || {});
});

/**
 * Run a typed (partial) analysis.
 * @param {number} runId
 * @param {string} type - scoring | cover_letters | company_research | embeddings
 * @param {object} config
 */
async function runTypedAnalysis(runId, type, config = {}) {
  try {
    const primaryResume = getPrimaryResume();
    if (!primaryResume && (type === 'scoring' || type === 'cover_letters')) {
      markRunCompleted(runId, { message: 'No primary resume available' });
      return;
    }

    if (type === 'scoring' && primaryResume) {
      const result = await scoreAllJobs(primaryResume, runId, null);
      markRunCompleted(runId, { jobs_scored: result.scored, scoring_errors: result.errors });
    } else if (type === 'cover_letters' && primaryResume) {
      const result = await generateAllCoverLetters(primaryResume, runId);
      markRunCompleted(runId, { cover_letters_created: result.generated, errors: result.errors });
    } else if (type === 'company_research') {
      const count = await batchResearchCompanies();
      markRunCompleted(runId, { companies_researched: count });
    } else if (type === 'embeddings') {
      // Embeddings are generated as part of scoring; standalone is a no-op placeholder
      markRunCompleted(runId, { embeddings_generated: 0, message: 'Embedding generation is part of scoring pipeline' });
    } else {
      markRunCompleted(runId, { message: `Unknown type: ${type}` });
    }

    logger.info('Typed analysis completed', { runId, type });
  } catch (err) {
    logger.error('Typed analysis failed', { runId, type, error: err.message });
    markRunFailed(runId, err.message || String(err));
  }
}

/** Valid analysis types */
const VALID_ANALYSIS_TYPES = ['full', 'scoring', 'cover_letters', 'company_research', 'embeddings'];

/**
 * Trigger an analysis run via the background queue.
 * Returns immediately with the run ID.
 *
 * @param {object} [options] - { type, config }
 * @returns {number} Analysis run ID
 */
function triggerAnalysis(options = {}) {
  const type = options.type || 'full';
  const config = options.config || options;

  const runId = createRun({ type, config });

  const taskType = type === 'full' ? 'full_analysis' : type;
  backgroundQueue.enqueue(taskType, { runId, config }, {
    description: `${type} analysis run #${runId}`,
  });

  logger.info('Analysis enqueued', { runId, type });
  return runId;
}

/**
 * Trigger a full analysis run via the background queue.
 * Returns immediately with the run ID.
 *
 * @param {object} [sources] - Source configuration / metadata
 * @returns {number} Analysis run ID
 */
function triggerFullAnalysis(sources) {
  // Check for already-running analyses
  const running = findRunning();
  if (running.length > 0) {
    logger.warn('Analysis already running, returning existing run', {
      runId: running[0].id,
    });
    return running[0].id;
  }

  return triggerAnalysis({ type: 'full', config: sources || {} });
}

/**
 * Get the last analysis run record.
 * @returns {object|undefined}
 */
function getLastAnalysisRun() {
  return getLastRun();
}

/**
 * Get an analysis run by ID.
 * @param {number} id
 * @returns {object|undefined}
 */
function getAnalysisRunById(id) {
  return getRunById(id);
}

module.exports = {
  triggerFullAnalysis,
  triggerAnalysis,
  getLastAnalysisRun,
  getAnalysisRunById,
  VALID_ANALYSIS_TYPES,
};
