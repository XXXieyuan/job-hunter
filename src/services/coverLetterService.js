const { chatCompletion, hasOpenAIKey } = require('./openAIClient');

async function generateCoverLetter({ job, resume, fitScore, company }) {
  if (!hasOpenAIKey()) {
    return '未配置 OpenAI API，无法自动生成 Cover Letter。';
  }

  const systemPrompt =
    'You are an expert career coach. Write professional, tailored cover letters. 3-5 paragraphs, < 400 words.';

  const requirementSummary = job.description || '';

  const resumeHighlights = [
    resume.summary,
    '核心技能: ' +
      (resume.skills_json ? JSON.parse(resume.skills_json).join(', ') : ''),
  ]
    .filter(Boolean)
    .join('\n');

  const scoreText = fitScore
    ? `当前匹配度：总体 ${fitScore.overall_score.toFixed(
        1
      )} 分，关键词匹配 ${fitScore.keyword_score.toFixed(1)} 分。`
    : '';

  const companyLine = company
    ? `目标公司：${company.name}。公司简介：${company.description || ''}`
    : '';

  const userPrompt =
    '请用中文撰写一封专业的、量身定制的求职信，控制在 3-5 段、400 字以内。\n\n' +
    `职位名称：${job.title}。\n公司：${job.company_name || '未知公司'}。\n` +
    `岗位关键信息（来自 JD）：\n${requirementSummary}\n\n` +
    `候选人简历亮点：\n${resumeHighlights}\n\n` +
    `${scoreText}\n${companyLine}\n\n` +
    '强调候选人在 AI、产品思维和跨职能沟通方面的优势，并说明为什么 TA 非常适合该职位。';

  const content = await chatCompletion([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);

  return (
    content || '生成 Cover Letter 时出现问题，请稍后在管理面板中重试分析。'
  );
}

module.exports = {
  generateCoverLetter,
};

