'use strict';

const OpenAI = require('openai');
const { getDb, TABLES } = require('../db/database');
const { getConfig } = require('./configService');
const { log } = require('../utils/logger');

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const TECH_KEYWORDS = [
  'python', 'javascript', 'typescript', 'node', 'react', 'vue', 'angular',
  'sql', 'sqlite', 'postgresql', 'aws', 'azure', 'gcp', 'docker',
  'kubernetes', 'machine learning', 'deep learning', 'nlp', 'llm',
  'openai', 'data science', 'data engineering', 'api', 'microservices',
  'terraform', 'linux', 'ci/cd', 'pytest', 'playwright'
];

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  return normalizeText(text)
    .split(' ')
    .filter((token) => token.length > 2);
}

function extractKeywords(jobDescription) {
  const normalized = normalizeText(jobDescription);
  const found = TECH_KEYWORDS.filter((keyword) => normalized.includes(keyword));
  const longTokens = tokenize(jobDescription)
    .filter((token) => /[a-z]/.test(token))
    .slice(0, 40);

  return Array.from(new Set([...found, ...longTokens]));
}

function cosineSimilarity(left, right) {
  if (!left.length || !right.length || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }

  if (!leftMagnitude || !rightMagnitude) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function skillMatch(jobDescription, resumeSkills) {
  const descriptionTokens = new Set(extractKeywords(jobDescription));
  const skillTokens = new Set(
    (resumeSkills || [])
      .flatMap((skill) => tokenize(skill))
      .filter(Boolean)
  );

  if (!descriptionTokens.size || !skillTokens.size) {
    return 0;
  }

  const intersection = [...descriptionTokens].filter((token) => skillTokens.has(token));
  const union = new Set([...descriptionTokens, ...skillTokens]);

  return Number(((intersection.length / union.size) * 100).toFixed(2));
}

function keywordMatch(jobDescription, resumeText) {
  const keywords = extractKeywords(jobDescription);
  const normalizedResume = normalizeText(resumeText);

  if (!keywords.length || !normalizedResume) {
    return 0;
  }

  let score = 0;

  for (const keyword of keywords) {
    if (normalizedResume.includes(keyword)) {
      score += 1;
    }
  }

  return Number(((score / keywords.length) * 100).toFixed(2));
}

async function semanticMatch(jobDescription, resumeText) {
  const config = getConfig();
  if (!config.openaiApiKey || !config.openaiBaseUrl) {
    return null;
  }

  try {
    const client = new OpenAI({
      apiKey: config.openaiApiKey,
      baseURL: config.openaiBaseUrl
    });

    const response = await client.embeddings.create({
      model: process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
      input: [jobDescription.slice(0, 8_000), resumeText.slice(0, 8_000)]
    });

    const vectors = response.data || [];
    if (vectors.length < 2) {
      return null;
    }

    const similarity = cosineSimilarity(vectors[0].embedding, vectors[1].embedding);
    return Number(Math.max(0, similarity * 100).toFixed(2));
  } catch (error) {
    log('warn', 'SEMANTIC_MATCH_FALLBACK', error.message);
    return null;
  }
}

function calculateGapAnalysis(jobDescription, resumeText, resumeSkills) {
  const jobKeywords = extractKeywords(jobDescription);
  const normalizedResume = normalizeText(resumeText);
  const normalizedSkills = new Set((resumeSkills || []).map((skill) => normalizeText(skill)));
  const missing = [];
  const weak = [];
  const strong = [];

  for (const keyword of jobKeywords.slice(0, 20)) {
    const inSkills = normalizedSkills.has(normalizeText(keyword));
    const inResume = normalizedResume.includes(normalizeText(keyword));

    if (inSkills || inResume) {
      strong.push(keyword);
    } else if (keyword.includes(' ')) {
      weak.push(keyword);
    } else {
      missing.push(keyword);
    }
  }

  return {
    missing: missing.slice(0, 8),
    weak: weak.slice(0, 8),
    strong: strong.slice(0, 8)
  };
}

function compositeScore(skillScore, semanticScore, keywordScore) {
  if (semanticScore === null || semanticScore === undefined) {
    return Number(((skillScore * 0.5) + (keywordScore * 0.5)).toFixed(2));
  }

  return Number(((skillScore * 0.4) + (semanticScore * 0.4) + (keywordScore * 0.2)).toFixed(2));
}

function getJobAndResume(jobId, resumeId) {
  const db = getDb();
  const job = db.prepare(`SELECT * FROM ${TABLES.JOBS} WHERE id = ?`).get(jobId);
  const resume = db.prepare(`SELECT * FROM ${TABLES.RESUMES} WHERE id = ?`).get(resumeId);

  if (!job) {
    const error = new Error(`Job with id ${jobId} not found`);
    error.statusCode = 404;
    error.code = 'NOT_FOUND';
    throw error;
  }

  if (!resume) {
    const error = new Error(`Resume with id ${resumeId} not found`);
    error.statusCode = 404;
    error.code = 'NOT_FOUND';
    throw error;
  }

  return {
    job,
    resume: {
      ...resume,
      parsed_data: JSON.parse(resume.parsed_data || '{}')
    }
  };
}

function saveMatch(jobId, resumeId, result) {
  const db = getDb();
  db.prepare(`
    INSERT INTO ${TABLES.MATCHES} (
      job_id,
      resume_id,
      total_score,
      skill_score,
      semantic_score,
      keyword_score,
      gap_analysis
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id, resume_id) DO UPDATE SET
      total_score = excluded.total_score,
      skill_score = excluded.skill_score,
      semantic_score = excluded.semantic_score,
      keyword_score = excluded.keyword_score,
      gap_analysis = excluded.gap_analysis,
      analyzed_at = datetime('now')
  `).run(
    jobId,
    resumeId,
    result.total_score,
    result.skill_score,
    result.semantic_score,
    result.keyword_score,
    JSON.stringify(result.gap_analysis)
  );

  return db
    .prepare(`SELECT * FROM ${TABLES.MATCHES} WHERE job_id = ? AND resume_id = ?`)
    .get(jobId, resumeId);
}

async function runMatch(jobId, resumeId) {
  const db = getDb();
  const cached = db
    .prepare(`SELECT * FROM ${TABLES.MATCHES} WHERE job_id = ? AND resume_id = ?`)
    .get(jobId, resumeId);

  if (cached) {
    return {
      ...cached,
      gap_analysis: JSON.parse(cached.gap_analysis || '{}'),
      cached: true
    };
  }

  const { job, resume } = getJobAndResume(jobId, resumeId);
  const resumeText = resume.parsed_data.rawText || '';
  const resumeSkills = resume.parsed_data.skills || [];
  const skillScore = skillMatch(job.job_description, resumeSkills);
  const keywordScore = keywordMatch(job.job_description, resumeText);
  const semanticScore = await semanticMatch(job.job_description, resumeText);
  const gapAnalysis = calculateGapAnalysis(job.job_description, resumeText, resumeSkills);
  const totalScore = compositeScore(skillScore, semanticScore, keywordScore);

  const saved = saveMatch(jobId, resumeId, {
    total_score: totalScore,
    skill_score: skillScore,
    semantic_score: semanticScore,
    keyword_score: keywordScore,
    gap_analysis: gapAnalysis
  });

  log('info', 'MATCH_RUN', `Matched job ${jobId} with resume ${resumeId}`);

  return {
    ...saved,
    gap_analysis: gapAnalysis,
    cached: false
  };
}

async function batchMatch(jobIds = [], resumeId) {
  const db = getDb();
  const activeResumeId = resumeId || db.prepare(
    `SELECT id FROM ${TABLES.RESUMES} WHERE is_primary = 1 ORDER BY id DESC LIMIT 1`
  ).get()?.id;

  if (!activeResumeId) {
    const error = new Error('Primary resume is required before matching');
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    throw error;
  }

  const ids = Array.isArray(jobIds) && jobIds.length
    ? jobIds
    : db.prepare(`
        SELECT jobs.id
        FROM ${TABLES.JOBS} jobs
        LEFT JOIN ${TABLES.MATCHES} matches
          ON matches.job_id = jobs.id AND matches.resume_id = ?
        WHERE matches.id IS NULL
        ORDER BY jobs.created_at DESC
      `).all(activeResumeId).map((row) => row.id);

  let matched = 0;
  let skipped = 0;

  for (const jobId of ids) {
    const cached = db
      .prepare(`SELECT id FROM ${TABLES.MATCHES} WHERE job_id = ? AND resume_id = ?`)
      .get(jobId, activeResumeId);

    if (cached) {
      skipped += 1;
      log('info', 'MATCH_SKIP', `Skipped existing match for job ${jobId}`);
      continue;
    }

    await runMatch(jobId, activeResumeId);
    matched += 1;
  }

  return { matched, skipped, resumeId: activeResumeId };
}

module.exports = {
  batchMatch,
  calculateGapAnalysis,
  compositeScore,
  keywordMatch,
  runMatch,
  semanticMatch,
  skillMatch
};

Object.assign(globalThis, { runMatch, batchMatch });
