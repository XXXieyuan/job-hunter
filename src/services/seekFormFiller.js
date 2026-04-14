'use strict';

const { getLogger } = require('../logger');
const docxBuilder = require('./docxBuilder');

const logger = getLogger('seekFormFiller');

/**
 * Visa status values mapped to Seek dropdown option text.
 */
const VISA_STATUS_MAP = {
  'Australian Citizen': 'Australian Citizen',
  'Permanent Resident': 'Permanent Resident',
  'Temporary Visa': 'I have a valid visa',
  'Work Visa': 'I have a valid visa',
};

/**
 * Work rights values mapped to Seek dropdown option text.
 */
const WORK_RIGHTS_MAP = {
  Unrestricted: 'I can work on a full-time basis',
  Restricted: 'I need work visa sponsorship',
};

/**
 * Split a full name into first and last parts at the first space boundary.
 * Single-word names get an empty string for last.
 * @param {string} fullName
 * @returns {{ first: string, last: string }}
 */
function splitName(fullName) {
  const trimmed = (fullName || '').trim();
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) {
    return { first: trimmed, last: '' };
  }
  return {
    first: trimmed.slice(0, spaceIdx),
    last: trimmed.slice(spaceIdx + 1),
  };
}

/**
 * Try to fill a text field using a selector fallback chain:
 * 1. getByLabel → 2. getByPlaceholder → 3. attribute-based locator
 *
 * @param {object} page - Playwright page
 * @param {string} fieldName - Human-readable field name
 * @param {string} value - Value to fill
 * @param {object} selectors - { label, placeholder, attribute }
 * @returns {Promise<boolean>} true if filled successfully
 */
async function fillTextField(page, fieldName, value, selectors) {
  // Strategy 1: getByLabel
  if (selectors.label) {
    try {
      const el = page.getByLabel(selectors.label);
      await el.fill(value);
      return true;
    } catch (_) {
      // fall through
    }
  }

  // Strategy 2: getByPlaceholder
  if (selectors.placeholder) {
    try {
      const el = page.getByPlaceholder(selectors.placeholder);
      await el.fill(value);
      return true;
    } catch (_) {
      // fall through
    }
  }

  // Strategy 3: attribute-based locator
  if (selectors.attribute) {
    try {
      const el = page.locator(selectors.attribute);
      await el.fill(value);
      return true;
    } catch (_) {
      // fall through
    }
  }

  return false;
}

/**
 * Try to select a dropdown value using getByLabel then locator fallback.
 *
 * @param {object} page - Playwright page
 * @param {string} fieldName - Human-readable field name
 * @param {string} optionText - Option text to select
 * @param {object} selectors - { label, attribute }
 * @returns {Promise<boolean>} true if selected successfully
 */
async function selectDropdown(page, fieldName, optionText, selectors) {
  if (selectors.label) {
    try {
      const el = page.getByLabel(selectors.label);
      await el.selectOption({ label: optionText });
      return true;
    } catch (_) {
      // fall through
    }
  }

  if (selectors.attribute) {
    try {
      const el = page.locator(selectors.attribute);
      await el.selectOption({ label: optionText });
      return true;
    } catch (_) {
      // fall through
    }
  }

  return false;
}

/**
 * Fill a Seek application form with profile data, attach resume and cover letter.
 *
 * @param {object} page - Playwright page object (on the Seek apply form)
 * @param {object} profile - Application profile (full_name, email, phone, visa_status, work_rights, expected_salary, notice_period)
 * @param {string} resumePath - Absolute path to resume DOCX file
 * @param {string|null} coverLetterText - Cover letter plain text (will be converted to DOCX)
 * @returns {Promise<{ filledFields: string[], warnings: string[], success: boolean }>}
 */
