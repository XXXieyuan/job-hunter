'use strict';

const { chromium } = require('playwright');

function buildUrl(keyword, pageNumber) {
  const slug = encodeURIComponent(String(keyword || '').replace(/,/g, ' ').trim())
    .replace(/%20/g, '-');
  return `https://www.seek.com.au/${slug}/jobs?sortmode=ListedDate&page=${pageNumber}`;
}

async function extractJobs(page) {
  return page.evaluate(async () => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const cards = Array.from(document.querySelectorAll('[data-automation="normalJob"], article'));
    const jobs = [];

    for (const card of cards) {
      const titleElement =
        card.querySelector('[data-automation="jobTitle"] a') ||
        card.querySelector('a[data-automation="jobTitle"]') ||
        card.querySelector('a');
      if (!titleElement) {
        continue;
      }

      const companyElement =
        card.querySelector('[data-automation="jobCompany"]') ||
        card.querySelector('[data-automation="advertiser-name"]');
      const locationElement =
        card.querySelector('[data-automation="jobLocation"]') ||
        card.querySelector('[data-automation="job-detail-location"]');
      const salaryElement =
        card.querySelector('[data-automation="jobSalary"]') ||
        card.querySelector('[data-automation="job-detail-salary"]');
      const dateElement =
        card.querySelector('[data-automation="jobListingDate"]') ||
        card.querySelector('time');

      jobs.push({
        external_id: clean(titleElement.href || titleElement.getAttribute('href') || '').split('/').pop(),
        title: clean(titleElement.textContent),
        company: clean(companyElement?.textContent),
        location: clean(locationElement?.textContent),
        salary_text: clean(salaryElement?.textContent),
        job_url: titleElement.href || titleElement.getAttribute('href'),
        posted_date: clean(dateElement?.getAttribute('datetime') || dateElement?.textContent),
      });
    }

    return jobs;
  });
}

function parseSalary(text) {
  const matches = [...String(text || '').matchAll(/\$?\s?(\d+(?:\.\d+)?)\s*([kK])?/g)];
  if (!matches.length) {
    return { salary_min: null, salary_max: null };
  }

  const values = matches.map((match) => {
    let value = Number(match[1]);
    if (match[2]) {
      value *= 1000;
    }
    return Math.round(value);
  });

  return {
    salary_min: values[0] ?? null,
    salary_max: values[1] ?? values[0] ?? null
  };
}

async function enrichDescriptions(browser, jobs) {
  const page = await browser.newPage();
  const enriched = [];

  for (const job of jobs.slice(0, 10)) {
    let description = '';
    try {
      await page.goto(job.job_url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      description = await page.evaluate(() => {
        const target =
          document.querySelector('[data-automation="jobAdDetails"]') ||
          document.querySelector('article');
        return (target?.textContent || '').replace(/\s+/g, ' ').trim();
      });
    } catch (error) {
      description = '';
    }

    enriched.push({
      ...job,
      ...parseSalary(job.salary_text),
      salary_currency: 'AUD',
      job_description: description || job.title
    });
  }

  await page.close();
  return enriched;
}

async function main() {
  const args = process.argv.slice(2);
  const keyword = args[args.indexOf('--keyword') + 1] || '';
  const pageNumber = Number(args[args.indexOf('--page') + 1] || 1);
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto(buildUrl(keyword, pageNumber), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const jobs = await extractJobs(page);
    const enriched = await enrichDescriptions(browser, jobs);
    process.stdout.write(JSON.stringify({ jobs: enriched }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      jobs: [],
      warning: `SEEK Playwright fallback: ${String(error.message || error).split('\n')[0]}`
    }));
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

main();
