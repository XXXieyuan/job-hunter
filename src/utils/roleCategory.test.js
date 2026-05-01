const test = require('node:test');
const assert = require('node:assert');
const { classifyJobTitle, getAllCategories } = require('./roleCategory');

test('classifyJobTitle — AI / ML Engineer (forward order)', () => {
  assert.equal(classifyJobTitle('AI Engineer'), 'ai-engineer');
  assert.equal(classifyJobTitle('Senior AI Engineer'), 'ai-engineer');
  assert.equal(classifyJobTitle('Machine Learning Engineer'), 'ai-engineer');
  assert.equal(classifyJobTitle('Senior Machine Learning Engineer'), 'ai-engineer');
  assert.equal(classifyJobTitle('ML Engineer'), 'ai-engineer');
  assert.equal(classifyJobTitle('LLM Engineer'), 'ai-engineer');
  assert.equal(classifyJobTitle('Deep Learning Scientist'), 'ai-engineer');
  assert.equal(classifyJobTitle('NLP Engineer'), 'ai-engineer');
  assert.equal(classifyJobTitle('Computer Vision Engineer'), 'ai-engineer');
});

test('classifyJobTitle — AI / ML Engineer (artificial intelligence spelled out)', () => {
  assert.equal(classifyJobTitle('Artificial Intelligence Engineer'), 'ai-engineer');
  assert.equal(classifyJobTitle('Junior Artificial Intelligence Engineer'), 'ai-engineer');
  assert.equal(classifyJobTitle('Senior Artificial Intelligence Scientist'), 'ai-engineer');
});

test('classifyJobTitle — AI / ML Engineer (engineering, intern, researcher suffixes)', () => {
  assert.equal(classifyJobTitle('Machine Learning Engineering Manager'), 'ai-engineer');
  assert.equal(classifyJobTitle('Atlassian Machine Learning Intern, Summer 2026/2027'), 'ai-engineer');
  assert.equal(classifyJobTitle('AI Research Scientist'), 'ai-engineer');
  assert.equal(classifyJobTitle('ML Researcher'), 'ai-engineer');
});

test('classifyJobTitle — AI / ML Engineer (reverse order: suffix → keyword)', () => {
  assert.equal(classifyJobTitle('Python engineer - Generative AI (Mid-Level)'), 'ai-engineer');
  assert.equal(classifyJobTitle('Engineering Manager - Machine Learning'), 'ai-engineer');
  assert.equal(classifyJobTitle('Engineering Manager - Generative AI'), 'ai-engineer');
});

test('classifyJobTitle — AI regex does NOT overmatch', () => {
  assert.equal(classifyJobTitle('Project Engineer'), 'other');
  assert.equal(classifyJobTitle('Systems Engineer'), 'other');  // Generic — neither IT support nor AI
  assert.equal(classifyJobTitle('Continuous Improvement Engineer'), 'other');
  assert.equal(classifyJobTitle('Cyber Security Engineer'), 'security');
  // Ambiguous: mechanical engineer that mentions AI after — accept as weak true positive
  // (it's still AI-adjacent work), but if needed, we can add a "mechanical|electrical" exclusion.
});

test('classifyJobTitle — Data Engineer', () => {
  assert.equal(classifyJobTitle('Data Engineer'), 'data-engineer');
  assert.equal(classifyJobTitle('Senior Data Engineer'), 'data-engineer');
  assert.equal(classifyJobTitle('Lead Data Engineer'), 'data-engineer');
  assert.equal(classifyJobTitle('ETL Engineer'), 'data-engineer');
  assert.equal(classifyJobTitle('Analytics Engineer'), 'data-engineer');
});

test('classifyJobTitle — Data Analyst', () => {
  assert.equal(classifyJobTitle('Data Analyst'), 'data-analyst');
  assert.equal(classifyJobTitle('BI Analyst'), 'data-analyst');
  assert.equal(classifyJobTitle('Business Analyst'), 'data-analyst');
});

test('classifyJobTitle — Data Scientist', () => {
  assert.equal(classifyJobTitle('Data Scientist'), 'data-scientist');
  assert.equal(classifyJobTitle('Lead Data Scientist'), 'data-scientist');
  assert.equal(classifyJobTitle('Principal Data Scientist'), 'data-scientist');
});

