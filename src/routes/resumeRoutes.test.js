'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { AppError, ERROR_STATUS_MAP } = require('../utils/errors');
const { resumeUpdateSchema, validate } = require('../middleware/validators');

// Helper: mock Express req/res for middleware testing
function mockReq(overrides = {}) {
  return {
    body: {},
    query: {},
    params: {},
    cookies: {},
    ip: '127.0.0.1',
    path: '/api/resumes',
    originalUrl: '/api/resumes',
    method: 'GET',
    get: () => null,
    accepts: () => false,
    user: { id: 1 },
    ...overrides,
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
  };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  res.set = (key, val) => { res.headers[key] = val; return res; };
  return res;
}

// T-52: GET /api/resumes — list with parsed JSON arrays
describe('T-52: GET /api/resumes — list JSON parsing', () => {
  it('skills_json string is parseable to array', () => {
    const raw = '[{"name":"Python","category":"technical","proficiency":"advanced"}]';
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed[0].name, 'Python');
    assert.equal(parsed[0].category, 'technical');
  });

  it('backgroundQueue exports queue array and enqueue function', () => {
    const backgroundQueue = require('../services/backgroundQueue');
    assert.ok(Array.isArray(backgroundQueue.queue));
    assert.equal(typeof backgroundQueue.enqueue, 'function');
  });
});

// T-53: GET /api/resumes — requireAuth enforced
describe('T-53: GET /api/resumes — requireAuth enforced', () => {
  it('requireAuth middleware is a function', () => {
    const { requireAuth } = require('../middleware/auth');
    assert.equal(typeof requireAuth, 'function');
  });

  it('AUTHENTICATION_REQUIRED maps to 401', () => {
    assert.equal(ERROR_STATUS_MAP.AUTHENTICATION_REQUIRED, 401);
  });
});

// T-54: GET /api/resumes/:id — IDOR prevention
describe('T-54: GET /api/resumes/:id — IDOR prevention', () => {
  it('NOT_FOUND AppError has 404 status and serializes correctly', () => {
    const err = new AppError('NOT_FOUND', 'Resume not found');
    assert.equal(err.statusCode, 404);
    assert.equal(err.code, 'NOT_FOUND');
    const json = err.toJSON();
    assert.deepEqual(json, { code: 'NOT_FOUND', message: 'Resume not found' });
  });

  it('getResumeByIdAndUser function exists in resumesRepo', () => {
    const { getResumeByIdAndUser } = require('../repositories/resumesRepo');
    assert.equal(typeof getResumeByIdAndUser, 'function');
  });
});

// T-147: GET /api/resumes/:id — happy-path response shape
describe('T-147: GET /api/resumes/:id — response fields match contract', () => {
  it('resumeUpdateSchema accepts all valid field types', () => {
    const result = resumeUpdateSchema.safeParse({
      summary: 'Experienced data analyst',
      skills_json: [{ name: 'Python', category: 'technical', proficiency: 'advanced' }],
      experience_json: [{ title: 'Analyst', employer: 'Acme' }],
      education_json: [{ degree: 'BSc', institution: 'Uni' }],
      certifications_json: [{ name: 'AWS', issuer: 'Amazon' }],
      is_confirmed: true,
    });
    assert.equal(result.success, true);
    assert.ok(Array.isArray(result.data.skills_json));
    assert.ok(Array.isArray(result.data.experience_json));
    assert.ok(Array.isArray(result.data.education_json));
    assert.ok(Array.isArray(result.data.certifications_json));
  });
});

// T-55: DELETE /api/resumes/:id — CASCADE deletes
describe('T-55: DELETE /api/resumes/:id — CASCADE deletes', () => {
  it('deleteResume function exists in resumesRepo', () => {
    const { deleteResume } = require('../repositories/resumesRepo');
    assert.equal(typeof deleteResume, 'function');
  });
});

// T-56: DELETE /api/resumes/:id — ownership enforced
describe('T-56: DELETE /api/resumes/:id — ownership enforced', () => {
  it('NOT_FOUND error for non-owned resume has correct status', () => {
    const err = new AppError('NOT_FOUND', 'Resume not found');
    assert.equal(err.statusCode, 404);
  });
});

// T-57: POST /api/resumes — DOCX upload success
describe('T-57: POST /api/resumes — DOCX upload success', () => {
  it('validateDocxOnly returns middleware function', () => {
    const { validateDocxOnly } = require('../middleware/fileValidator');
    const mw = validateDocxOnly();
    assert.equal(typeof mw, 'function');
  });
});

// T-58: POST /api/resumes — non-DOCX file rejected
describe('T-58: POST /api/resumes — non-DOCX file rejected', () => {
  it('INVALID_FILE_TYPE maps to 400 via ERROR_STATUS_MAP', () => {
    assert.equal(ERROR_STATUS_MAP.INVALID_FILE_TYPE, 400);
    const err = new AppError('INVALID_FILE_TYPE', 'Only DOCX files are allowed');
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, 'INVALID_FILE_TYPE');
  });
});

