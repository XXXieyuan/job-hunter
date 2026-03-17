const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getLogger } = require('../logger');

const logger = getLogger('apsjobsScraper');

function emitProgress(progress) {
  try {
    const payload = {
      total:
        typeof progress.total === 'number' && progress.total >= 0
          ? progress.total
          : 0,
      current:
        typeof progress.current === 'number' && progress.current >= 0
          ? progress.current
          : 0,
      message: typeof progress.message === 'string' ? progress.message : '',
    };
    // Write a single-line marker that the parent process can parse easily.
    // This deliberately avoids the Winston logger so the line stays clean.
    process.stdout.write(`[PROGRESS] ${JSON.stringify(payload)}\n`);
  } catch (err) {
    logger.warn('Failed to emit progress', { err });
  }
}

// Simple CLI arg parsing (supports --key value and --key=value)
function parseArgs(argv) {
  const args = {
    mode: 'db',
    keywords: '',
    location: '',
    maxPages: 3,
    output: '',
  };

  for (let i = 2; i < argv.length; i++) {
    let arg = argv[i];
    if (!arg.startsWith('--')) continue;

    let key;
    let value;

    if (arg.includes('=')) {
      const [k, ...rest] = arg.split('=');
      key = k.slice(2);
      value = rest.join('=');
    } else {
      key = arg.slice(2);
      value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    }

    switch (key) {
      case 'mode':
        args.mode = value.toLowerCase();
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
        // ignore unknown flags
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

/**
 * Extract job listings from the current APSJobs search results page.
 * NOTE: APSJobs is a Salesforce Lightning SPA, so selectors may need adjustment
 * based on actual DOM. The locators below try to avoid brittle class names.
 */
async function extractJobsFromPage(page) {
  // Run DOM scraping inside the page context using regular DOM APIs.
  const jobs = await page.$$eval(
    'article, div[role="group"], div[role="listitem"]',
    (cards) => {
      const results = [];

      for (const card of cards) {
        // Only keep cards that have a link with common job-detail text.
        const jobLink =
          card.querySelector('a[href*="/job/"], a[href*="/jobs/"], a[href*="JobId="]') ||
          Array.from(card.querySelectorAll('a')).find((a) =>
            /View job|Job details|More info|Details/i.test(a.textContent || ''),
          );
        if (!jobLink) continue;

        const normText = (el) =>
          (el && (el.textContent || '').trim().replace(/\s+/g, ' ')) || '';

        // Title
        const titleText =
          normText(jobLink) ||
          normText(card.querySelector('h2')) ||
          normText(card.querySelector('h3'));
        const title = titleText;

        // Helper to get value that appears after a label
        const extractAfterLabel = (root, pattern) => {
          const labelRegex = new RegExp(pattern, 'i');
          const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
          );
          let node;
          while ((node = walker.nextNode())) {
            const text = node.textContent || '';
            if (!labelRegex.test(text)) continue;

            // Look for sibling element containing the value
            const parentEl = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
            if (!parentEl) continue;

            // First try nextElementSibling
            if (parentEl.nextElementSibling) {
              const candidate = parentEl.nextElementSibling;
              const value = (candidate.textContent || '').trim();
              if (value) return value.replace(/\s+/g, ' ');
            }

            // Then try any following sibling text
            let sibling = parentEl.nextSibling;
            while (sibling) {
              const value = (sibling.textContent || '').trim();
              if (value) return value.replace(/\s+/g, ' ');
              sibling = sibling.nextSibling;
            }
          }
          return '';
        };

        // Agency / department
        const agencyText =
          extractAfterLabel(card, 'Agency:') ||
          extractAfterLabel(card, 'Department') ||
          '';
        const companyName = agencyText || null;

        // Location
        const locationText =
          extractAfterLabel(card, 'Location:') ||
          extractAfterLabel(card, 'Location') ||
          '';
        const location = locationText || null;

        // Salary / classification
        const salaryText =
          extractAfterLabel(card, 'Classification:') ||
          extractAfterLabel(card, 'Salary') ||
          '';
        const salary = salaryText || null;

        // Closing date
        const closingText =
          extractAfterLabel(card, 'Closing date:') ||
          extractAfterLabel(card, 'Closes:') ||
          '';
        const closingDate = closingText || null;

        // Job URL
        const href = jobLink.getAttribute('href') || '';
        let url = null;
        if (href) {
          if (href.startsWith('http')) {
            url = href;
          } else {
            url = new URL(href, 'https://www.apsjobs.gov.au').toString();
          }
        }

        // Reference number
        const refText =
          extractAfterLabel(card, 'Reference number:') ||
          extractAfterLabel(card, 'Job reference') ||
          '';
        const rawRef = refText.trim().replace(/\s+/g, ' ');
        const reference = rawRef || (url ? url.split('/').pop() : null);

        if (!title || !reference) {
          continue;
        }

        const externalId = `aps-${reference}`;

        results.push({
          external_id: externalId,
          source: 'apsjobs',
          role: title,
          title,
          company_name: companyName,
          location,
          salary,
          description: null,
          url,
          posted_at: closingDate,
        });
      }

      return results;
    },
  );

  return jobs;
}

async function navigateToSearch(page, keyword, location) {
  const baseUrl = 'https://www.apsjobs.gov.au/s/search-jobs';
  const url = `${baseUrl}?keywords=${encodeURIComponent(keyword)}`;
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });

  // For robustness, try to set keyword/location via inputs as well if present.
  try {
    // Fill keyword input via DOM evaluation to avoid Playwright-specific locators.
    await page.evaluate((kw) => {
      const input =
        document.querySelector('input[placeholder*="Keywords" i]') ||
        document.querySelector('input[aria-label*="Keywords" i]');
      if (input) {
        input.focus();
        input.value = kw;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, keyword);
  } catch {
    // best-effort only
  }

  if (location) {
    try {
      await page.evaluate((loc) => {
        const input =
          document.querySelector('input[placeholder*=\"Location\" i]') ||
          document.querySelector('input[aria-label*=\"Location\" i]');
        if (input) {
          input.focus();
          input.value = loc;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, location);
    } catch {
      // best-effort only
    }
  }

  try {
    // Try to click a search-like button by text.
    await page.evaluate(() => {
      const labels = /Search|Find jobs|Apply filters/i;
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
      const btn = buttons.find((el) => labels.test(el.textContent || ''));
      if (btn) {
        (btn).click();
      }
    });
  } catch {
    // page may auto-search; ignore
  }

  // Wait for job results to render; timeout handled by caller
  await page.waitForTimeout(3000);
}

async function hasNextPage(page) {
  // Try to find a "Next" or pagination button using DOM queries.
  return page.evaluate(() => {
    const matchNext = (el) => /Next/i.test(el.textContent || '');
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const links = Array.from(document.querySelectorAll('a'));

    const nextButton = buttons.find(matchNext);
    if (nextButton) {
      const disabledAttr = nextButton.getAttribute('disabled');
      const ariaDisabled = nextButton.getAttribute('aria-disabled');
      if (disabledAttr != null || ariaDisabled === 'true') return false;
      return true;
    }

    const nextLink = links.find(matchNext);
    if (nextLink) {
      const ariaDisabled = nextLink.getAttribute('aria-disabled');
      if (ariaDisabled === 'true') return false;
      return true;
    }

    return false;
  });
}

async function goToNextPage(page) {
  // Click the "Next" button/link and wait briefly for results to update.
  const clicked = await page.evaluate(() => {
    const matchNext = (el) => /Next/i.test(el.textContent || '');
    const buttons = Array.from(document.querySelectorAll('button, [role=\"button\"]'));
    const links = Array.from(document.querySelectorAll('a'));

    const nextButton = buttons.find(matchNext);
    if (nextButton) {
      (nextButton).click();
      return true;
    }

    const nextLink = links.find(matchNext);
    if (nextLink) {
      (nextLink).click();
      return true;
    }

    return false;
  });

  if (!clicked) {
    return;
  }

  // APSJobs is a SPA; wait for network to settle or fallback to a short timeout.
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 });
  } catch {
    await page.waitForTimeout(3000);
  }
}

async function scrapeKeyword(page, keyword, location, maxPages, progressCtx) {
  const allJobs = [];

  await navigateToSearch(page, keyword, location);

  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
    if (progressCtx && typeof progressCtx.total === 'number') {
      const nextCurrent =
        typeof progressCtx.current === 'number'
          ? progressCtx.current + 1
          : 1;
      progressCtx.current = nextCurrent;
      emitProgress({
        total: progressCtx.total,
        current: progressCtx.current,
        message: `Scraping "${keyword}" page ${pageIndex} of ${maxPages}`,
      });
    }

    // Wait for either results or "no results" indication
    try {
      await Promise.race([
        page.waitForSelector('text=/No jobs found/i', { timeout: 15000 }),
        page.waitForSelector('article, div[role="group"], div[role="listitem"]', { timeout: 15000 }),
      ]);
    } catch {
      logger.warn('Timeout waiting for results', { keyword, pageIndex });
    }

    const jobs = await extractJobsFromPage(page);
    logger.info('Scraped jobs for page', {
      keyword,
      pageIndex,
      jobsCount: jobs.length,
    });
    allJobs.push(...jobs);

    const hasNext = await hasNextPage(page);
    if (!hasNext) break;

    if (pageIndex < maxPages) {
      await goToNextPage(page);
    } else {
      break;
    }
  }

  // Deduplicate by external_id
  const map = new Map();
  for (const job of allJobs) {
    map.set(job.external_id, job);
  }

  return Array.from(map.values());
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.keywords) {
    logger.error('Missing required --keywords argument');
    process.exit(1);
  }

  const keywords = args.keywords
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  if (keywords.length === 0) {
    logger.error('No valid keywords parsed from --keywords');
    process.exit(1);
  }

  const location = args.location || '';
  const maxPages = args.maxPages || 3;
  const mode = args.mode === 'json' ? 'json' : 'db';

  logger.info('APSJobs scraper starting', {
    mode,
    // Avoid logging full keyword list if large
    keywordsCount: keywords.length,
    location,
    maxPages,
  });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();

  const allJobsMap = new Map();

  const maxRetries = 2;

  const totalSteps = keywords.length * maxPages;
  const progressCtx = {
    total: totalSteps,
    current: 0,
  };

  for (const keyword of keywords) {
    let attempt = 0;
    let success = false;

    while (attempt < maxRetries && !success) {
      attempt += 1;
      logger.info('Scraping keyword', { keyword, attempt, maxRetries });

      try {
        const jobs = await scrapeKeyword(
          page,
          keyword,
          location,
          maxPages,
          progressCtx,
        );

        logger.info('Keyword scrape completed', {
          keyword,
          dedupedJobsCount: jobs.length,
        });

        for (const job of jobs) {
          allJobsMap.set(job.external_id, job);
        }

        success = true;
      } catch (err) {
        logger.error('Error scraping keyword', {
          keyword,
          attempt,
          maxRetries,
          err,
        });
        if (attempt >= maxRetries) {
          logger.error('Giving up on keyword after max retries', {
            keyword,
            maxRetries,
          });
        } else {
          logger.info('Retrying keyword', { keyword, nextAttempt: attempt + 1 });
        }
      }
    }
  }

  const allJobs = Array.from(allJobsMap.values());
  logger.info('Scraping finished', { totalUniqueJobs: allJobs.length });

  if (mode === 'json') {
    const outputPath = args.output || 'jobs.json';
    const resolved = path.resolve(process.cwd(), outputPath);
    const payload = allJobs.map((job) => ({
      ...job,
      raw_json: undefined,
    }));
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, JSON.stringify(payload, null, 2), 'utf8');
    logger.info('Wrote jobs to JSON file', {
      jobsCount: payload.length,
      outputPath: resolved,
    });
  } else {
    const db = getDb();
    const stmt = prepareDbStatement(db);

    const insertTransaction = db.transaction((jobs) => {
      for (const job of jobs) {
        const params = {
          ...job,
          raw_json: JSON.stringify(job),
        };
        stmt.run(params);
      }
    });

    insertTransaction(allJobs);
    db.close();
    logger.info('Upserted jobs into SQLite database', {
      jobsCount: allJobs.length,
      mode,
    });
  }

  await browser.close();
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('Fatal error in APSJobs scraper', { err });
    process.exit(1);
  });
}
