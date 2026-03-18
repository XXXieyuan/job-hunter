const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getLogger } = require('../logger');

const logger = getLogger('linkedinScraper');

const LINKEDIN_SEARCH_URL = 'https://www.linkedin.com/jobs/search/';
const DEFAULT_OUTPUT_FILE = 'linkedin-jobs.json';
const RESULTS_PER_PAGE = 25;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

function emitProgress(progress) {
  try {
    const payload =
      progress && typeof progress === 'object' ? { ...progress } : {};

    payload.total =
      typeof payload.total === 'number' && payload.total >= 0 ? payload.total : 0;
    payload.current =
      typeof payload.current === 'number' && payload.current >= 0
        ? payload.current
        : 0;
    payload.message =
      typeof payload.message === 'string' ? payload.message : '';

    process.stdout.write(`[PROGRESS] ${JSON.stringify(payload)}\n`);
  } catch (err) {
    logger.warn('Failed to emit progress', { err });
  }
}

function parseArgs(argv) {
  const args = {
    mode: 'db',
    keywords: '',
    location: '',
    maxPages: 3,
    output: '',
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;

    let key;
    let value;

    if (arg.includes('=')) {
      const [rawKey, ...rest] = arg.split('=');
      key = rawKey.slice(2);
      value = rest.join('=');
    } else {
      key = arg.slice(2);
      value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    }

    switch (key) {
      case 'mode':
        args.mode = String(value || '').toLowerCase();
        break;
      case 'keywords':
        args.keywords = value;
        break;
      case 'location':
        args.location = value;
        break;
      case 'max-pages':
      case 'maxPages':
        args.maxPages = Number.parseInt(value, 10) || 3;
        break;
      case 'output':
        args.output = value;
        break;
      default:
        break;
    }
  }

  return args;
}

function getDb() {
  const dbPath = path.resolve(__dirname, '../../data/job-hunter.sqlite');
  return new Database(dbPath);
}

function prepareDbStatement(db) {
  const sql = `
    INSERT OR REPLACE INTO jobs (
      external_id,
      source,
      role,
      title,
      company_name,
      location,
      salary,
      description,
      url,
      posted_at,
      raw_json
    ) VALUES (
      @external_id,
      @source,
      @role,
      @title,
      @company_name,
      @location,
      @salary,
      @description,
      @url,
      @posted_at,
      @raw_json
    )
  `;
  return db.prepare(sql);
}

function buildLinkedInUrl(keyword, location, pageIndex) {
  const url = new URL(LINKEDIN_SEARCH_URL);

  if (keyword) {
    url.searchParams.set('keywords', keyword);
  }

  if (location) {
    url.searchParams.set('location', location);
  }

  const safePageIndex =
    Number.isInteger(pageIndex) && pageIndex > 1 ? pageIndex : 1;
  const start = (safePageIndex - 1) * RESULTS_PER_PAGE;

  if (start > 0) {
    url.searchParams.set('start', String(start));
  }

  return url.toString();
}

function normalizeLinkedInUrl(rawUrl) {
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl, LINKEDIN_SEARCH_URL);
    const jobIdMatch = url.pathname.match(/\/jobs\/view\/(\d+)/);

    if (jobIdMatch) {
      return `https://www.linkedin.com/jobs/view/${jobIdMatch[1]}/`;
    }

    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (err) {
    logger.warn('Failed to normalize LinkedIn URL', {
      rawUrl,
      err: err && err.message ? err.message : String(err),
    });
    return null;
  }
}

async function randomDelay(minMs, maxMs) {
  const lower = Number.isFinite(minMs) ? minMs : 1000;
  const upper = Number.isFinite(maxMs) ? maxMs : lower;
  const duration = Math.max(
    lower,
    lower + Math.floor(Math.random() * Math.max(1, upper - lower + 1)),
  );
  await new Promise((resolve) => setTimeout(resolve, duration));
}

async function navigateToSearch(page, keyword, location, pageIndex) {
  const url = buildLinkedInUrl(keyword, location, pageIndex);

  logger.info('Navigating to LinkedIn URL', {
    url,
    keyword,
    location,
    pageIndex,
  });

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  await randomDelay(2000, 3000);
}

