const { hasOpenAIKey, getEmbedding } = require('./openAIClient');

const KEYWORD_WEIGHT = 0.4;
const EMBEDDING_WEIGHT = 0.6;

const KNOWN_KEYWORDS = [
  'python',
  'javascript',
  'node.js',
  'node',
  'react',
  'tensorflow',
  'pytorch',
  'sql',
  'postgresql',
  'aws',
  'docker',
  'kubernetes',
  'agile',
  'scrum',
  'kanban',
  'product',
  'product management',
  'data analysis',
  'machine learning',
  'ml',
  'nlp',
  'natural language processing',
  'computer vision',
];

function normalize(text) {
  return (text || '').toLowerCase();
}

function extractKeywordsFromText(text) {
  const lower = normalize(text);
  const found = new Set();
  for (const kw of KNOWN_KEYWORDS) {
    if (lower.includes(kw)) {
      found.add(kw);
    }
  }
  return Array.from(found);
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function scoreJobAgainstResume(job, resume) {
  const jobText = `${job.title || ''}\n${job.description || ''}`;
  const resumeSkills = resume.skills_json ? JSON.parse(resume.skills_json) : [];
  const experience = resume.experience_json ? JSON.parse(resume.experience_json) : [];
  const experienceText = experience
    .map((e) => `${e.title || ''} ${e.company || ''} ${e.description || ''}`)
    .join('\n');

  const jobKeywords = extractKeywordsFromText(jobText);

  const resumeTextCombined = [
    resume.summary || '',
    Array.isArray(resumeSkills) ? resumeSkills.join(', ') : '',
    experienceText,
  ].join('\n');

  const resumeKeywords = extractKeywordsFromText(resumeTextCombined);

  const matchedKeywords = jobKeywords.filter((kw) =>
    resumeKeywords.includes(kw)
  );
  const missingSkills = jobKeywords.filter((kw) => !resumeKeywords.includes(kw));

  const totalKeywords = jobKeywords.length || 1;
  let keywordScore = (matchedKeywords.length / totalKeywords) * 100;

  const jobTitleNorm = normalize(job.title || '');
  const experienceTitles = experience
    .map((e) => normalize(e.title || ''))
    .join(' ');
  if (
    (jobTitleNorm.includes('product') && experienceTitles.includes('product')) ||
    (jobTitleNorm.includes('engineer') && experienceTitles.includes('engineer')) ||
    (jobTitleNorm.includes('ai') && experienceTitles.includes('ai'))
  ) {
    keywordScore = Math.min(keywordScore + 10, 100);
  }

  let embeddingScore = null;
  if (hasOpenAIKey()) {
    try {
      const [jobEmbedding, resumeEmbedding] = await Promise.all([
        getEmbedding(jobText),
        getEmbedding(resume.summary || resumeTextCombined),
      ]);
      if (jobEmbedding && resumeEmbedding) {
        const sim = cosineSimilarity(jobEmbedding, resumeEmbedding);
        embeddingScore = Math.max(0, Math.min(100, sim * 100));
      }
    } catch {
      embeddingScore = null;
    }
  }

  const overallScore =
    embeddingScore != null
      ? KEYWORD_WEIGHT * keywordScore + EMBEDDING_WEIGHT * embeddingScore
      : keywordScore;

  return {
    overall_score: overallScore,
    keyword_score: keywordScore,
    embedding_score: embeddingScore,
    breakdown: {
      matched_keywords: matchedKeywords,
      total_keywords: totalKeywords,
      missing_skills: missingSkills,
    },
  };
}

module.exports = {
  scoreJobAgainstResume,
};

