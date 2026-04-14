const companiesRepo = require('../repositories/companiesRepo');
const openAIClient = require('./openAIClient');
const backgroundQueue = require('./backgroundQueue');
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
 * Extract a JSON object from an AI response that may contain markdown fences,
 * leading text, or trailing text around the JSON.
 * @param {string} content - Raw AI response
 * @returns {object|null} Parsed object or null on failure
 */
function extractJSON(content) {
  if (!content) return null;
  let text = content.trim();

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to brace extraction
  }

  // Extract first top-level { ... } block
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Validate a website URL: only allow http:// or https:// schemes.
 * Returns the URL if valid, null otherwise.
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
function validateWebsiteUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return null;
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

  if (!openAIClient.hasOpenAIKey()) {
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
- website: Company website URL if known (or null)

Example output for "Atlassian":
{"description":"Atlassian builds collaboration and project management software for software teams, including Jira, Confluence, and Trello.","industry":"Technology","size":"10000+","headquarters":"Sydney, Australia","website":"https://www.atlassian.com"}

Example output for an unknown company:
{"description":"Small consulting firm specialising in IT services.","industry":"Consulting","size":"10-50","headquarters":null,"website":null}`;

  const userPrompt = `Company name: ${name}\n\n${contextText}`;

  try {
    const content = await openAIClient.chatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.3, max_tokens: 1024 }
    );

    if (!content) return fallback;

    const parsed = extractJSON(content);
    if (!parsed) {
      logger.warn('Failed to parse AI company research response', { name });
      return fallback;
    }

    return {
      description: parsed.description || null,
      industry: parsed.industry || null,
      size: parsed.size || null,
      headquarters: parsed.headquarters || null,
      website: validateWebsiteUrl(parsed.website),
    };
  } catch (err) {
    logger.error('AI company research failed', { name, error: err.message });
    return fallback;
  }
}

/**
 * Ensure a company record exists for a job. If the company already exists
 * in the database with research data, return it. Otherwise, optionally
 * trigger AI research when forceResearch is true.
 *
 * On normal page load (forceResearch=false), only checks cache — no AI call.
 * On button click (forceResearch=true), calls AI and upserts result.
 *
 * @param {object} job - Job record with company_name and optionally url
 * @param {object} [opts={}] - Options
 * @param {boolean} [opts.forceResearch=false] - If true, trigger AI research on cache miss
 * @returns {Promise<object|null>} Company record or null
 */
async function ensureCompanyForJob(job, opts = {}) {
  const name = job.company_name;
  if (!name) return null;

  // Cache check: return existing company if already researched
  const existing = companiesRepo.getCompanyByName(name);
  if (existing && existing.description) return existing;

  // Page-load path: no AI call, return null
  if (!opts.forceResearch) return null;

  // Button-click path: call AI and upsert
  try {
    const result = await researchCompanyWithAI(name, null);

    // Check if AI returned any useful data
    const hasData = result.description || result.industry || result.size || result.headquarters || result.website;
    if (!hasData) {
      // Complete failure — don't write to DB, company remains eligible for retry
      return null;
    }

    // Upsert with researched_at and raw_json
    companiesRepo.upsertCompany({
      name,
      description: result.description,
      industry: result.industry,
      size: result.size,
      headquarters: result.headquarters,
      website: result.website,
      raw_json: JSON.stringify(result),
    });

    // Return the freshly upserted record
    return companiesRepo.getCompanyByName(name);
  } catch (err) {
    logger.error('Company research failed in ensureCompanyForJob', { name, error: err.message });
    return null;
  }
}

/**
 * Batch process companies that lack research data (no description).
 * Processes one chunk of up to 10 companies, then re-enqueues remaining
 * candidates as a new backgroundQueue task to keep individual tasks
 * under 25 seconds. 2000ms delay between AI calls within a chunk.
 * Individual failures are skipped without halting the batch.
 *
 * @param {object} [opts] - Options
 * @param {function} [opts.onProgress] - Called with (processed, total) after each company
 * @param {Array} [opts._candidates] - Pre-filtered candidates (used by re-enqueue continuation)
 * @param {object} [opts._backgroundQueue] - Override backgroundQueue for testing
 * @returns {Promise<number>} Number of companies successfully researched in this chunk
 */
async function batchResearchCompanies(opts = {}) {
  // Support continuation with pre-filtered candidates from re-enqueue
  let candidates;
  if (Array.isArray(opts._candidates)) {
    candidates = opts._candidates;
  } else {
    const allCompanies = companiesRepo.getAll();
    candidates = allCompanies.filter(c => !c.description || c.description.trim() === '');
  }

  if (candidates.length === 0) {
    logger.info('Batch company research: no unresearched companies found');
    return 0;
  }

  const total = candidates.length;
  let successCount = 0;
  let processed = 0;

  logger.info('Batch company research starting', { total });

  const CHUNK_SIZE = 10;
  const chunk = candidates.slice(0, CHUNK_SIZE);
  const remaining = candidates.slice(CHUNK_SIZE);

  for (const company of chunk) {
    try {
      const result = await researchCompanyWithAI(company.name, null);

      const hasData = result.description || result.industry || result.size || result.headquarters || result.website;
      if (hasData) {
        companiesRepo.upsertCompany({
          name: company.name,
          description: result.description,
          industry: result.industry,
          size: result.size,
          headquarters: result.headquarters,
          website: result.website,
          raw_json: JSON.stringify(result),
        });
        successCount++;
      }
    } catch (err) {
      logger.warn('Batch company research: failed for company', { name: company.name, error: err.message });
      // Skip failures — do not halt batch
    }

    processed++;
    if (typeof opts.onProgress === 'function') {
      opts.onProgress(processed, total);
    }

    // Delay between AI calls to respect rate limits
    if (processed < chunk.length) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // Re-enqueue remaining candidates as a new backgroundQueue task
  // Keeps individual tasks under 25 seconds (mitigates batch-queue-long-running)
  if (remaining.length > 0) {
    const queue = opts._backgroundQueue || backgroundQueue;
    queue.enqueue('company_research_chunk', { candidates: remaining });
    logger.info('Batch company research: re-enqueued remaining chunk', { remaining: remaining.length });
  }

  logger.info('Batch company research chunk complete', { chunkSize: chunk.length, successCount });
  return successCount;
}

// Register handler for re-enqueued chunk continuation
backgroundQueue.registerHandler('company_research_chunk', async (params) => {
  await batchResearchCompanies({ _candidates: params.candidates });
});

module.exports = {
  ensureCompanyForJob,
  researchCompanyWithAI,
  batchResearchCompanies,
  // Exported for testing
  extractJSON,
  validateWebsiteUrl,
};
