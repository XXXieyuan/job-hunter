/**
 * Role category classifier for the jobs list filter.
 *
 * Pure regex-based classification — same pattern as `src/utils/seniority.js`.
 * First match wins, so order categories by specificity (AI/ML narrower than
 * generic software engineering, etc.).
 *
 * Jobs that match no pattern fall into `other`. Categories with zero counts
 * at render time are hidden from the chip bar so the UI only shows buckets
 * that actually contain jobs.
 */

const CATEGORIES = [
  {
    key: 'ai-engineer',
    label: 'AI / ML Engineer',
    // Matches in either order:
    //   forward — AI keyword → engineering-like suffix ("Machine Learning Engineer", "AI Scientist")
    //   reverse — engineering-like prefix → AI keyword ("Python engineer - Generative AI", "Engineering Manager - ML")
    // "engineer(ing)?" catches both "Engineer" and "Engineering Manager"; "intern" covers Atlassian-style ML internships.
    // Compact keyword: /(ai|ml)-engineer/ — the hyphenated direct form ("AI-Engineer", "ML-Engineer").
    re: /(\b(ai|ml|machine learning|deep learning|artificial intelligence|llm|genai|generative ai|nlp|computer vision)\b[^\n]*\b(engineer(ing)?|developer|scientist|specialist|researcher|intern)\b)|(\b(engineer(ing)?|developer|scientist|specialist|researcher|intern)\b[^\n]*\b(ai|ml|machine learning|deep learning|artificial intelligence|llm|genai|generative ai|nlp|computer vision)\b)|(\b(ai|ml)[-\s]engineer)/i,
  },
  {
    key: 'data-scientist',
    label: 'Data Scientist',
    re: /\bdata\s+scientist|research\s+scientist/i,
  },
  {
    key: 'data-engineer',
    label: 'Data Engineer',
    re: /\bdata\s+engineer|data[-\s]developer|etl\s+engineer|analytics\s+engineer/i,
  },
  {
    key: 'data-analyst',
    label: 'Data / BI Analyst',
    re: /\bdata\s+analyst|business\s+analyst|bi\s+(analyst|developer)|analytics\s+analyst|reporting\s+analyst/i,
  },
  {
    key: 'software-engineer',
    label: 'Software Engineer',
    re: /\b(software|backend|back[-\s]end|frontend|front[-\s]end|full[-\s]?stack|web|mobile|ios|android)\s+(engineer|developer)|software\s+development|application\s+developer/i,
  },
  {
    key: 'devops-cloud',
    label: 'DevOps / Cloud',
    re: /\bdevops|site\s+reliability|\bsre\b|cloud\s+(engineer|architect|specialist)|platform\s+engineer|infrastructure\s+engineer/i,
  },
  {
    key: 'security',
    label: 'Security',
    re: /\b(security|cyber|cybersecurity|infosec|penetration|soc)\s+(engineer|analyst|specialist|architect|consultant)|security\s+operations|\bciso\b/i,
  },
  {
    key: 'dba',
    label: 'Database Admin',
    re: /\b(database|dba)\s+(admin|administrator|engineer)|\bdba\b/i,
  },
  {
    key: 'it-support',
    label: 'IT Support / SysAdmin',
    re: /\bit\s+support|help\s*desk|system(s)?\s+admin|service\s+desk|technical\s+support|desktop\s+support/i,
  },
  {
    key: 'qa',
    label: 'QA / Testing',
    re: /\bqa\s+(engineer|analyst|tester)|\btest\s+(engineer|analyst)|quality\s+assurance|automation\s+tester|sdet/i,
  },
  {
    key: 'product-design',
    label: 'Product / Design',
    re: /\bproduct\s+manager|product\s+owner|ux\s+(designer|researcher)|ui\s+designer|\bux\/ui\b/i,
  },
];

const OTHER_CATEGORY = { key: 'other', label: 'Other' };

/**
 * Classify a job title into one of the canonical category keys.
 * Returns 'other' when nothing matches or the title is empty.
 */
function classifyJobTitle(title) {
  const t = (title || '').trim();
  if (!t) return 'other';
  for (const { key, re } of CATEGORIES) {
    if (re.test(t)) return key;
  }
  return 'other';
}

/**
 * Full list of categories including 'other', in display order.
 */
function getAllCategories() {
  return [...CATEGORIES, OTHER_CATEGORY];
}

module.exports = {
  classifyJobTitle,
  getAllCategories,
};
