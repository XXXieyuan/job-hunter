const { getDb } = require('../db/connection');
const duplicateGroupsRepo = require('../repositories/duplicateGroupsRepo');
const { getLogger } = require('../logger');

const logger = getLogger('deduplicationService');

/**
 * Normalize a string for deduplication comparison:
 * lowercase, collapse whitespace, strip punctuation, trim.
 */
function normalizeForComparison(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // strip punctuation
    .replace(/\s+/g, ' ')    // collapse whitespace
    .trim();
}

/**
 * Normalize company name with extra handling for common variations.
 * E.g., "Acme Pty Ltd" and "Acme Pty. Ltd." should match.
 */
function normalizeCompany(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/\bpty\.?\s*ltd\.?\b/gi, '')
    .replace(/\blimited\b/gi, '')
    .replace(/\binc\.?\b/gi, '')
    .replace(/\bcorp(oration)?\.?\b/gi, '')
    .replace(/\bgroup\b/gi, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize location for comparison.
 */
function normalizeLocation(location) {
  if (!location || typeof location !== 'string') return '';
  return location
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if two jobs are likely duplicates based on normalized title + company + location.
 *
 * @param {object} jobA - Job record
 * @param {object} jobB - Job record
 * @returns {object} { isDuplicate: boolean, confidence: number, method: string }
 */
function comparePair(jobA, jobB) {
  const titleA = normalizeForComparison(jobA.title);
  const titleB = normalizeForComparison(jobB.title);
  const companyA = normalizeCompany(jobA.company_name);
  const companyB = normalizeCompany(jobB.company_name);
  const locA = normalizeLocation(jobA.location);
  const locB = normalizeLocation(jobB.location);

  // Must have matching company (or both empty)
  if (companyA !== companyB) return { isDuplicate: false, confidence: 0, method: null };

  // Must have matching title
  if (titleA !== titleB) return { isDuplicate: false, confidence: 0, method: null };

  // Title + company match
  if (titleA && companyA) {
    // If location also matches or one is missing, high confidence
    const locationMatch = !locA || !locB || locA === locB;
    const confidence = locationMatch ? 0.95 : 0.80;
    return {
      isDuplicate: true,
      confidence,
      method: 'title_company_location',
    };
  }

  return { isDuplicate: false, confidence: 0, method: null };
}

/**
 * Find and group all duplicate jobs across the active job set.
 * Groups jobs by normalized (title + company) key.
 * Creates duplicate groups via duplicateGroupsRepo.
 * Marks non-canonical jobs with canonical_job_id.
 *
 * @param {object} opts - { dryRun: boolean, onProgress: function }
 * @returns {object} { groupsCreated, jobsMarked, groups: [...] }
 */
/**
 * Normalize a URL for dedup comparison:
 *   - lowercase host
 *   - strip tracking query params (utm_*, ref, refId, trackingId, etc.)
 *   - drop fragment
 *   - drop trailing slash
 */
function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url.trim());
    // Strip common tracking / session params
    const dropPrefixes = ['utm_', 'mc_', 'gclid', 'fbclid'];
    const dropExact = new Set([
      'ref', 'refid', 'trackingid', 'trk', 'trk_trk',
      'position', 'pagenum', 'source', 'campaign', 'origin',
    ]);
    for (const key of Array.from(u.searchParams.keys())) {
      const lower = key.toLowerCase();
      if (dropExact.has(lower)) u.searchParams.delete(key);
      else if (dropPrefixes.some((p) => lower.startsWith(p))) u.searchParams.delete(key);
    }
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return url.trim().toLowerCase();
  }
}

