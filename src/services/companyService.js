const { getCompanyByName, upsertCompany } = require('../repositories/companiesRepo');
const { chatCompletion, hasOpenAIKey } = require('./openAIClient');

async function fetchCompanyHtml(website) {
  if (!website) return null;
  try {
    const res = await fetch(website);
    if (!res.ok) return null;
    const text = await res.text();
    return text;
  } catch {
    return null;
  }
}

async function summarizeCompany(name, htmlSnippet) {
  if (!hasOpenAIKey()) {
    return '信息暂无';
  }
  const baseText = htmlSnippet
    ? `以下是公司网页的一部分内容：\n${htmlSnippet.slice(0, 2000)}`
    : '没有可用的公司网页内容。请基于常识做出合理猜测。';

  const messages = [
    {
      role: 'system',
      content:
        '你是一名专业的公司调研分析师，请用简洁的中文总结公司是做什么的，核心业务和目标客户。',
    },
    {
      role: 'user',
      content: `公司名称：${name}\n${baseText}`,
    },
  ];

  const content = await chatCompletion(messages, { max_tokens: 300 });
  return content || '信息暂无';
}

async function ensureCompanyForJob(job) {
  const name = job.company_name;
  if (!name) return null;

  const existing = getCompanyByName(name);
  if (existing) return existing;

  let website = null;
  try {
    if (job.url && job.url.startsWith('http')) {
      const urlObj = new URL(job.url);
      website = `${urlObj.protocol}//${urlObj.hostname}`;
    }
  } catch {
    website = null;
  }

  const html = await fetchCompanyHtml(website);
  const description = await summarizeCompany(name, html || '');

  const id = upsertCompany({
    name,
    website,
    description: description || '信息暂无',
    raw_html: html || null,
    industry: null,
    size: null,
  });

  return getCompanyByName(name) || { id, name, website, description };
}

module.exports = {
  ensureCompanyForJob,
};

