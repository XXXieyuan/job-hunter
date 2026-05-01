const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildApsDetailUrl,
  getApsApplicationUrl,
  getApsDetailUrl,
  getJobApplyUrl,
  getJobSourceUrl,
} = require('./jobLinks');

test('buildApsDetailUrl creates the canonical APS detail URL', () => {
  const url = buildApsDetailUrl(
    'Software & Applications Programmer - SAP Payroll',
    'a05OY00000NyLE3YAN',
  );

  assert.equal(
    url,
    'https://www.apsjobs.gov.au/s/job-details?title=software-applications-programmer-sap-payroll&Id=a05OY00000NyLE3YAN',
  );
});

test('getApsDetailUrl prefers jobId plus title slug over the legacy vacancy URL', () => {
  const url = getApsDetailUrl({
    source: 'apsjobs',
    title: 'Software & Applications Programmer - SAP Payroll',
    url: 'https://www.apsjobs.gov.au/s/job-details/VN-0768803',
    raw_json: JSON.stringify({
      vacancyNumber: 'VN-0768803',
      jobId: 'a05OY00000NyLE3YAN',
      jobName: 'Software & Applications Programmer - SAP Payroll',
    }),
  });

  assert.equal(
    url,
    'https://www.apsjobs.gov.au/s/job-details?title=software-applications-programmer-sap-payroll&Id=a05OY00000NyLE3YAN',
  );
});

test('getApsApplicationUrl prefers APS applicationURL from raw_json', () => {
  const url = getApsApplicationUrl({
    source: 'apsjobs',
    url: 'https://www.apsjobs.gov.au/s/job-details/VN-0768714',
    raw_json: JSON.stringify({
      applicationURL: 'https://www.asis.gov.au/Careers/Current-Vacancies/',
      vacancyNumber: 'VN-0768714',
    }),
  });

  assert.equal(url, 'https://www.asis.gov.au/Careers/Current-Vacancies/');
});

test('getJobSourceUrl falls back to the canonical APS detail URL for old stored rows', () => {
  const url = getJobSourceUrl({
    source: 'apsjobs',
    title: 'Software Engineer',
    url: 'https://www.apsjobs.gov.au/s/job-details/VN-0768714',
    raw_json: JSON.stringify({
      jobId: 'a05OY00000NrH0fYAF',
      jobName: 'Software Engineer',
      vacancyNumber: 'VN-0768714',
    }),
  });

  assert.equal(
    url,
    'https://www.apsjobs.gov.au/s/job-details?title=software-engineer&Id=a05OY00000NrH0fYAF',
  );
});

test('getJobApplyUrl falls back to the listing URL when APS applicationURL is missing', () => {
  const url = getJobApplyUrl({
    source: 'apsjobs',
    title: 'Software Engineer',
    url: 'https://www.apsjobs.gov.au/s/job-details/VN-0768714',
    raw_json: JSON.stringify({
      vacancyNumber: 'VN-0768714',
      jobId: 'a05OY00000NrH0fYAF',
      jobName: 'Software Engineer',
    }),
  });

  assert.equal(
    url,
    'https://www.apsjobs.gov.au/s/job-details?title=software-engineer&Id=a05OY00000NrH0fYAF',
  );
});

test('getJobApplyUrl ignores invalid APS application URLs', () => {
  const url = getJobApplyUrl({
    source: 'apsjobs',
    title: 'Software Engineer',
    url: 'https://www.apsjobs.gov.au/s/job-details/VN-0768714',
    raw_json: JSON.stringify({
      applicationURL: 'javascript:alert(1)',
      jobId: 'a05OY00000NrH0fYAF',
      jobName: 'Software Engineer',
    }),
  });

  assert.equal(
    url,
    'https://www.apsjobs.gov.au/s/job-details?title=software-engineer&Id=a05OY00000NrH0fYAF',
  );
});

test('getApsApplicationUrl does not reuse APS-specific raw_json fields for other sources', () => {
  const url = getApsApplicationUrl({
    source: 'seek',
    url: 'https://www.seek.com.au/job/123',
    raw_json: JSON.stringify({
      applicationURL: 'https://example.com/apply',
    }),
  });

  assert.equal(url, null);
});