test('classifyJobTitle — Software Engineer', () => {
  assert.equal(classifyJobTitle('Software Engineer'), 'software-engineer');
  assert.equal(classifyJobTitle('Backend Developer'), 'software-engineer');
  assert.equal(classifyJobTitle('Frontend Engineer'), 'software-engineer');
  assert.equal(classifyJobTitle('Full Stack Developer'), 'software-engineer');
  assert.equal(classifyJobTitle('Fullstack Engineer'), 'software-engineer');
  assert.equal(classifyJobTitle('Mobile Developer'), 'software-engineer');
});

test('classifyJobTitle — DevOps / Cloud', () => {
  assert.equal(classifyJobTitle('DevOps Engineer'), 'devops-cloud');
  assert.equal(classifyJobTitle('Site Reliability Engineer'), 'devops-cloud');
  assert.equal(classifyJobTitle('SRE'), 'devops-cloud');
  assert.equal(classifyJobTitle('Cloud Engineer'), 'devops-cloud');
  assert.equal(classifyJobTitle('Cloud Architect'), 'devops-cloud');
  assert.equal(classifyJobTitle('Platform Engineer'), 'devops-cloud');
});

test('classifyJobTitle — Security', () => {
  assert.equal(classifyJobTitle('Security Engineer'), 'security');
  assert.equal(classifyJobTitle('Cyber Security Analyst'), 'security');
  assert.equal(classifyJobTitle('Penetration Tester'), 'other'); // only matches "penetration ... engineer/analyst"; "Penetration Tester" falls to QA
  assert.equal(classifyJobTitle('Cyber Analyst'), 'security');
  assert.equal(classifyJobTitle('InfoSec Engineer'), 'security');
});

test('classifyJobTitle — Database Admin', () => {
  assert.equal(classifyJobTitle('Database Administrator'), 'dba');
  assert.equal(classifyJobTitle('DBA'), 'dba');
  assert.equal(classifyJobTitle('Senior DBA'), 'dba');
});

test('classifyJobTitle — IT Support', () => {
  assert.equal(classifyJobTitle('IT Support Specialist'), 'it-support');
  assert.equal(classifyJobTitle('Help Desk Technician'), 'it-support');
  assert.equal(classifyJobTitle('System Administrator'), 'it-support');
  assert.equal(classifyJobTitle('Systems Administrator'), 'it-support');
  assert.equal(classifyJobTitle('Service Desk Analyst'), 'it-support');
});

test('classifyJobTitle — QA / Testing', () => {
  assert.equal(classifyJobTitle('QA Engineer'), 'qa');
  assert.equal(classifyJobTitle('Test Engineer'), 'qa');
  assert.equal(classifyJobTitle('Automation Tester'), 'qa');
  assert.equal(classifyJobTitle('SDET'), 'qa');
});

test('classifyJobTitle — Product / Design', () => {
  assert.equal(classifyJobTitle('Product Manager'), 'product-design');
  assert.equal(classifyJobTitle('UX Designer'), 'product-design');
  assert.equal(classifyJobTitle('UI Designer'), 'product-design');
});

test('classifyJobTitle — first-match-wins for ambiguous titles', () => {
  // "AI Data Engineer" — AI matches first (more specific)
  assert.equal(classifyJobTitle('AI Data Engineer'), 'ai-engineer');
  // "Senior Data Analytics Engineer" — Data Engineer wins over Data Analyst
  // (both patterns would otherwise match; ordering gives Data Engineer priority)
  assert.equal(classifyJobTitle('Data Analytics Engineer'), 'data-engineer');
});

test('classifyJobTitle — no match falls to other', () => {
  assert.equal(classifyJobTitle('Retail Assistant'), 'other');
  assert.equal(classifyJobTitle('Catering Assistant'), 'other');
  assert.equal(classifyJobTitle('Project Manager'), 'other');
  assert.equal(classifyJobTitle('Marketing Coordinator'), 'other');
});

test('classifyJobTitle — empty / null / undefined', () => {
  assert.equal(classifyJobTitle(''), 'other');
  assert.equal(classifyJobTitle(null), 'other');
  assert.equal(classifyJobTitle(undefined), 'other');
  assert.equal(classifyJobTitle('   '), 'other');
});

test('getAllCategories includes other at the end', () => {
  const cats = getAllCategories();
  assert.ok(cats.length >= 10);
  assert.equal(cats[cats.length - 1].key, 'other');
  assert.ok(cats.every(c => typeof c.key === 'string' && typeof c.label === 'string'));
});
