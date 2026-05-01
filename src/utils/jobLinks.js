function parseRawJobData(rawJson) {
  if (!rawJson) return null;
  if (typeof rawJson === 'object') return rawJson;

  try {
    return JSON.parse(rawJson);
  } catch {
    return null;
  }
}

function normalizeHttpUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function slugifyApsTitle(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  return trimmed
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' ')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .toLowerCase() || null;
}

function buildApsDetailUrl(title, jobId) {
  const normalizedJobId = typeof jobId === 'string' ? jobId.trim() : '';
  if (!normalizedJobId) return null;

  const slug = slugifyApsTitle(title);
  const url = new URL('https://www.apsjobs.gov.au/s/job-details');
  if (slug) {
    url.searchParams.set('title', slug);
  }
  url.searchParams.set('Id', normalizedJobId);
  return url.toString();
}

function getApsDetailUrl(job) {
  if (!job || job.source !== 'apsjobs') return null;

  const raw = parseRawJobData(job.raw_json);
  if (!raw || typeof raw !== 'object') return null;

  const title = raw.jobName || job.title || '';
  return buildApsDetailUrl(title, raw.jobId || raw.job_id || null);
}

function getApsApplicationUrl(job) {
  if (!job || job.source !== 'apsjobs') return null;

  const raw = parseRawJobData(job.raw_json);
  if (!raw || typeof raw !== 'object') return null;

  return normalizeHttpUrl(raw.applicationURL || raw.application_url || null);
}

function getJobSourceUrl(job) {
  return getApsDetailUrl(job) || normalizeHttpUrl(job && job.url);
}

function getJobApplyUrl(job) {
  return getApsApplicationUrl(job) || getJobSourceUrl(job);
}

module.exports = {
  buildApsDetailUrl,
  getApsDetailUrl,
  getApsApplicationUrl,
  getJobSourceUrl,
  getJobApplyUrl,
  _normalizeHttpUrl: normalizeHttpUrl,
  _parseRawJobData: parseRawJobData,
  _slugifyApsTitle: slugifyApsTitle,
};