async function waitForResults(page) {
  try {
    await Promise.race([
      page.waitForSelector(
        '.base-card, .job-search-card, .job-card-container, a[href*="/jobs/view/"]',
        { timeout: 20000 },
      ),
      page.waitForSelector('text=/No matching jobs found|No jobs found/i', {
        timeout: 20000,
      }),
    ]);
  } catch {
    logger.warn('Timeout waiting for LinkedIn results');
  }
}

async function autoScrollResults(page) {
  let lastLinkCount = 0;
  let stablePasses = 0;

  for (let attempt = 0; attempt < 6; attempt++) {
    await page.evaluate(() => {
      const list =
        document.querySelector('.jobs-search__results-list') ||
        document.querySelector('.jobs-search-results-list') ||
        document.querySelector('.scaffold-layout__list') ||
        document.querySelector('.jobs-search-results');

      if (list && typeof list.scrollTo === 'function') {
        list.scrollTo(0, list.scrollHeight);
      }

      window.scrollTo(0, document.body.scrollHeight);
    });

    try {
      const button = page
        .locator(
          'button:has-text("See more jobs"), button:has-text("Load more"), button:has-text("Show more")',
        )
        .first();
      if (await button.isVisible({ timeout: 1000 })) {
        await button.click();
      }
    } catch {
      // ignore missing button
    }

    await randomDelay(1200, 1800);

    const currentLinkCount = await page.evaluate(
      () => document.querySelectorAll('a[href*="/jobs/view/"]').length,
    );

    if (currentLinkCount <= lastLinkCount) {
      stablePasses += 1;
    } else {
      stablePasses = 0;
      lastLinkCount = currentLinkCount;
    }

    if (stablePasses >= 2) {
      break;
    }
  }
}

async function extractResultCount(page) {
  try {
    const count = await page.evaluate(() => {
      const selectors = [
        '.results-context-header__job-count',
        '.jobs-search-results-list__text',
        '.jobs-search-results-list__subtitle',
        '.jobs-search__results-list-header',
        'h1',
        'h2',
      ];

      const normalizeText = (value) =>
        String(value || '')
          .replace(/\s+/g, ' ')
          .trim();

      for (const selector of selectors) {
        const nodes = Array.from(document.querySelectorAll(selector));
        for (const node of nodes) {
          const text = normalizeText(node.textContent);
          const match = text.match(/([\d,]+)\+?\s+(?:jobs?|results?)/i);
          if (match) {
            return Number.parseInt(match[1].replace(/,/g, ''), 10);
          }
        }
      }

      return 0;
    });

    return Number.isFinite(count) ? count : 0;
  } catch {
    return 0;
  }
}