function detectDuplicates(opts = {}) {
  const db = getDb();

  // Get all active jobs that are not already marked as duplicates
  const jobs = db.prepare(
    `SELECT id, external_id, source, title, company_name, location, url, created_at
     FROM jobs
     WHERE is_active = 1 AND canonical_job_id IS NULL
     ORDER BY created_at ASC`
  ).all();

  logger.info(`Scanning ${jobs.length} jobs for duplicates`);

  // Two-pass grouping:
  //   Pass 1 — canonical URL (strongest signal; same URL = same job).
  //   Pass 2 — title + company on jobs NOT already bucketed with siblings
  //            via URL (catches cross-source duplicates with different URLs).
  const urlGroups = new Map();
  for (const job of jobs) {
    const normUrl = normalizeUrl(job.url);
    if (!normUrl) continue;
    const key = `url:${normUrl}`;
    if (!urlGroups.has(key)) urlGroups.set(key, []);
    urlGroups.get(key).push(job);
  }

  const groups = new Map();
  const claimedByUrl = new Set();

  // First: keep URL groups that have actual duplicates (>= 2 members)
  for (const [key, members] of urlGroups) {
    if (members.length > 1) {
      groups.set(key, members);
      for (const m of members) claimedByUrl.add(m.id);
    }
  }

  // Second: group remaining jobs by title + company
  for (const job of jobs) {
    if (claimedByUrl.has(job.id)) continue;
    const tc = `${normalizeForComparison(job.title)}|||${normalizeCompany(job.company_name)}`;
    if (!tc || tc === '|||') continue;
    const key = `tc:${tc}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }

  // Filter to only groups with >1 job (actual duplicates)
  const duplicateGroups = [];
  for (const [key, members] of groups) {
    if (members.length > 1) {
      duplicateGroups.push({ key, members });
    }
  }

  logger.info(`Found ${duplicateGroups.length} duplicate groups`);

  if (opts.dryRun) {
    return {
      groupsCreated: 0,
      jobsMarked: 0,
      groups: duplicateGroups.map((g) => ({
        key: g.key,
        count: g.members.length,
        jobs: g.members.map((j) => ({ id: j.id, source: j.source, title: j.title })),
      })),
    };
  }

  let groupsCreated = 0;
  let jobsMarked = 0;

  const createGroupsTx = db.transaction(() => {
    for (const group of duplicateGroups) {
      // Pick the canonical job: prefer earliest created, or first source priority
      const canonical = pickCanonical(group.members);

      // Check if a duplicate group already exists for this canonical job
      const existingGroups = duplicateGroupsRepo.findByJobId(canonical.id);
      if (existingGroups && existingGroups.length > 0) {
        // Add new members to existing group
        for (const member of group.members) {
          if (member.id !== canonical.id) {
            duplicateGroupsRepo.addMember(existingGroups[0].id, member.id);
            // Mark duplicate in jobs table
            db.prepare(
              'UPDATE jobs SET canonical_job_id = ? WHERE id = ? AND canonical_job_id IS NULL'
            ).run(canonical.id, member.id);
            jobsMarked++;
          }
        }
        continue;
      }

      // Create new duplicate group. Key tells us which signal matched:
      //   url:...        → canonical URL match (strongest, ~1.0 confidence)
      //   tc:title|||co  → title + company fallback (~0.95)
      const matchedByUrl = group.key && group.key.startsWith('url:');
      const groupId = duplicateGroupsRepo.createGroup({
        canonical_job_id: canonical.id,
        match_method: matchedByUrl ? 'canonical_url' : 'title_company_location',
        confidence: matchedByUrl ? 1.0 : 0.95,
      });

      // Add all members (including canonical)
      for (const member of group.members) {
        duplicateGroupsRepo.addMember(groupId, member.id);
        if (member.id !== canonical.id) {
          // Mark non-canonical as duplicate
          db.prepare(
            'UPDATE jobs SET canonical_job_id = ? WHERE id = ? AND canonical_job_id IS NULL'
          ).run(canonical.id, member.id);
          jobsMarked++;
        }
      }

      groupsCreated++;

      if (opts.onProgress) {
        opts.onProgress(groupsCreated, duplicateGroups.length);
      }
    }
  });

  createGroupsTx();

  logger.info(`Deduplication complete: ${groupsCreated} groups created, ${jobsMarked} jobs marked`);

  return {
    groupsCreated,
    jobsMarked,
    groups: duplicateGroups.map((g) => ({
      key: g.key,
      count: g.members.length,
      jobs: g.members.map((j) => ({ id: j.id, source: j.source, title: j.title })),
    })),
  };
}

/**
 * Pick the canonical job from a set of duplicates.
 * Priority: earliest created_at, then prefer more complete data.
 *
 * @param {object[]} jobs - Array of job records
 * @returns {object} The canonical job
 */
function pickCanonical(jobs) {
  return jobs.reduce((best, job) => {
    // Prefer job with more complete data (has description, url, etc.)
    const bestScore = (best.description ? 1 : 0) + (best.url ? 1 : 0) + (best.salary ? 1 : 0);
    const jobScore = (job.description ? 1 : 0) + (job.url ? 1 : 0) + (job.salary ? 1 : 0);

    if (jobScore > bestScore) return job;
    if (jobScore === bestScore && job.created_at < best.created_at) return job;
    return best;
  });
}

module.exports = {
  normalizeForComparison,
  normalizeCompany,
  normalizeLocation,
  normalizeUrl,
  comparePair,
  detectDuplicates,
  pickCanonical,
};
