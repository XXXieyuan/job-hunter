const express = require('express');
const { getDb } = require('../db/connection');
const { getResumeById } = require('../repositories/resumesRepo');
const { scoreJobAgainstResume } = require('../services/scoringService');
const { getLogger } = require('../logger');

const logger = getLogger('apiMatchRoutes');

const router = express.Router();

async function getJobsForMatching(limit) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, title, company_name, location, source, description
       FROM jobs
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(limit);
  return rows;
}

router.post('/api/match', express.json({ limit: '1mb' }), async (req, res) => {
  const body = req.body || {};
  const resumeIdRaw = body.resume_id;
  const limitRaw = body.limit;

  const resumeId = Number(resumeIdRaw);
  if (!Number.isFinite(resumeId)) {
    return res.status(400).json({ error: 'Invalid resume_id' });
  }

  let limit = Number(limitRaw);
  if (!Number.isFinite(limit) || limit <= 0) {
    limit = 50;
  }

  const resume = getResumeById(resumeId);
  if (!resume) {
    return res.status(404).json({ error: 'Resume not found' });
  }

  try {
    const jobs = await getJobsForMatching(500);

    const matches = [];
    // Compute score for each job; reuse scoringService so behaviour matches analysis.
    // scoringService returns scores in [0, 100]; API expects [0, 1].
    // eslint-disable-next-line no-restricted-syntax
    for (const job of jobs) {
      // eslint-disable-next-line no-await-in-loop
      const fit = await scoreJobAgainstResume(job, resume);
      const overallScore =
        typeof fit.overall_score === 'number'
          ? fit.overall_score / 100
          : 0;
      const similarityScore =
        typeof fit.embedding_score === 'number'
          ? fit.embedding_score / 100
          : 0;
      const skillScore =
        typeof fit.keyword_score === 'number'
          ? fit.keyword_score / 100
          : 0;

      const breakdown = fit.breakdown || {};
      const matchedSkills = Array.isArray(breakdown.matched_keywords)
        ? breakdown.matched_keywords
        : [];
      const missingSkills = Array.isArray(breakdown.missing_skills)
        ? breakdown.missing_skills
        : [];
      const totalKeywords = breakdown.total_keywords || matchedSkills.length + missingSkills.length;

      const highlights = [
        `Matched ${matchedSkills.length} of ${totalKeywords || 0} skills`,
      ];

      matches.push({
        job_id: job.id,
        overall_score: overallScore,
        similarity_score: similarityScore,
        skill_score: skillScore,
        job: {
          title: job.title,
          company_name: job.company_name,
          location: job.location,
          source: job.source,
        },
        explanation: {
          matched_skills: matchedSkills,
          missing_skills: missingSkills,
          highlights,
        },
      });
    }

    matches.sort(
      (a, b) => (b.overall_score || 0) - (a.overall_score || 0),
    );

    const limited = matches.slice(0, limit);

    res.json({
      resume_id: resume.id,
      matches: limited,
    });
  } catch (err) {
    logger.error('Failed to compute match results', { err });
    res
      .status(500)
      .json({ error: err && err.message ? err.message : 'Failed to compute matches' });
  }
});

// History is not yet persisted in v1 schema; return an empty list so the
// frontend can render without errors.
router.get('/api/match/history', (req, res) => {
  res.json([]);
});

module.exports = router;