async function fillForm(page, profile, resumePath, coverLetterText) {
  const filledFields = [];
  const warnings = [];
  let success = true;

  // --- Required fields ---

  // Name splitting
  const { first, last } = splitName(profile.full_name);

  if (!first) {
    return { filledFields, warnings: ['Missing required field: full_name'], success: false };
  }

  // First name
  const filledFirst = await fillTextField(page, 'First name', first, {
    label: 'First name',
    placeholder: 'First name',
    attribute: 'input[name="firstName"]',
  });
  if (filledFirst) {
    filledFields.push('firstName');
  } else {
    warnings.push('Could not fill first name');
  }

  // Last name
  const filledLast = await fillTextField(page, 'Last name', last, {
    label: 'Last name',
    placeholder: 'Last name',
    attribute: 'input[name="lastName"]',
  });
  if (filledLast) {
    filledFields.push('lastName');
  } else if (last) {
    warnings.push('Could not fill last name');
  }

  // Email (required)
  if (!profile.email) {
    return { filledFields, warnings: ['Missing required field: email'], success: false };
  }
  const filledEmail = await fillTextField(page, 'Email', profile.email, {
    label: 'Email',
    placeholder: 'Email',
    attribute: 'input[name="email"], input[type="email"]',
  });
  if (filledEmail) {
    filledFields.push('email');
  } else {
    warnings.push('Could not fill email');
  }

  // Phone
  if (profile.phone) {
    const filledPhone = await fillTextField(page, 'Phone', profile.phone, {
      label: 'Phone',
      placeholder: 'Phone',
      attribute: 'input[name="phone"], input[type="tel"]',
    });
    if (filledPhone) {
      filledFields.push('phone');
    } else {
      warnings.push('Could not fill phone');
    }
  }

  // --- Dropdowns ---

  // Visa status
  if (profile.visa_status && VISA_STATUS_MAP[profile.visa_status]) {
    const optionText = VISA_STATUS_MAP[profile.visa_status];
    const filled = await selectDropdown(page, 'Visa status', optionText, {
      label: 'Work eligibility',
      attribute: 'select[name="workEligibility"]',
    });
    if (filled) {
      filledFields.push('visa_status');
    } else {
      warnings.push('Could not select visa status dropdown');
    }
  } else if (profile.visa_status) {
    warnings.push('Unknown visa_status value: ' + profile.visa_status);
  }

  // Work rights
  if (profile.work_rights && WORK_RIGHTS_MAP[profile.work_rights]) {
    const optionText = WORK_RIGHTS_MAP[profile.work_rights];
    const filled = await selectDropdown(page, 'Work rights', optionText, {
      label: 'Work type',
      attribute: 'select[name="workType"]',
    });
    if (filled) {
      filledFields.push('work_rights');
    } else {
      warnings.push('Could not select work rights dropdown');
    }
  }

  // --- Optional fields ---

  if (profile.expected_salary) {
    const filled = await fillTextField(page, 'Expected salary', String(profile.expected_salary), {
      label: 'Expected salary',
      placeholder: 'Expected salary',
      attribute: 'input[name="expectedSalary"]',
    });
    if (filled) {
      filledFields.push('expected_salary');
    } else {
      warnings.push('Could not fill expected salary (optional)');
    }
  }

  if (profile.notice_period) {
    const filled = await fillTextField(page, 'Notice period', profile.notice_period, {
      label: 'Notice period',
      placeholder: 'Notice period',
      attribute: 'input[name="noticePeriod"]',
    });
    if (filled) {
      filledFields.push('notice_period');
    } else {
      warnings.push('Could not fill notice period (optional)');
    }
  }

  // --- File attachments ---

  // Resume DOCX
  try {
    const fileInputs = page.locator('input[type="file"]');
    const firstFileInput = fileInputs.first();
    await firstFileInput.setInputFiles(resumePath);

    // Verify attachment
    const inputValue = await firstFileInput.inputValue();
    if (!inputValue) {
      return { filledFields, warnings: [...warnings, 'Resume attachment verification failed'], success: false };
    }
    filledFields.push('resume');
  } catch (err) {
    logger.warn('Resume attachment failed', { error: err.message });
    return { filledFields, warnings: [...warnings, 'Resume attachment failed: ' + err.message], success: false };
  }

  // Cover letter DOCX (generate temp file from text)
  if (coverLetterText) {
    let coverLetterFile = null;
    try {
      coverLetterFile = docxBuilder.buildDocxToFile(coverLetterText);
      const fileInputs = page.locator('input[type="file"]');
      const secondFileInput = fileInputs.nth(1);
      await secondFileInput.setInputFiles(coverLetterFile.path);
      filledFields.push('coverLetter');
    } catch (err) {
      warnings.push('Cover letter attachment failed: ' + err.message);
    } finally {
      if (coverLetterFile) {
        coverLetterFile.cleanup();
      }
    }
  }

  return { filledFields, warnings, success };
}

module.exports = {
  fillForm,
  splitName,
  // Exported for testing
  VISA_STATUS_MAP,
  WORK_RIGHTS_MAP,
};
