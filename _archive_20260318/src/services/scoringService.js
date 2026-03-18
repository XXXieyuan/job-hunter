const { hasOpenAIKey, getEmbedding } = require('./openAIClient');

const KEYWORD_WEIGHT = 0.4;
const EMBEDDING_WEIGHT = 0.6;

function normalize(text) {
  return (text || '').toLowerCase();
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
  let resumeSkills = [];
  try {
    resumeSkills = resume.skills_json ? JSON.parse(resume.skills_json) : [];
  } catch {
    resumeSkills = [];
  }
  if (!Array.isArray(resumeSkills)) {
    resumeSkills = [];
  }

  // Normalize skills into a flat list of non-empty strings
  const normalizedSkills = resumeSkills
    .map((s) => {
      if (!s) return null;
      if (typeof s === 'string') return s.trim();
      if (typeof s === 'object') {
        if (s.name) return String(s.name).trim();
        if (s.skill) return String(s.skill).trim();
      }
      return null;
    })
    .filter((s) => s && s.length > 0);

  const experience = resume.experience_json ? JSON.parse(resume.experience_json) : [];
  const experienceText = experience
    .map((e) => `${e.title || ''} ${e.company || ''} ${e.description || ''}`)
    .join('\n');

  const resumeTextCombined = [
    resume.summary || '',
    normalizedSkills.join(', '),
    experienceText,
  ].join('\n');

  const jobTextLower = normalize(jobText);

  const matchedKeywords = normalizedSkills.filter((kw) => {
    const kwLower = normalize(kw);
    return kwLower && jobTextLower.includes(kwLower);
  });

  const missingSkills = normalizedSkills.filter((kw) => {
    const kwLower = normalize(kw);
    return kwLower && !jobTextLower.includes(kwLower);
  });

  const totalKeywords = normalizedSkills.length || 1;
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