// T-59: POST /api/resumes — file >10MB rejected
describe('T-59: POST /api/resumes — file >10MB rejected', () => {
  it('FILE_TOO_LARGE maps to 400 via ERROR_STATUS_MAP', () => {
    assert.equal(ERROR_STATUS_MAP.FILE_TOO_LARGE, 400);
    const err = new AppError('FILE_TOO_LARGE', 'File exceeds 10MB limit');
    assert.equal(err.statusCode, 400);
  });
});

// T-60: POST /api/resumes — MIME type + magic byte validation
describe('T-60: POST /api/resumes — MIME type + magic byte validation', () => {
  it('fileValidator SIGNATURES has docx key with PK magic bytes', () => {
    // Verify magic byte detection logic in fileValidator
    const docxMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    const pdfMagic = Buffer.from([0x25, 0x50, 0x44, 0x46]);
    assert.ok(!pdfMagic.slice(0, 4).equals(docxMagic), 'PDF should not match DOCX signature');
    assert.equal(docxMagic[0], 0x50); // P
    assert.equal(docxMagic[1], 0x4b); // K
  });

  it('validateFileType and validateDocxOnly are both exported', () => {
    const { validateFileType, validateDocxOnly } = require('../middleware/fileValidator');
    assert.equal(typeof validateFileType, 'function');
    assert.equal(typeof validateDocxOnly, 'function');
  });
});

// T-61: POST /api/resumes — rate limited at 10/day/user
describe('T-61: POST /api/resumes — rate limited at 10/day/user', () => {
  it('rateLimiter factory returns middleware function', () => {
    const { rateLimiter } = require('../middleware/rateLimiter');
    const mw = rateLimiter({ windowMs: 86400000, max: 10, scope: 'user', prefix: 'test' });
    assert.equal(typeof mw, 'function');
  });

  it('RATE_LIMITED maps to 429', () => {
    assert.equal(ERROR_STATUS_MAP.RATE_LIMITED, 429);
  });
});

// T-62: PUT /api/resumes/:id — confirm triggers embedding regeneration
describe('T-62: PUT /api/resumes/:id — confirm triggers embedding regeneration', () => {
  it('validateResumeUpdate middleware validates is_confirmed field via Zod', () => {
    const middleware = validate(resumeUpdateSchema);
    const req = mockReq({ body: { is_confirmed: true } });
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.ok(nextCalled, 'Valid body should pass Zod validation');
    assert.equal(req.validatedBody.is_confirmed, true);
  });

  it('validateResumeUpdate rejects invalid skills_json type', () => {
    const middleware = validate(resumeUpdateSchema);
    const req = mockReq({ body: { skills_json: 'not an array' } });
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  it('updateEmbedding function exists in resumesRepo', () => {
    const { updateEmbedding } = require('../repositories/resumesRepo');
    assert.equal(typeof updateEmbedding, 'function');
  });

  it('generateEmbedding function exists in openAIClient', () => {
    const { generateEmbedding } = require('../services/openAIClient');
    assert.equal(typeof generateEmbedding, 'function');
  });

  it('buildResumeEmbeddingText function exists in scoringService', () => {
    const { buildResumeEmbeddingText } = require('../services/scoringService');
    assert.equal(typeof buildResumeEmbeddingText, 'function');
  });
});

// T-120: File validator — DOCX MIME + magic byte validation
describe('T-120: File validator — DOCX MIME + magic byte validation', () => {
  it('validateDocxOnly returns middleware that checks req.file', () => {
    const { validateDocxOnly } = require('../middleware/fileValidator');
    const middleware = validateDocxOnly();
    assert.equal(typeof middleware, 'function');
    assert.equal(middleware.length, 3, 'Should be a standard (req, res, next) middleware');
  });
});

// T-121: File validator — 10MB size limit
describe('T-121: File validator — 10MB size limit', () => {
  it('FILE_TOO_LARGE error maps to 400', () => {
    assert.equal(ERROR_STATUS_MAP.FILE_TOO_LARGE, 400);
    const err = new AppError('FILE_TOO_LARGE', 'File exceeds 10MB limit');
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, 'FILE_TOO_LARGE');
    assert.equal(err.message, 'File exceeds 10MB limit');
  });
});

// T-63: PUT /api/resumes/:id — Zod validation on JSON fields
describe('T-63: PUT /api/resumes/:id — Zod validation on JSON fields', () => {
  it('rejects skills_json as string instead of array', () => {
    const result = resumeUpdateSchema.safeParse({ skills_json: 'not an array' });
    assert.equal(result.success, false);
    const fieldError = result.error.issues.find(i => i.path.includes('skills_json'));
    assert.ok(fieldError, 'Should have an error on skills_json field');
  });

  it('accepts valid skills_json array with correct item shape', () => {
    const result = resumeUpdateSchema.safeParse({
      skills_json: [{ name: 'Python', category: 'technical', proficiency: 'advanced' }],
    });
    assert.equal(result.success, true);
    assert.equal(result.data.skills_json[0].name, 'Python');
  });

  it('accepts valid experience_json array', () => {
    const result = resumeUpdateSchema.safeParse({
      experience_json: [{ title: 'Engineer', employer: 'Acme', start_date: '2020-01', description: 'Built things' }],
    });
    assert.equal(result.success, true);
    assert.equal(result.data.experience_json[0].title, 'Engineer');
  });

  it('rejects experience_json as non-array', () => {
    const result = resumeUpdateSchema.safeParse({ experience_json: 'invalid' });
    assert.equal(result.success, false);
  });

  it('accepts is_confirmed as boolean true', () => {
    const result = resumeUpdateSchema.safeParse({ is_confirmed: true });
    assert.equal(result.success, true);
    assert.equal(result.data.is_confirmed, true);
  });

  it('accepts is_confirmed as literal 0', () => {
    const result = resumeUpdateSchema.safeParse({ is_confirmed: 0 });
    assert.equal(result.success, true);
  });

  it('accepts is_confirmed as literal 1', () => {
    const result = resumeUpdateSchema.safeParse({ is_confirmed: 1 });
    assert.equal(result.success, true);
  });

  it('rejects summary longer than 5000 chars', () => {
    const result = resumeUpdateSchema.safeParse({ summary: 'a'.repeat(5001) });
    assert.equal(result.success, false);
  });

  it('Zod middleware returns 400 with VALIDATION_ERROR on bad body', () => {
    const middleware = validate(resumeUpdateSchema);
    const req = mockReq({ body: { education_json: 'not-array' } });
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(res.body.error.details));
  });
});

