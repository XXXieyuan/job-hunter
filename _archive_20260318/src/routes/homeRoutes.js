const express = require('express');
const router = express.Router();
const { t } = require('../i18n');
const { getJobsCount } = require('../repositories/jobsRepo');
const { getResumesCount } = require('../repositories/resumesRepo');
const { getMatchesCount } = require('../repositories/matchesRepo');

router.get('/', async (req, res) => {
  const stats = {
    jobs: getJobsCount(),
    resumes: getResumesCount(),
    matches: getMatchesCount(),
  };
  
  res.render('home', { 
    title: t('app.fullTitle'),
    stats,
  });
});

module.exports = router;
