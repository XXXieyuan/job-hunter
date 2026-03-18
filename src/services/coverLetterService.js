'use strict';

const OpenAI = require('openai');
const { getDb, TABLES } = require('../db/database');
const { getConfig } = require('./configService');
const { runMatch } = require('./matchService');
const { log } = require('../utils/logger');

const DEFAULT_CHAT_MODEL = 'gpt-4o-mini';

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

function buildPrompt(job, resume, language, gapAnalysis = { missing: [], weak: [], strong: [] }) {
  const resumeData = resume.parsed_data || {};
  const system = 'You are a professional Australian job application writer';
  const user = [
    `Language: ${language === 'zh' ? 'Chinese' : 'English'}`,
    `Target role: ${job.title} at ${job.company || 'the company'}`,
    `Location: ${job.location || 'Australia'}`,
    `Job description: ${job.job_description}`,
    `Resume name: ${resumeData.name || resume.name}`,
    `Resume skills: ${(resumeData.skills || []).join(', ')}`,
    `Resume experience: ${(resumeData.experience || []).join(' | ')}`,
    `Resume education: ${(resumeData.education || []).join(' | ')}`,
    `Strengths to emphasize: ${(gapAnalysis.strong || []).join(', ') || 'adaptability, communication, delivery'}`,
    `Potential gaps to address positively: ${(gapAnalysis.missing || []).join(', ') || 'none'}`,
    'Write 3-5 paragraphs. Keep under 400 words in English or 400 Chinese characters in Chinese.',
    'Use confident but professional tone, and align to Australian job application norms.'
  ].join('\n');

  return {
    system,
    user
  };
}

function buildFallbackCoverLetter(job, resume, language, gapAnalysis) {
  const skills = (resume.parsed_data.skills || []).slice(0, 5).join(', ');
  const strengths = (gapAnalysis.strong || []).slice(0, 4).join(', ');
  const gaps = (gapAnalysis.missing || []).slice(0, 3).join(', ');

  if (language === 'zh') {
    return [
      `尊敬的招聘团队：`,
      `我希望申请贵公司的 ${job.title} 职位。基于我在 ${skills || '软件与数据项目'} 方面的经验，我相信自己能够快速为 ${job.company || '贵公司'} 创造价值。`,
      `我的经历与岗位描述中的 ${strengths || '技术协作、交付能力'} 高度相关，并且我能够把复杂问题拆解为可执行方案，稳定推进结果。`,
      gaps
        ? `对于岗位中提到的 ${gaps}，我正在持续补强，并且过去也多次在短时间内完成新领域上手。`
        : `我也具备快速学习新领域的能力，能够根据团队目标调整优先级并持续交付。`,
      `期待有机会进一步沟通，说明我如何结合过往经验为团队带来帮助。谢谢您的时间与考虑。`
    ].join('\n\n');
  }

  return [
    `Dear Hiring Team,`,
    `I am excited to apply for the ${job.title} role at ${job.company || 'your organisation'}. My background across ${skills || 'software, data, and delivery work'} positions me to contribute quickly in an Australian team environment.`,
    `The role's focus on ${strengths || 'technical execution, collaboration, and impact'} aligns strongly with the outcomes I have delivered in previous projects, where I translated complex requirements into dependable results.`,
    gaps
      ? `While I am continuing to deepen my experience in ${gaps}, I have a strong track record of learning fast and applying new knowledge in production settings.`
      : `I also bring a practical mindset, strong communication, and a willingness to adapt quickly to team priorities and customer needs.`,
    `Thank you for your consideration. I would welcome the opportunity to discuss how my experience can support ${job.company || 'your team'}.`
  ].join('\n\n');
}

async function callOpenAi(prompt, language) {
  const config = getConfig();
  if (!config.openaiApiKey || !config.openaiBaseUrl) {
    return null;
  }

  try {
    const client = new OpenAI({
      apiKey: config.openaiApiKey,
      baseURL: config.openaiBaseUrl
    });
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_CHAT_MODEL || DEFAULT_CHAT_MODEL,
      temperature: 0.7,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ]
    });
    const content = response.choices?.[0]?.message?.content?.trim();

    if (!content) {
      return null;
    }

    return language === 'zh'
      ? content.slice(0, 400)
      : content.split(/\s+/).slice(0, 400).join(' ');
  } catch (error) {
    log('warn', 'CL_GENERATION_FALLBACK', error.message);
    return null;
  }
}

function saveCoverLetter(jobId, resumeId, content, language) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO ${TABLES.COVER_LETTERS} (job_id, resume_id, content, language)
    VALUES (?, ?, ?, ?)
  `).run(jobId, resumeId, content, language);

  return db.prepare(`SELECT * FROM ${TABLES.COVER_LETTERS} WHERE id = ?`).get(result.lastInsertRowid);
}

async function generateCoverLetter(jobId, resumeId, language) {
  const { job, resume } = getJobAndResume(jobId, resumeId);
  const match = await runMatch(jobId, resumeId);
  const prompt = buildPrompt(job, resume, language, match.gap_analysis);
  const content = await callOpenAi(prompt, language)
    || buildFallbackCoverLetter(job, resume, language, match.gap_analysis);

  const saved = saveCoverLetter(jobId, resumeId, content, language);
  log('info', 'CL_GENERATED', `Generated cover letter ${saved.id} for job ${jobId}`);
  return saved;
}

function getHistory(jobId) {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM ${TABLES.COVER_LETTERS} WHERE job_id = ? ORDER BY created_at DESC`)
    .all(jobId);
}

module.exports = {
  buildPrompt,
  generateCoverLetter,
  getHistory
};

Object.assign(globalThis, { generateCoverLetter });