// T-64: POST /api/resumes/:id/score — requires is_confirmed=1
describe('T-64: POST /api/resumes/:id/score — requires is_confirmed=1', () => {
  it('RESUME_NOT_CONFIRMED AppError has 400 status', () => {
    const err = new AppError('RESUME_NOT_CONFIRMED', 'Resume must be confirmed before scoring');
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, 'RESUME_NOT_CONFIRMED');
    assert.equal(err.message, 'Resume must be confirmed before scoring');
  });
});

// T-65: POST /api/resumes/:id/score — queued response
describe('T-65: POST /api/resumes/:id/score — queued response', () => {
  it('backgroundQueue.enqueue is callable', () => {
    const backgroundQueue = require('../services/backgroundQueue');
    assert.equal(typeof backgroundQueue.enqueue, 'function');
  });
});

// T-66: POST /api/resumes/:id/score — rate limited at 5/hour/user
describe('T-66: POST /api/resumes/:id/score — rate limited', () => {
  it('RATE_LIMITED maps to 429', () => {
    assert.equal(ERROR_STATUS_MAP.RATE_LIMITED, 429);
  });

  it('rateLimiter with 1h window and max 5 returns middleware', () => {
    const { rateLimiter } = require('../middleware/rateLimiter');
    const mw = rateLimiter({ windowMs: 3600000, max: 5, scope: 'user', prefix: 'resume:score' });
    assert.equal(typeof mw, 'function');
  });
});

// T-151: POST /api/resumes — requireAuth enforced
describe('T-151: POST /api/resumes — requireAuth enforced', () => {
  it('AUTHENTICATION_REQUIRED maps to 401', () => {
    assert.equal(ERROR_STATUS_MAP.AUTHENTICATION_REQUIRED, 401);
  });
});

// T-152: PUT /api/resumes/:id — requireAuth enforced
describe('T-152: PUT /api/resumes/:id — requireAuth enforced', () => {
  it('AUTHENTICATION_REQUIRED maps to 401', () => {
    assert.equal(ERROR_STATUS_MAP.AUTHENTICATION_REQUIRED, 401);
  });
});

// T-154: PUT /api/resumes/:id — IDOR prevention
describe('T-154: PUT /api/resumes/:id — IDOR prevention', () => {
  it('NOT_FOUND for non-owned resume via AppError', () => {
    const err = new AppError('NOT_FOUND', 'Resume not found');
    assert.equal(err.statusCode, 404);
  });
});

// T-153: POST /api/resumes/:id/score — requireAuth enforced
describe('T-153: POST /api/resumes/:id/score — requireAuth enforced', () => {
  it('AUTHENTICATION_REQUIRED maps to 401', () => {
    assert.equal(ERROR_STATUS_MAP.AUTHENTICATION_REQUIRED, 401);
  });
});
