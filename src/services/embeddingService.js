/**
 * Embedding service — precompute-at-ingest model.
 *
 * Jobs and resumes both have an `embedding` BLOB column. The canonical flow
 * is: embed once at ingest/upload time, store, and let scoring do a local
 * cosine similarity against the stored vectors. This module is the single
 * home for:
 *
 *   - text-building rules (what fields go into the vector)
 *   - BLOB codec (Float64Array <-> Buffer)
 *   - local cosine similarity
 *   - the `embed-jobs` background-queue handler
 */

const { generateEmbedding, chatCompletion, hasOpenAIKey } = require('./openAIClient');
const { OPENAI_EMBEDDING_MODEL } = require('../config');
const backgroundQueue = require('./backgroundQueue');
const jobsRepo = require('../repositories/jobsRepo');
const { getLogger } = require('../logger');

const logger = getLogger('embeddingService');

const DEFAULT_MODEL = OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';

// ---------------------------------------------------------------------------
// Text building
// ---------------------------------------------------------------------------

/**
 * Concatenate the fields of a job that meaningfully describe the role. Kept
 * simple: title first (heavily weighted by virtue of being at the top), then
 * company, location, then the description. Matches what a scoring agent
 * would read at a glance.
 */
function buildJobEmbeddingText(job) {
  if (!job) return '';
  const parts = [
    job.title || job.role || '',
    job.company_name || job.company || '',
    job.location || '',
    job.description || '',
  ];
  return parts.filter(Boolean).join('\n\n').trim();
}

// ---------------------------------------------------------------------------
// BLOB codec
// ---------------------------------------------------------------------------

/**
 * Pack a JS number[] / Float64Array into the exact Buffer shape the resume
 * confirmation path already writes: `Buffer.from(new Float64Array(v).buffer)`.
 * Using the same shape for jobs means decode is identical for both.
 */
function bufferFromFloats(vec) {
  if (!vec) return null;
  const arr = vec instanceof Float64Array ? vec : new Float64Array(vec);
  return Buffer.from(arr.buffer);
}

/**
 * Decode a stored embedding back to a Float64Array. Returns null for
 * missing / malformed input so callers can fall through to "compute on the
 * fly" cleanly.
 */
function decodeEmbedding(blob) {
  if (!blob) return null;
  try {
    // better-sqlite3 returns BLOBs as Buffer already
    const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    // Float64Array on a Buffer needs an aligned view — slice the underlying
    // ArrayBuffer so byteOffset/byteLength match.
    return new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
  } catch (err) {
    logger.warn('Failed to decode embedding', { error: err.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cosine similarity (local, no API)
// ---------------------------------------------------------------------------

/**
 * Returns cosine similarity in [-1, 1]. Assumes both inputs are dense
 * Float64Array of the same length (both OpenAI text-embedding-3-* models
 * return fixed-length vectors). Returns 0 if lengths don't line up — avoids
 * propagating a bogus score.
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

/**
 * Embed every active job that has no stored embedding yet, up to `limit`.
 * Returns a summary dict for the queue / admin UI.
 */
async function embedMissingJobs({ limit = 1000 } = {}) {
  const jobs = jobsRepo.getJobsMissingEmbedding(limit);
  logger.info('Embedding missing jobs', { candidateCount: jobs.length });

  let embedded = 0;
  let errors = 0;
  for (const job of jobs) {
    try {
      const text = buildJobEmbeddingText(job);
      if (!text) continue;
      const v = await generateEmbedding(text);
      if (!v) continue;
      jobsRepo.updateJobEmbedding(job.id, bufferFromFloats(v), DEFAULT_MODEL);
      embedded++;
    } catch (err) {
      errors++;
      logger.warn('Failed to embed job', { jobId: job.id, error: err.message });
    }
  }
  logger.info('Embedding batch complete', { embedded, errors, candidateCount: jobs.length });
  return { candidateCount: jobs.length, embedded, errors };
}

// ---------------------------------------------------------------------------
// Required-skills extraction (LLM)
// ---------------------------------------------------------------------------

/**
 * Extract the ~5-15 required hard skills from a job description via LLM.
 * Returns a lowercased, deduped array. `null` on failure (caller decides
 * whether to fall back to resume-skill-in-description heuristic).
 */
async function extractJobRequiredSkills(job) {
  if (!hasOpenAIKey()) return null;
  const text = [job.title || '', job.description || ''].filter(Boolean).join('\n');
  if (!text.trim()) return null;
  const prompt = `Extract the HARD technical skills, tools, and certifications that this job REQUIRES. Ignore "nice to haves", soft skills, and generic words like "communication" or "leadership".

Output format: a JSON array of short skill names, lowercase, no duplicates, no version numbers. Example: ["python", "tensorflow", "sql", "aws", "docker", "kubernetes"]. Target 5-15 items.

Job:
${text.slice(0, 6000)}

Output ONLY the JSON array.`;
  try {
    // Default reasoning_effort applies (xhigh). Can be tuned down to
    // 'minimal' later once we've measured actual output quality vs cost.
    const raw = await chatCompletion(
      [{ role: 'user', content: prompt }],
      { temperature: 0.1, max_tokens: 2048 }
    );
    if (!raw) return null;
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) return null;
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return null;
    // Normalize: lowercase, trim, drop empties, dedupe, cap length.
    const seen = new Set();
    const out = [];
    for (const s of arr) {
      if (typeof s !== 'string') continue;
      const v = s.toLowerCase().trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
      if (out.length >= 20) break;
    }
    return out;
  } catch (err) {
    logger.warn('extractJobRequiredSkills failed', { jobId: job.id, error: err.message });
    return null;
  }
}

async function extractSkillsForMissingJobs({ limit = 200 } = {}) {
  const jobs = jobsRepo.getJobsMissingRequiredSkills(limit);
  logger.info('Extracting required skills for jobs', { candidateCount: jobs.length });
  let extracted = 0;
  let errors = 0;
  for (const job of jobs) {
    try {
      const skills = await extractJobRequiredSkills(job);
      if (!skills) continue;
      jobsRepo.updateJobRequiredSkills(job.id, JSON.stringify(skills));
      extracted++;
    } catch (err) {
      errors++;
      logger.warn('Skill extract failed', { jobId: job.id, error: err.message });
    }
  }
  logger.info('Skill extraction batch complete', { extracted, errors, candidateCount: jobs.length });
  return { candidateCount: jobs.length, extracted, errors };
}

// ---------------------------------------------------------------------------
// Background queue wiring
// ---------------------------------------------------------------------------

backgroundQueue.registerHandler('embed-jobs', async (params) => {
  return embedMissingJobs(params || {});
});

backgroundQueue.registerHandler('extract-job-skills', async (params) => {
  return extractSkillsForMissingJobs(params || {});
});

module.exports = {
  buildJobEmbeddingText,
  bufferFromFloats,
  decodeEmbedding,
  cosineSimilarity,
  embedMissingJobs,
  extractJobRequiredSkills,
  extractSkillsForMissingJobs,
};