async function extractJobsFromPage(page) {
  const jobs = await page.evaluate(() => {
    const normalizeText = (value) =>
      String(value || '')
        .replace(/\s+/g, ' ')
        .trim();

    const collectTexts = (root, selectors) => {
      const values = [];
      const seen = new Set();

      for (const selector of selectors) {
        const nodes = root.querySelectorAll(selector);
        for (const node of nodes) {
          const text = normalizeText(node.textContent);
          if (!text || seen.has(text)) continue;
          seen.add(text);
          values.push(text);
        }
      }

      return values;
    };

    const inferJobLevel = (texts) => {
      const patterns = [
        ['Internship', /\bintern(ship)?\b/i],
        ['Entry level', /\bentry level\b|\bgraduate\b|\bjunior\b/i],
        ['Associate', /\bassociate\b/i],
        ['Mid-Senior level', /\bmid[- ]senior\b|\bmid level\b/i],
        ['Director', /\bdirector\b|\bhead of\b/i],
        ['Executive', /\bvice president\b|\bvp\b|\bexecutive\b|\bchief\b/i],
        ['Manager', /\bmanager\b/i],
        ['Lead', /\blead\b/i],
        ['Principal', /\bprincipal\b/i],
        ['Staff', /\bstaff\b/i],
        ['Senior', /\bsenior\b/i],
      ];

      for (const text of texts) {
        for (const [label, pattern] of patterns) {
          if (pattern.test(text)) {
            return label;
          }
        }
      }

      return null;
    };

    const salaryPattern =
      /(?:A\$|AU\$|US\$|S\$|C\$|\$|£|€|₹)\s?\d[\d,]*(?:\.\d+)?(?:\s*[kKmM])?(?:\s*(?:-|–|to)\s*(?:A\$|AU\$|US\$|S\$|C\$|\$|£|€|₹)?\s?\d[\d,]*(?:\.\d+)?(?:\s*[kKmM])?)?(?:\s*(?:per|\/)?\s*(?:year|annum|yr|hour|hr|day|month))?/i;

    const cards = Array.from(
      document.querySelectorAll(
        '.base-card, .job-search-card, .job-card-container, li, div[data-occludable-job-id]',
      ),
    );

    const results = [];
    const seenUrls = new Set();

    for (const card of cards) {
      const link =
        card.querySelector('a.job-card-list__title') ||
        card.querySelector('a.base-card__full-link') ||
        card.querySelector('a[href*="/jobs/view/"]');

      if (!link) {
        continue;
      }

      const rawHref = link.getAttribute('href') || link.href || '';
      if (!rawHref) {
        continue;
      }

      let jobUrl;

      try {
        const absoluteUrl = new URL(rawHref, 'https://www.linkedin.com');
        const match = absoluteUrl.pathname.match(/\/jobs\/view\/(\d+)/);
        if (match) {
          jobUrl = `https://www.linkedin.com/jobs/view/${match[1]}/`;
        } else {
          absoluteUrl.search = '';
          absoluteUrl.hash = '';
          jobUrl = absoluteUrl.toString();
        }
      } catch {
        continue;
      }

      if (!jobUrl || seenUrls.has(jobUrl)) {
        continue;
      }

      const title =
        normalizeText(link.textContent) ||
        normalizeText(
          (
            card.querySelector('.job-card-list__title') ||
            card.querySelector('.base-search-card__title') ||
            card.querySelector('h3') ||
            {}
          ).textContent,
        );

      if (!title) {
        continue;
      }

      const company =
        normalizeText(
          (
            card.querySelector('.job-card-container__company-name') ||
            card.querySelector('.base-search-card__subtitle') ||
            card.querySelector('h4.base-search-card__subtitle') ||
            card.querySelector('a[href*="/company/"]') ||
            {}
          ).textContent,
        ) || null;

      const location =
        normalizeText(
          (
            card.querySelector('.job-card-container__metadata-item') ||
            card.querySelector('.job-search-card__location') ||
            card.querySelector('.base-search-card__metadata') ||
            {}
          ).textContent,
        ) || null;

      const postedAtNode =
        card.querySelector('time') ||
        card.querySelector('.job-card-container__listed-time');

      const postedAt =
        normalizeText(
          postedAtNode
            ? postedAtNode.getAttribute('datetime') || postedAtNode.textContent
            : '',
        ) || null;

      const insightTexts = collectTexts(card, [
        '.job-card-container__job-insight-text',
        '.job-card-container__footer-item',
        '.job-card-container__footer-job-state',
        '.job-card-container__metadata-wrapper li',
        '.base-search-card__metadata li',
        '.base-search-card__footer li',
        '.job-search-card__salary-info',
        '.job-card-container__salary-info',
      ]);

      const salaryCandidates = [
        normalizeText(
          (
            card.querySelector('.job-card-container__salary-info') ||
            card.querySelector('.job-search-card__salary-info') ||
            {}
          ).textContent,
        ),
        ...insightTexts,
        normalizeText(card.textContent),
      ].filter(Boolean);

      let salary = null;
      for (const candidate of salaryCandidates) {
        const match = candidate.match(salaryPattern);
        if (match) {
          salary = normalizeText(match[0]);
          break;
        }
      }

      const jobLevel = inferJobLevel([title, ...insightTexts]);

      seenUrls.add(jobUrl);
      results.push({
        external_id: jobUrl,
        source: 'linkedin',
        role: title,
        title,
        company_name: company,
        location,
        salary,
        job_level: jobLevel,
        description: null,
        url: jobUrl,
        posted_at: postedAt,
      });
    }

    return results;
  });

  return jobs;
}

