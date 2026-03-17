const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getLogger } = require('../logger');

const logger = getLogger('seekScraper');

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

function slugify(value) {
  if (!value) return '';
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildSeekUrl(keyword, location, pageIndex) {
  const keywordSlug = slugify(keyword);
  const locationSlug = slugify(location);

  let basePath = '';
  if (keywordSlug) {
    basePath = `/${keywordSlug}`;
  }

  if (locationSlug) {
    basePath = `${basePath}/in-${locationSlug}`;
  }

  if (!basePath) {
    basePath = '/jobs';
  }

  const pageParam = Number.isInteger(pageIndex) && pageIndex > 0 ? pageIndex : 1;
  const url = `https://www.seek.com.au${basePath}?page=${pageParam}`;
  return url;
}

async function navigateToSearch(page, keyword, location, pageIndex) {
  const url = buildSeekUrl(keyword, location, pageIndex);
  logger.info('Navigating to Seek URL', { url, keyword, location, pageIndex });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);
}

async function extractJobsFromPage(page) {
  const jobs = await page.$$eval(
    'div[data-automation="normalJob"], article[data-automation="job-card"], div[data-automation*="job-card"]',
    (cards) => {
      const results = [];

      const normText = (el) =>
        (el && (el.textContent || '').trim().replace(/\s+/g, ' ')) || '';

      for (const card of cards) {
        const titleEl =
          card.querySelector('a[data-automation="jobTitle"]') ||
          card.querySelector('h3[data-automation="jobTitle"]') ||
          card.querySelector('h3');

        const companyEl =
          card.querySelector('span[data-automation="jobCompany"]') ||
          card.querySelector('a[data-automation="jobCompany"]');

        const locationEl = card.querySelector('span[data-automation="jobLocation"]');

        const salaryEl = card.querySelector('span[data-automation="jobSalary"]');

        const descriptionEl =
          card.querySelector('span[data-automation="jobShortDescription"]') ||
          card.querySelector('p[data-automation="jobShortDescription"]');

        const postedEl =
          card.querySelector('[data-automation="jobListingDate"]') ||
          card.querySelector('span[data-automation*="listing-date" i]');

        const linkEl =
          card.querySelector('a[data-automation="jobTitle"]') ||
          card.querySelector('a[href*="/job/"]') ||
          card.querySelector('a[href*="/jobs/"]');

        const title = normText(titleEl);
        let companyName = normText(companyEl) || null;
        const location = normText(locationEl) || null;
        const salary = normText(salaryEl) || null;
        const description = normText(descriptionEl) || null;
        const postedAtRaw = normText(postedEl) || null;

        let href = linkEl && linkEl.getAttribute('href');
        let url = null;
        if (href) {
          if (href.startsWith('http')) {
            url = href;
          } else {
            url = new URL(href, 'https://www.seek.com.au').toString();
          }
        }

        if (!title || !url) {
          continue;
        }

        let jobId = null;
        try {
          const u = new URL(url);
          const pathParts = u.pathname.split('/').filter(Boolean);
          const lastSegment = pathParts[pathParts.length - 1] || '';
          const match = lastSegment.match(/(\d+)/);
          if (match) {
            jobId = match[1];
          }
        } catch (e) {
          // ignore URL parsing errors
        }

        if (!jobId && url) {
          const match = url.match(/job\/?(\d+)/);
          if (match) {
            jobId = match[1];
          }
        }

        if (!jobId && url) {
          jobId = url;
        }

        const externalId = `seek-${jobId}`;

        results.push({
          external_id: externalId,
          source: 'seek',
          role: title,
          title,
          company_name: companyName,
          location,
          salary,
          description,
          url,
          posted_at: postedAtRaw,
        });
      }

      return results;
    },
  );

  return jobs;
}

async function scrapeKeyword(page, keyword, location, maxPages, progressCtx) {
  const allJobs = [];

  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
    if (progressCtx && typeof progressCtx.total === 'number') {
      const nextCurrent =
        typeof progressCtx.current === 'number' ? progressCtx.current + 1 : 1;
      progressCtx.current = nextCurrent;
      emitProgress({
        total: progressCtx.total,
        current: progressCtx.current,
        message: `Scraping Seek "${keyword}" page ${pageIndex} of ${maxPages}`,
      });
    }

    await navigateToSearch(page, keyword, location, pageIndex);

    try {
      await Promise.race([
        page.waitForSelector('text=/No jobs found/i', { timeout: 15000 }),
        page.waitForSelector(
          'div[data-automation="normalJob"], article[data-automation="job-card"], div[data-automation*="job-card"]',
          { timeout: 15000 },
        ),
      ]);
    } catch {
      // best-effort; continue to extraction even on timeout
      logger.warn('Timeout waiting for Seek results', { keyword, pageIndex });
    }

    const jobs = await extractJobsFromPage(page);
    logger.info('Scraped Seek jobs for page', {
      keyword,
      pageIndex,
      jobsCount: jobs.length,
    });

    allJobs.push(...jobs);

    if (jobs.length === 0) {
      break;
    }
  }

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

  logger.info('Seek scraper starting', {
    mode,
    keywordsCount: keywords.length,
    location,
    maxPages,
  });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
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
      logger.info('Scraping Seek keyword', { keyword, attempt, maxRetries });

      try {
        const jobs = await scrapeKeyword(
          page,
          keyword,
          location,
          maxPages,
          progressCtx,
        );

        logger.info('Seek keyword scrape completed', {
          keyword,
          dedupedJobsCount: jobs.length,
        });

        for (const job of jobs) {
          allJobsMap.set(job.external_id, job);
        }

        success = true;
      } catch (err) {
        logger.error('Error scraping Seek keyword', {
          keyword,
          attempt,
          maxRetries,
          err,
        });
        if (attempt >= maxRetries) {
          logger.error('Giving up on Seek keyword after max retries', {
            keyword,
            maxRetries,
          });
        } else {
          logger.info('Retrying Seek keyword', {
            keyword,
            nextAttempt: attempt + 1,
          });
        }
      }
    }
  }

  const allJobs = Array.from(allJobsMap.values());
  logger.info('Seek scraping finished', { totalUniqueJobs: allJobs.length });

  if (mode === 'json') {
    const outputPath = args.output || 'seek-jobs.json';
    const resolved = path.resolve(process.cwd(), outputPath);
    const payload = allJobs.map((job) => ({
      ...job,
      raw_json: undefined,
    }));
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, JSON.stringify(payload, null, 2), 'utf8');
    logger.info('Wrote Seek jobs to JSON file', {
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
    logger.info('Upserted Seek jobs into SQLite database', {
      jobsCount: allJobs.length,
      mode,
    });
  }

  await browser.close();
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('Fatal error in Seek scraper', { err });
    process.exit(1);
  });
}

