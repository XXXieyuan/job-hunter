const express = require('express');
const { getJobsWithScore, getJobById } = require('../repositories/jobsRepo');
const { getBestFitScoreForJob } = require('../repositories/fitScoresRepo');
const { getCoverLetter } = require('../repositories/coverLettersRepo');
const { getCompanyByName } = require('../repositories/companiesRepo');
const { getPrimaryResume } = require('../services/resumeService');

const router = express.Router();

router.get('/', (req, res) => {
  res.redirect('/jobs');
});

router.get('/jobs', (req, res) => {
  const role = req.query.role || '';
  const source = req.query.source || '';
  const minScore = req.query.minScore ? Number(req.query.minScore) : undefined;

  const jobs = getJobsWithScore({
    role: role || undefined,
    source: source || undefined,
    minScore: Number.isFinite(minScore) ? minScore : undefined,
  });

  const roles = Array.from(
    new Set(jobs.map((j) => j.role).filter((r) => !!r))
  );
  const sources = Array.from(
    new Set(jobs.map((j) => j.source).filter((s) => !!s))
  );

  res.render('jobs/list', {
    jobs,
    filters: { role, source, minScore: minScore || '' },
    roles,
    sources,
  });
});

router.get('/jobs/:id', (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return next();

  const job = getJobById(id);
  if (!job) return next();

  const resume = getPrimaryResume();
  let score = null;
  let breakdown = { matched_keywords: [], missing_skills: [], total_keywords: 0 };
  if (resume) {
    const fit = getBestFitScoreForJob(job.id);
    if (fit) {
      score = fit;
      try {
        breakdown = JSON.parse(fit.breakdown_json || '{}') || breakdown;
      } catch {
        // ignore parse error
      }
    }
  }

  const company =
    job.company_name && getCompanyByName(job.company_name)
      ? getCompanyByName(job.company_name)
      : null;

  const coverLetter =
    resume && getCoverLetter(job.id, resume.id, 'zh')
      ? getCoverLetter(job.id, resume.id, 'zh')
      : null;

  res.render('jobs/detail', {
    job,
    resume,
    score,
    breakdown,
    company,
    coverLetter,
  });
});

module.exports = router;