async function scrapeKeyword(page, keyword, location, maxPages, progressCtx) {
  const jobsByUrl = new Map();

  emitProgress({
    type: 'searching',
    total: progressCtx.total,
    current: progressCtx.current,
    count: 0,
    message: `Searching LinkedIn for ${keyword}${location ? ` in ${location}` : ''}`,
  });

  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
    progressCtx.current += 1;

    emitProgress({
      type: 'processing',
      total: progressCtx.total,
      current: progressCtx.current,
      page: pageIndex,
      message: `Scraping LinkedIn "${keyword}" page ${pageIndex} of ${maxPages}`,
    });

    await navigateToSearch(page, keyword, location, pageIndex);
    await waitForResults(page);
    await autoScrollResults(page);

    const [resultCount, jobs] = await Promise.all([
      extractResultCount(page),
      extractJobsFromPage(page),
    ]);

    for (const job of jobs) {
      const normalizedUrl = normalizeLinkedInUrl(job.url);
      if (!normalizedUrl) continue;

      jobsByUrl.set(normalizedUrl, {
        ...job,
        external_id: normalizedUrl,
        url: normalizedUrl,
      });
    }

    emitProgress({
      type: 'found',
      total: progressCtx.total,
      current: progressCtx.current,
      page: pageIndex,
      count: resultCount || jobs.length,
      message:
        resultCount > 0
          ? `Found ${resultCount} LinkedIn jobs for ${keyword}`
          : `Collected ${jobs.length} LinkedIn jobs on page ${pageIndex}`,
    });

    logger.info('Scraped LinkedIn jobs for page', {
      keyword,
      pageIndex,
      jobsCount: jobs.length,
      resultCount,
    });

    if (jobs.length === 0) {
      break;
    }

    await randomDelay(1500, 2500);
  }

  return Array.from(jobsByUrl.values());
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.keywords) {
    logger.error('Missing required --keywords argument');
    process.exit(1);
  }

  const keywords = String(args.keywords)
    .split(',')
    .map((keyword) => keyword.trim())
    .filter(Boolean);

  if (keywords.length === 0) {
    logger.error('No valid keywords parsed from --keywords');
    process.exit(1);
  }

  const location = args.location || '';
  const maxPages = args.maxPages || 3;
  const mode = args.mode === 'json' ? 'json' : 'db';

  logger.info('LinkedIn scraper starting', {
    mode,
    keywordsCount: keywords.length,
    location,
    maxPages,
  });

  let browser;
  let context;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
    });

    const page = await context.newPage();
    const allJobsByUrl = new Map();
    const totalSteps = keywords.length * maxPages;
    const progressCtx = {
      total: totalSteps,
      current: 0,
    };
    const maxRetries = 3;

    for (const keyword of keywords) {
      let attempt = 0;
      let success = false;

      while (attempt < maxRetries && !success) {
        attempt += 1;

        logger.info('Scraping LinkedIn keyword', {
          keyword,
          attempt,
          maxRetries,
        });

        try {
          const jobs = await scrapeKeyword(
            page,
            keyword,
            location,
            maxPages,
            progressCtx,
          );

          logger.info('LinkedIn keyword scrape completed', {
            keyword,
            dedupedJobsCount: jobs.length,
          });

          for (const job of jobs) {
            allJobsByUrl.set(job.url, job);
          }

          success = true;
        } catch (err) {
          logger.error('Error scraping LinkedIn keyword', {
            keyword,
            attempt,
            maxRetries,
            err,
          });

          if (attempt < maxRetries) {
            await randomDelay(2000, 3000);
          }
        }
      }
    }

    const allJobs = Array.from(allJobsByUrl.values());

    logger.info('LinkedIn scraping finished', {
      totalUniqueJobs: allJobs.length,
      mode,
    });

    if (mode === 'json') {
      const outputPath = args.output || DEFAULT_OUTPUT_FILE;
      const resolvedOutputPath = path.resolve(process.cwd(), outputPath);

      fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
      fs.writeFileSync(
        resolvedOutputPath,
        JSON.stringify(allJobs, null, 2),
        'utf8',
      );

      logger.info('Wrote LinkedIn jobs to JSON file', {
        jobsCount: allJobs.length,
        outputPath: resolvedOutputPath,
      });
    } else {
      const db = getDb();
      const stmt = prepareDbStatement(db);

      const upsertJobs = db.transaction((jobs) => {
        for (const job of jobs) {
          stmt.run({
            ...job,
            raw_json: JSON.stringify(job),
          });
        }
      });

      upsertJobs(allJobs);
      db.close();

      logger.info('Upserted LinkedIn jobs into SQLite database', {
        jobsCount: allJobs.length,
      });
    }

    emitProgress({
      type: 'completed',
      total: progressCtx.total,
      current: progressCtx.current,
      jobs_added: allJobs.length,
      message: `Completed LinkedIn scrape with ${allJobs.length} jobs`,
    });
  } finally {
    if (context) {
      await context.close();
    }

    if (browser) {
      await browser.close();
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('Fatal error in LinkedIn scraper', { err });
    process.exit(1);
  });
}
