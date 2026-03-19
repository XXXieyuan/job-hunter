'use strict';

const { spawn } = require('child_process');
const path = require('path');

const VALID_SOURCES = new Set(['seek', 'linkedin', 'apsjobs']);

function parseArgs(argv) {
  const args = {
    source: '',
    keywords: '',
    max_pages: '1'
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }

    args[key] = value;
    index += 1;
  }

  if (!VALID_SOURCES.has(args.source)) {
    throw new Error(`Invalid --source. Expected one of: ${[...VALID_SOURCES].join(', ')}`);
  }

  if (!String(args.keywords || '').trim()) {
    throw new Error('--keywords is required');
  }

  const maxPages = Number.parseInt(args.max_pages, 10);
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error('--max_pages must be a positive integer');
  }

  return {
    source: args.source,
    keywords: args.keywords.trim(),
    maxPages
  };
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function createSummary() {
  return {
    totalJobs: 0,
    missingDescriptions: 0,
    shortDescriptions: 0,
    descriptionsEqualToTitle: 0,
    shortSamples: [],
    titleSamples: [],
    warnings: [],
    pages: 0,
    jobsFoundEvent: null
  };
}

function trackJob(summary, job) {
  const title = normalizeText(job.title);
  const description = normalizeText(job.job_description);

  summary.totalJobs += 1;

  if (!description) {
    summary.missingDescriptions += 1;
    return;
  }

  if (description.length < 80) {
    summary.shortDescriptions += 1;
    if (summary.shortSamples.length < 5) {
      summary.shortSamples.push({
        title,
        description
      });
    }
  }

  if (title && description === title) {
    summary.descriptionsEqualToTitle += 1;
    if (summary.titleSamples.length < 5) {
      summary.titleSamples.push(title);
    }
  }
}

function handleEvent(summary, payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  if (payload.type === 'job_found' && payload.job) {
    trackJob(summary, payload.job);
  }

  if (payload.type === 'warning' && payload.message) {
    summary.warnings.push(String(payload.message));
  }

  if (payload.type === 'page_done' && payload.page) {
    summary.pages = Math.max(summary.pages, Number(payload.page) || 0);
  }

  if (payload.type === 'done') {
    summary.jobsFoundEvent = Number(payload.jobsFound);
    summary.pages = Math.max(summary.pages, Number(payload.pages) || 0);
  }
}

function parseSseChunk(summary, chunk) {
  const line = chunk
    .split('\n')
    .find((entry) => entry.trim().startsWith('data:'));

  if (!line) {
    return;
  }

  const payload = JSON.parse(line.replace(/^data:\s*/, ''));
  handleEvent(summary, payload);
}

function printSummary(input, summary) {
  console.log(`Source: ${input.source}`);
  console.log(`Keywords: ${input.keywords}`);
  console.log(`Max pages: ${input.maxPages}`);
  console.log(`Total jobs: ${summary.totalJobs}`);
  console.log(`Missing descriptions: ${summary.missingDescriptions}`);
  console.log(`Short descriptions (<80 chars): ${summary.shortDescriptions}`);
  console.log(`Descriptions equal to title: ${summary.descriptionsEqualToTitle}`);

  if (summary.shortSamples.length) {
    console.log('Short description samples:');
    for (const sample of summary.shortSamples) {
      console.log(`- ${sample.title}: ${sample.description}`);
    }
  }

  if (summary.titleSamples.length) {
    console.log('Descriptions equal to title samples:');
    for (const title of summary.titleSamples) {
      console.log(`- ${title}`);
    }
  }

  if (summary.warnings.length) {
    console.log('Warnings:');
    for (const message of summary.warnings) {
      console.log(`- ${message}`);
    }
  }
}

function main() {
  let input;

  try {
    input = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const scraperPath = path.resolve(__dirname, '..', 'scrapers', 'run_scraper.py');
  const args = [
    scraperPath,
    '--source',
    input.source,
    '--keywords',
    input.keywords,
    '--max_pages',
    String(input.maxPages)
  ];

  const summary = createSummary();
  const processHandle = spawn('python', args, {
    cwd: path.resolve(__dirname, '..'),
    env: process.env
  });

  let stdoutBuffer = '';
  let stderrBuffer = '';

  processHandle.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const events = stdoutBuffer.split('\n\n');
    stdoutBuffer = events.pop() || '';

    for (const event of events) {
      try {
        parseSseChunk(summary, event);
      } catch (error) {
        stderrBuffer += `${error.message}\n`;
      }
    }
  });

  processHandle.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString();
  });

  processHandle.on('close', (code) => {
    if (stdoutBuffer.trim()) {
      try {
        parseSseChunk(summary, stdoutBuffer);
      } catch (error) {
        stderrBuffer += `${error.message}\n`;
      }
    }

    printSummary(input, summary);

    if (code !== 0) {
      if (stderrBuffer.trim()) {
        console.error(stderrBuffer.trim());
      }
      process.exit(code || 1);
    }
  });
}

main();
