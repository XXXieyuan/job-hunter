const { getCompanyByName, upsertCompany, getAll } = require('../repositories/companiesRepo');
const { chatCompletion, hasOpenAIKey } = require('./openAIClient');
const { getLogger } = require('../logger');

const logger = getLogger('companyService');

/**
 * Attempt to fetch the company website HTML for context.
 * @param {string} website - URL to fetch
 * @returns {Promise<string|null>}
 */
async function fetchCompanyHtml(website) {
  if (!website) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(website, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const text = await res.text();
    return text;
  } catch (err) {
    logger.warn('Failed to fetch company website HTML', {
      website,
      error: err && err.message,
    });
    return null;
  }
}

/**
 * Use AI to generate structured company research from a company name.
 * Extracts: description, industry, size estimate, headquarters, website.
 *
 * @param {string} name - Company name
 * @param {string|null} htmlSnippet - Optional HTML from company website
 * @returns {Promise<object>} Structured company data
 */
async function researchCompanyWithAI(name, htmlSnippet) {
  const fallback = {
    description: null,
    industry: null,
    size: null,
    headquarters: null,
    website: null,
  };

  if (!hasOpenAIKey()) {
    return fallback;
  }

  const contextText = htmlSnippet
    ? `Below is a snippet from the company website:\n${htmlSnippet.slice(0, 2000)}`
    : 'No website content available. Use your knowledge to provide a best estimate.';

  const systemPrompt = `You are a company research analyst. Given a company name and optional website content, extract structured information about the company.

Return a valid JSON object only, with no other text. Required keys:
- description: 1-3 sentence description of what the company does, its core business and target customers
- industry: Primary industry sector (e.g., "Technology", "Finance", "Healthcare", "Government")
- size: Employee count estimate as a string (e.g., "50-200", "1000-5000", "10000+")
- headquarters: City and country of headquarters (e.g., "Sydney, Australia")
- website: Company website URL if known (or null)`;

  const userPrompt = `Company name: ${name}\n\n${contextText}`;

  try {
    const content = await chatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.3, max_tokens: 1024 }
    );

    if (!content) return fallback;

    // Parse JSON from response
    const trimmed = content.trim();
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      const start = trimmed.indexOf('{');
      const end = trimmed.lastIndexOf('}');
      if (start !== -1 && end > start) {
        try {
          parsed = JSON.parse(trimmed.slice(start, end + 1));
        } catch {
          logger.warn('Failed to parse AI company research response', { name });
          return fallback;
        }
      } else {
        return fallback;
      }
    }

    return {
      description: parsed.description || null,
      industry: parsed.industry || null,
      size: parsed.size || null,
      headquarters: parsed.headquarters || null,
      website: parsed.website || null,
    };
  } catch (err) {
    logger.error('AI company research failed', { name, error: err.message });
    return fallback;
  }
}

/**
 * Ensure a company record exists for a job. If the company already exists
 * in the database, return it. Otherwise, research and create it.
 *
 * Tier 2 stub: Returns existing company if found, otherwise returns null.
 * Full AI research is deferred to Tier 2 implementation.
 *
 * @param {object} job - Job record with company_name and optionally url
 * @returns {Promise<object|null>} Company record or null
 */
async function ensureCompanyForJob(job) {
  const name = job.company_name;
  if (!name) return null;

  // Return existing company if already researched
  const existing = getCompanyByName(name);
  if (existing && existing.description) return existing;

  // Tier 2: Full AI-based company research is deferred
  return null;
}

/**
 * Batch process all companies that lack research data (no description).
 * Returns the count of companies researched.
 *
 * Tier 2 stub: Returns 0. Full batch research is deferred.
 *
 * @param {object} [opts] - Options
 * @param {function} [opts.onProgress] - Called with (processed, total) after each company
 * @returns {Promise<number>} Number of companies researched
 */
async function batchResearchCompanies(opts = {}) {
  logger.info('Batch company research is a Tier 2 feature (deferred)');
  return 0;
}

module.exports = {
  ensureCompanyForJob,
  researchCompanyWithAI,
  batchResearchCompanies,
};
