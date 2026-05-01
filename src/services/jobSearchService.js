'use strict';

const {
  getJobsWithScore,
  searchJobs,
  searchJobsByIdentifier,
} = require('../repositories/jobsRepo');
const { sanitizeFtsQuery } = require('../utils/ftsQuerySanitizer');
const { classifyJobTitle, getAllCategories } = require('../utils/roleCategory');

function looksLikeDirectIdentifier(value) {
  if (!value || typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^https?:\/\//i.test(trimmed) || /\b[A-Za-z]{2,}-\d{4,}\b/.test(trimmed);
}

function normalizeSource(source) {
  if (!source) return '';
  if (Array.isArray(source)) {
    return source.map((s) => String(s || '').trim()).filter(Boolean);
  }
  return String(source)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeRoles(roles) {
  if (!roles) return [];
  if (Array.isArray(roles)) return roles.map(String).map((s) => s.trim()).filter(Boolean);
  return String(roles).split(',').map((s) => s.trim()).filter(Boolean);
}

function normalizePositiveNumber(value) {
  if (value === undefined || value === null || value === '') return '';
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : '';
}

function normalizeFilters(raw = {}) {
  return {
    keyword: String(raw.keyword || '').trim(),
    location: String(raw.location || '').trim(),
    source: normalizeSource(raw.source),
    workType: String(raw.workType || raw.work_type || '').trim(),
    visa: String(raw.visa || raw.visa_eligibility || '').trim(),
    minScore: normalizePositiveNumber(raw.minScore),
    salaryMin: normalizePositiveNumber(raw.salaryMin || raw.minSalary || raw.salary_min),
    salaryMax: normalizePositiveNumber(raw.salaryMax || raw.maxSalary || raw.salary_max),
    roles: normalizeRoles(raw.roles),
  };
}

function buildRepoFilters(filters, sort) {
  const repoFilters = {};
  if (filters.source && filters.source.length > 0) repoFilters.source = filters.source;
  if (filters.location) repoFilters.location = filters.location;
  if (filters.workType) repoFilters.work_type = filters.workType;
  if (filters.visa) repoFilters.visa_eligibility = filters.visa;
  if (Number.isFinite(filters.minScore) && filters.minScore > 0) repoFilters.minScore = filters.minScore;
  repoFilters.sort = sort === 'score' ? undefined : 'posted_at';
  repoFilters.limit = 10000;
  repoFilters.offset = 0;
  return repoFilters;
}

function getNumericSalary(job, key) {
  const value = job && job[key];
  if (value === undefined || value === null || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function applyInMemoryFilters(jobs, filters) {
  let result = jobs;

  if (Number.isFinite(filters.salaryMin) && filters.salaryMin > 0) {
    result = result.filter((job) => {
      const salaryMin = getNumericSalary(job, 'salary_min');
      return salaryMin !== null && salaryMin >= filters.salaryMin;
    });
  }

  if (Number.isFinite(filters.salaryMax) && filters.salaryMax > 0) {
    result = result.filter((job) => {
      const salaryMin = getNumericSalary(job, 'salary_min');
      return salaryMin !== null && salaryMin <= filters.salaryMax;
    });
  }

  return result;
}

function sortJobs(jobs, sort) {
  if (sort === 'salary') {
    jobs.sort((a, b) => {
      const aSalary = getNumericSalary(a, 'salary_min');
      const bSalary = getNumericSalary(b, 'salary_min');
      if (aSalary === null && bSalary === null) return 0;
      if (aSalary === null) return 1;
      if (bSalary === null) return -1;
      return bSalary - aSalary;
    });
  }
  return jobs;
}

function loadMatchingJobs(filters, repoFilters) {
  const keyword = filters.keyword;
  const ftsQuery = keyword ? sanitizeFtsQuery(keyword) : null;

  if (looksLikeDirectIdentifier(keyword)) {
    const identifierJobs = searchJobsByIdentifier(keyword, repoFilters);
    if (identifierJobs.length === 0 && ftsQuery) return searchJobs(ftsQuery, repoFilters);
    return identifierJobs;
  }

  if (ftsQuery) {
    const ftsJobs = searchJobs(ftsQuery, repoFilters);
    if (ftsJobs.length === 0 && keyword) return searchJobsByIdentifier(keyword, repoFilters);
    return ftsJobs;
  }

  if (keyword) return searchJobsByIdentifier(keyword, repoFilters);
  return getJobsWithScore(repoFilters);
}

function searchJobsForBoard({ filters: rawFilters = {}, sort = 'newest', page = 1, perPage = 20 } = {}) {
  const filters = normalizeFilters(rawFilters);
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safePerPage = Math.min(50, Math.max(1, parseInt(perPage, 10) || 20));
  const repoFilters = buildRepoFilters(filters, sort);
  let jobs = loadMatchingJobs(filters, repoFilters);
  jobs = applyInMemoryFilters(jobs, filters);
  jobs = sortJobs(jobs, sort);

  for (const job of jobs) {
    job.role_category = classifyJobTitle(job.title);
  }

  const categoryCounts = {};
  for (const job of jobs) {
    categoryCounts[job.role_category] = (categoryCounts[job.role_category] || 0) + 1;
  }

  if (filters.roles.length > 0) {
    jobs = jobs.filter((job) => filters.roles.includes(job.role_category));
  }

  const totalCount = jobs.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / safePerPage));
  const start = (safePage - 1) * safePerPage;
  const pagedJobs = jobs.slice(start, start + safePerPage);

  return {
    jobs: pagedJobs,
    filters,
    page: safePage,
    totalCount,
    totalPages,
    categoryCounts,
    allCategories: getAllCategories(),
  };
}

function buildSectionPreviews(sections, { perSection = 6 } = {}) {
  return sections.map((section) => {
    const result = searchJobsForBoard({
      filters: section.filters || {},
      sort: (section.filters && section.filters.sort) || 'newest',
      page: 1,
      perPage: perSection,
    });
    return {
      ...section,
      jobs: result.jobs,
      totalCount: result.totalCount,
      filters: result.filters,
    };
  });
}

module.exports = {
  normalizeFilters,
  searchJobs: searchJobsForBoard,
  buildSectionPreviews,
  _looksLikeDirectIdentifier: looksLikeDirectIdentifier,
};
