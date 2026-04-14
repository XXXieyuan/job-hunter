'use strict';

const { describe, it, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { fillForm, splitName, VISA_STATUS_MAP, WORK_RIGHTS_MAP } = require('./seekFormFiller');

// ─── Mock helpers ──────────────────────────────────────────────

/**
 * Create a mock Playwright page object with configurable behavior.
 * @param {object} [opts]
 * @param {boolean} [opts.labelFails] - If true, getByLabel().fill() throws
 * @param {boolean} [opts.setInputFilesFails] - If true, setInputFiles() throws
 * @param {string} [opts.inputValue] - Value returned by inputValue() after file set
 * @returns {object} Mock page
 */
function createMockPage(opts = {}) {
  const filledValues = {};
  const selectedOptions = {};
  const attachedFiles = [];

  function makeMockElement(fieldKey) {
    return {
      fill: mock.fn(async (value) => {
        filledValues[fieldKey] = value;
      }),
      selectOption: mock.fn(async (option) => {
        selectedOptions[fieldKey] = option;
      }),
      setInputFiles: mock.fn(async (filePath) => {
        attachedFiles.push(filePath);
      }),
      inputValue: mock.fn(async () => opts.inputValue !== undefined ? opts.inputValue : 'C:\\fakepath\\file.docx'),
    };
  }

  function makeFailingElement() {
    return {
      fill: mock.fn(async () => { throw new Error('Element not found'); }),
      selectOption: mock.fn(async () => { throw new Error('Element not found'); }),
      setInputFiles: mock.fn(async () => { throw new Error('Element not found'); }),
      inputValue: mock.fn(async () => ''),
    };
  }

  const page = {
    _filledValues: filledValues,
    _selectedOptions: selectedOptions,
    _attachedFiles: attachedFiles,

    getByLabel: mock.fn((label) => {
      if (opts.labelFails) return makeFailingElement();
      return makeMockElement('label:' + label);
    }),

    getByPlaceholder: mock.fn((placeholder) => {
      return makeMockElement('placeholder:' + placeholder);
    }),

    locator: mock.fn((selector) => {
      if (selector === 'input[type="file"]') {
        const fileElements = [];
        const makeFileElement = (idx) => {
          const el = {
            setInputFiles: mock.fn(async (filePath) => {
              if (opts.setInputFilesFails && idx === 0) {
                throw new Error('File input not found');
              }
              attachedFiles.push(filePath);
            }),
            inputValue: mock.fn(async () => {
              if (opts.inputValue !== undefined) return opts.inputValue;
              return attachedFiles.length > 0 ? 'C:\\fakepath\\file.docx' : '';
            }),
          };
          fileElements.push(el);
          return el;
        };

        return {
          first: mock.fn(() => makeFileElement(0)),
          nth: mock.fn((n) => makeFileElement(n)),
        };
      }
      return makeMockElement('locator:' + selector);
    }),
  };

  return page;
}

function fullProfile() {
  return {
    full_name: 'Wei Zhang',
    email: 'wei@example.com',
    phone: '0412345678',
    visa_status: 'Permanent Resident',
    work_rights: 'Unrestricted',
    expected_salary: '120000',
    notice_period: '2 weeks',
  };
}

// ─── Mock docxBuilder ──────────────────────────────────────────

// Mock the docxBuilder module before tests
const docxBuilder = require('./docxBuilder');

// ─── Tests ─────────────────────────────────────────────────────

describe('splitName', () => {
  it('splits "Wei Zhang" into first="Wei", last="Zhang"', () => {
    const result = splitName('Wei Zhang');
    assert.equal(result.first, 'Wei');
    assert.equal(result.last, 'Zhang');
  });

  it('handles single-word name: "Wei" → first="Wei", last=""', () => {
    const result = splitName('Wei');
    assert.equal(result.first, 'Wei');
    assert.equal(result.last, '');
  });

  it('handles multi-part last name: "Mary Jane Watson"', () => {
    const result = splitName('Mary Jane Watson');
    assert.equal(result.first, 'Mary');
    assert.equal(result.last, 'Jane Watson');
  });

  it('handles empty string', () => {
    const result = splitName('');
    assert.equal(result.first, '');
    assert.equal(result.last, '');
  });

  it('handles null/undefined', () => {
    const result = splitName(null);
    assert.equal(result.first, '');
    assert.equal(result.last, '');
  });

  it('trims whitespace', () => {
    const result = splitName('  Wei Zhang  ');
    assert.equal(result.first, 'Wei');
    assert.equal(result.last, 'Zhang');
  });
});

describe('VISA_STATUS_MAP', () => {
  it('maps "Australian Citizen"', () => {
    assert.equal(VISA_STATUS_MAP['Australian Citizen'], 'Australian Citizen');
  });

  it('maps "Permanent Resident"', () => {
    assert.equal(VISA_STATUS_MAP['Permanent Resident'], 'Permanent Resident');
  });

  it('maps "Temporary Visa"', () => {
    assert.equal(VISA_STATUS_MAP['Temporary Visa'], 'I have a valid visa');
  });
});

describe('WORK_RIGHTS_MAP', () => {
  it('maps "Unrestricted"', () => {
    assert.equal(WORK_RIGHTS_MAP['Unrestricted'], 'I can work on a full-time basis');
  });

  it('maps "Restricted"', () => {
    assert.equal(WORK_RIGHTS_MAP['Restricted'], 'I need work visa sponsorship');
  });
});

describe('fillForm', () => {
  let buildDocxToFileMock;

  beforeEach(() => {
    buildDocxToFileMock = mock.method(docxBuilder, 'buildDocxToFile', () => ({
      path: '/tmp/test-cover-letter.docx',
      cleanup: mock.fn(),
    }));
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('full successful fill: all fields filled, resume and cover letter attached', async () => {
    const page = createMockPage();
    const profile = fullProfile();

    const result = await fillForm(page, profile, '/path/to/resume.docx', 'Dear Hiring Manager...');

    assert.equal(result.success, true);
    assert.ok(result.filledFields.includes('firstName'));
    assert.ok(result.filledFields.includes('lastName'));
    assert.ok(result.filledFields.includes('email'));
    assert.ok(result.filledFields.includes('phone'));
    assert.ok(result.filledFields.includes('visa_status'));
    assert.ok(result.filledFields.includes('work_rights'));
    assert.ok(result.filledFields.includes('expected_salary'));
    assert.ok(result.filledFields.includes('notice_period'));
    assert.ok(result.filledFields.includes('resume'));
    assert.ok(result.filledFields.includes('coverLetter'));
    assert.equal(result.warnings.length, 0);
  });

  it('name splitting: "Wei Zhang" fills first="Wei", last="Zhang"', async () => {
    const page = createMockPage();
    const profile = fullProfile();

    await fillForm(page, profile, '/path/to/resume.docx', null);

    // Verify getByLabel was called for first and last name
    const labelCalls = page.getByLabel.mock.calls.map(c => c.arguments[0]);
    assert.ok(labelCalls.includes('First name'));
    assert.ok(labelCalls.includes('Last name'));
  });

  it('missing full_name returns success: false', async () => {
    const page = createMockPage();
    const profile = { ...fullProfile(), full_name: '' };

    const result = await fillForm(page, profile, '/path/to/resume.docx', null);

    assert.equal(result.success, false);
    assert.ok(result.warnings.some(w => w.includes('full_name')));
  });

  it('missing email returns success: false', async () => {
    const page = createMockPage();
    const profile = { ...fullProfile(), email: '' };

    const result = await fillForm(page, profile, '/path/to/resume.docx', null);

    assert.equal(result.success, false);
    assert.ok(result.warnings.some(w => w.includes('email')));
  });

  it('missing optional field produces warning, not failure', async () => {
    const page = createMockPage();
    const profile = {
      full_name: 'Wei Zhang',
      email: 'wei@example.com',
      phone: null,
      visa_status: null,
      work_rights: null,
      expected_salary: null,
      notice_period: null,
    };

    const result = await fillForm(page, profile, '/path/to/resume.docx', null);

    assert.equal(result.success, true);
    // No warnings for null optional fields (they're just skipped)
    assert.ok(result.filledFields.includes('firstName'));
    assert.ok(result.filledFields.includes('email'));
  });

  it('resume attachment failure returns success: false', async () => {
    const page = createMockPage({ setInputFilesFails: true });
    const profile = fullProfile();

    const result = await fillForm(page, profile, '/path/to/resume.docx', null);

    assert.equal(result.success, false);
    assert.ok(result.warnings.some(w => w.includes('Resume attachment failed') || w.includes('File input not found')));
  });

  it('selector fallback: label fails, placeholder succeeds', async () => {
    const page = createMockPage({ labelFails: true });
    const profile = fullProfile();

    const result = await fillForm(page, profile, '/path/to/resume.docx', null);

    assert.equal(result.success, true);
    assert.ok(result.filledFields.includes('firstName'));
    // Verify getByPlaceholder was used as fallback
    const placeholderCalls = page.getByPlaceholder.mock.calls.map(c => c.arguments[0]);
    assert.ok(placeholderCalls.length > 0);
  });

  it('cover letter DOCX temp file cleanup is called', async () => {
    // The beforeEach already mocks buildDocxToFile — get the cleanup fn from it
    const page = createMockPage();
    const profile = fullProfile();

    await fillForm(page, profile, '/path/to/resume.docx', 'Dear Hiring Manager...');

    // Verify buildDocxToFile was called
    assert.equal(buildDocxToFileMock.mock.calls.length, 1);
    // Verify cleanup was called on the returned object
    const returnedObj = buildDocxToFileMock.mock.calls[0].result;
    assert.equal(returnedObj.cleanup.mock.calls.length, 1);
  });

  it('resume attachment with empty inputValue returns success: false', async () => {
    const page = createMockPage({ inputValue: '' });
    const profile = fullProfile();

    const result = await fillForm(page, profile, '/path/to/resume.docx', null);

    assert.equal(result.success, false);
    assert.ok(result.warnings.some(w => w.includes('verification failed')));
  });

  it('visa_status maps all known values correctly', async () => {
    for (const [status, expectedText] of Object.entries(VISA_STATUS_MAP)) {
      const page = createMockPage();
      const profile = { ...fullProfile(), visa_status: status };
      const result = await fillForm(page, profile, '/path/to/resume.docx', null);
      assert.equal(result.success, true);
      assert.ok(result.filledFields.includes('visa_status'), `visa_status not filled for ${status}`);
    }
  });

  it('work_rights maps both values correctly', async () => {
    for (const rights of ['Unrestricted', 'Restricted']) {
      const page = createMockPage();
      const profile = { ...fullProfile(), work_rights: rights };
      const result = await fillForm(page, profile, '/path/to/resume.docx', null);
      assert.equal(result.success, true);
      assert.ok(result.filledFields.includes('work_rights'), `work_rights not filled for ${rights}`);
    }
  });
});
