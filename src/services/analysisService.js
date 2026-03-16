const { getJobsWithScore, getJobCounts } = require('../repositories/jobsRepo');
const { upsertFitScore, getStats: getFitStats } = require('../repositories/fitScoresRepo');
const { getCoverLetter, upsertCoverLetter } = require('../repositories/coverLettersRepo');
const {
  createRun,
  markRunCompleted,
  markRunFailed,
  getLastRun,
} = require('../repositories/analysisRunsRepo');
const { scoreJobAgainstResume } = require('./scoringService');
const { generateCoverLetter } = require('./coverLetterService');
const { ensureCompanyForJob } = require('./companyService');
const { getPrimaryResume } = require('./resumeService');

async function runFullAnalysisAsync(runId) {
  try {
    const primaryResume = getPrimaryResume();
    if (!primaryResume) {
      // No resume available – mark as completed with zero stats to avoid failing the whole run.
      const jobCountsEmpty = getJobCounts();
      markRunCompleted(runId, {
        scoredPairs: 0,
        fitStats: getFitStats(),
        jobCounts: jobCountsEmpty,
        resumeId: null,
      });
      return;
    }

    const jobs = getJobsWithScore();

    let scoredPairs = 0;

    for (const job of jobs) {
      const resume = primaryResume;
      const fitScore = await scoreJobAgainstResume(job, resume);
      upsertFitScore({
        job_id: job.id,
        resume_id: resume.id,
        overall_score: fitScore.overall_score,
        keyword_score: fitScore.keyword_score,
        embedding_score: fitScore.embedding_score,
        breakdown_json: JSON.stringify(fitScore.breakdown),
      });

      const company = await ensureCompanyForJob(job);

      const existingLetter = getCoverLetter(job.id, resume.id, 'zh');
      if (!existingLetter) {
        const content = await generateCoverLetter({
          job,
          resume,
          fitScore,
          company,
        });
        upsertCoverLetter({
          job_id: job.id,
          resume_id: resume.id,
          language: 'zh',
          content,
        });
      }

      scoredPairs += 1;
    }

    const fitStats = getFitStats();
    const jobCounts = getJobCounts();

    const stats = {
      scoredPairs,
      fitStats,
      jobCounts,
      resumeId: primaryResume.id,
    };

    markRunCompleted(runId, stats);
  } catch (err) {
    markRunFailed(runId, err.message || String(err));
  }
}

function triggerFullAnalysis(sources) {
  const runId = createRun(sources || {});
  setImmediate(() => {
    runFullAnalysisAsync(runId);
  });
  return runId;
}

function getLastAnalysisRun() {
  return getLastRun();
}

module.exports = {
  triggerFullAnalysis,
  getLastAnalysisRun,
};
