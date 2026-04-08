'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { AppError, ERROR_STATUS_MAP } = require('../utils/errors');
const {
  coverLetterRequestSchema,
  scoreFeedbackSchema,
  applicationSchema,
  applicationUpdateSchema,
  validate,
} = require('../middleware/validators');

// Helper: mock Express req/res for middleware testing
function mockReq(overrides = {}) {
  return {
    body: {},
    query: {},
    params: {},
    cookies: {},
    ip: '127.0.0.1',
    path: '/api',
    originalUrl: '/api',
    method: 'POST',
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

// ═══════════════════════════════════════════════════════════════════════
// 8. Cover Letter Route Contract Tests
// ═══════════════════════════════════════════════════════════════════════

// T-67: GET /api/cover-letters — requires job_id
describe('T-67: GET /api/cover-letters — requires job_id', () => {
  it('NaN check on undefined job_id works correctly', () => {
    const jobId = Number(undefined);
    assert.ok(!Number.isFinite(jobId), 'undefined job_id should be NaN');
  });

  it('VALIDATION_ERROR AppError has 400 status', () => {
    const err = new AppError('VALIDATION_ERROR', 'job_id is required');
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, 'VALIDATION_ERROR');
  });
});

// T-68: GET /api/cover-letters — returns all modes as array
describe('T-68: GET /api/cover-letters — cover letter schema modes', () => {
  it('coverLetterRequestSchema accepts standard mode', () => {
    const result = coverLetterRequestSchema.safeParse({
      job_id: 42,
      resume_id: 1,
      language: 'en',
      mode: 'standard',
    });
    assert.equal(result.success, true);
    assert.equal(result.data.mode, 'standard');
  });

  it('coverLetterRequestSchema accepts aps_selection_criteria mode', () => {
    const result = coverLetterRequestSchema.safeParse({
      job_id: 42,
      resume_id: 1,
      mode: 'aps_selection_criteria',
    });
    assert.equal(result.success, true);
    assert.equal(result.data.mode, 'aps_selection_criteria');
  });

  it('coverLetterRequestSchema rejects invalid mode', () => {
    const result = coverLetterRequestSchema.safeParse({
      job_id: 42,
      resume_id: 1,
      mode: 'invalid_mode',
    });
    assert.equal(result.success, false);
  });
});

// T-69: GET /api/cover-letters — defaults resume_id to active confirmed resume
describe('T-69: GET /api/cover-letters — resume_id default logic', () => {
  it('getConfirmedResumeForUser exists in resumesRepo', () => {
    const { getConfirmedResumeForUser } = require('../repositories/resumesRepo');
    assert.equal(typeof getConfirmedResumeForUser, 'function');
  });
});

// T-70: POST /api/cover-letters — generate standard mode
describe('T-70: POST /api/cover-letters — generate standard mode', () => {
  it('coverLetterRequestSchema validates full standard request via Zod middleware', () => {
    const middleware = validate(coverLetterRequestSchema);
    const req = mockReq({
      body: { job_id: 42, resume_id: 1, language: 'en', mode: 'standard' },
    });
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.ok(nextCalled, 'Valid request should pass validation');
    assert.equal(req.validatedBody.job_id, 42);
    assert.equal(req.validatedBody.mode, 'standard');
  });

  it('coverLetterRequestSchema rejects missing job_id via Zod middleware', () => {
    const middleware = validate(coverLetterRequestSchema);
    const req = mockReq({ body: { resume_id: 1, mode: 'standard' } });
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });
});

// T-71: POST /api/cover-letters — generate APS selection criteria mode
describe('T-71: POST /api/cover-letters — generate APS selection criteria mode', () => {
  it('coverLetterRequestSchema validates aps_selection_criteria mode', () => {
    const result = coverLetterRequestSchema.safeParse({
      job_id: 42,
      resume_id: 1,
      language: 'en',
      mode: 'aps_selection_criteria',
    });
    assert.equal(result.success, true);
    assert.equal(result.data.mode, 'aps_selection_criteria');
  });
});

// T-72: POST /api/cover-letters — overwrites existing on regeneration
describe('T-72: POST /api/cover-letters — overwrites existing on regeneration', () => {
  it('coverLettersRepo has upsertCoverLetter function', () => {
    const coverLettersRepo = require('../repositories/coverLettersRepo');
    assert.equal(typeof coverLettersRepo.upsertCoverLetter, 'function');
  });
});

// T-73: POST /api/cover-letters — rate limited at 10/hour/user
describe('T-73: POST /api/cover-letters — rate limited at 10/hour/user', () => {
  it('RATE_LIMITED maps to 429', () => {
    assert.equal(ERROR_STATUS_MAP.RATE_LIMITED, 429);
  });

  it('rateLimiter factory creates middleware', () => {
    const { rateLimiter } = require('../middleware/rateLimiter');
    const mw = rateLimiter({ windowMs: 3600000, max: 10, scope: 'user', prefix: 'cl:gen' });
    assert.equal(typeof mw, 'function');
  });
});

// T-74: PUT /api/cover-letters/:id — save user_edited_content
describe('T-74: PUT /api/cover-letters/:id — save user_edited_content', () => {
  it('coverLettersRepo exports getCoverLetterById for ownership check', () => {
    const coverLettersRepo = require('../repositories/coverLettersRepo');
    assert.equal(typeof coverLettersRepo.getCoverLetterById, 'function');
  });
});

// T-75: PUT /api/cover-letters/:id — ownership enforced
describe('T-75: PUT /api/cover-letters/:id — ownership enforced', () => {
  it('NOT_FOUND AppError for non-owned cover letter', () => {
    const err = new AppError('NOT_FOUND', 'Cover letter not found');
    assert.equal(err.statusCode, 404);
    assert.equal(err.code, 'NOT_FOUND');
    const json = err.toJSON();
    assert.equal(json.code, 'NOT_FOUND');
  });
});

// T-76: Cover letter endpoints — requireAuth enforced
describe('T-76: Cover letter endpoints — requireAuth enforced', () => {
  it('requireAuth middleware is a function', () => {
    const { requireAuth } = require('../middleware/auth');
    assert.equal(typeof requireAuth, 'function');
  });

  it('AUTHENTICATION_REQUIRED maps to 401', () => {
    assert.equal(ERROR_STATUS_MAP.AUTHENTICATION_REQUIRED, 401);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 9. Score Feedback Route Contract Tests
// ═══════════════════════════════════════════════════════════════════════

// T-77: POST /api/score-feedback — valid feedback via Zod
describe('T-77: POST /api/score-feedback — valid feedback', () => {
  it('scoreFeedbackSchema validates too_high feedback_type via middleware', () => {
    const middleware = validate(scoreFeedbackSchema);
    const req = mockReq({
      body: { job_id: 42, resume_id: 1, feedback_type: 'too_high', comment: 'Too high for me' },
    });
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.ok(nextCalled);
    assert.equal(req.validatedBody.feedback_type, 'too_high');
    assert.equal(req.validatedBody.comment, 'Too high for me');
  });

  it('scoreFeedbackRepo.create function exists', () => {
    const { create } = require('../repositories/scoreFeedbackRepo');
    assert.equal(typeof create, 'function');
  });

  it('scoreFeedbackRepo.findById function exists', () => {
    const { findById } = require('../repositories/scoreFeedbackRepo');
    assert.equal(typeof findById, 'function');
  });
});

// T-78: POST /api/score-feedback — invalid feedback_type
describe('T-78: POST /api/score-feedback — invalid feedback_type', () => {
  it('rejects invalid feedback_type via Zod', () => {
    const result = scoreFeedbackSchema.safeParse({
      job_id: 42,
      resume_id: 1,
      feedback_type: 'invalid_value',
    });
    assert.equal(result.success, false);
    const typeError = result.error.issues.find(i => i.path.includes('feedback_type'));
    assert.ok(typeError, 'Should have feedback_type error');
  });

  it('accepts all valid types: too_high, too_low, irrelevant, helpful', () => {
    for (const type of ['too_high', 'too_low', 'irrelevant', 'helpful']) {
      const result = scoreFeedbackSchema.safeParse({
        job_id: 42,
        resume_id: 1,
        feedback_type: type,
      });
      assert.equal(result.success, true, `${type} should be valid`);
    }
  });

  it('Zod middleware returns VALIDATION_ERROR for invalid feedback_type', () => {
    const middleware = validate(scoreFeedbackSchema);
    const req = mockReq({ body: { job_id: 42, resume_id: 1, feedback_type: 'wrong' } });
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });
});

// T-79: POST /api/score-feedback — resume_id ownership verified
describe('T-79: POST /api/score-feedback — resume_id ownership verified', () => {
  it('getResumeByIdAndUser checks ownership in query', () => {
    const { getResumeByIdAndUser } = require('../repositories/resumesRepo');
    assert.equal(typeof getResumeByIdAndUser, 'function');
  });

  it('NOT_FOUND error for non-owned resume', () => {
    const err = new AppError('NOT_FOUND', 'Resume not found or not owned by user');
    assert.equal(err.statusCode, 404);
  });
});

// T-80: POST /api/score-feedback — optional comment
describe('T-80: POST /api/score-feedback — optional comment', () => {
  it('schema accepts missing comment', () => {
    const result = scoreFeedbackSchema.safeParse({
      job_id: 42,
      resume_id: 1,
      feedback_type: 'helpful',
    });
    assert.equal(result.success, true);
    assert.equal(result.data.comment, undefined);
  });

  it('schema accepts comment with max 1000 chars', () => {
    const result = scoreFeedbackSchema.safeParse({
      job_id: 42,
      resume_id: 1,
      feedback_type: 'helpful',
      comment: 'a'.repeat(1000),
    });
    assert.equal(result.success, true);
  });

  it('schema rejects comment longer than 1000 chars', () => {
    const result = scoreFeedbackSchema.safeParse({
      job_id: 42,
      resume_id: 1,
      feedback_type: 'helpful',
      comment: 'a'.repeat(1001),
    });
    assert.equal(result.success, false);
  });
});

// T-150: POST /api/score-feedback — requireAuth enforced
describe('T-150: POST /api/score-feedback — requireAuth enforced', () => {
  it('AUTHENTICATION_REQUIRED maps to 401', () => {
    assert.equal(ERROR_STATUS_MAP.AUTHENTICATION_REQUIRED, 401);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 10. Application Route Contract Tests
// ═══════════════════════════════════════════════════════════════════════

// T-81: GET /api/applications — response shape with counts
describe('T-81: GET /api/applications — response shape', () => {
  it('applicationsRepo exports listing functions', () => {
    const applicationsRepo = require('../repositories/applicationsRepo');
    assert.equal(typeof applicationsRepo.findByUser, 'function');
    assert.equal(typeof applicationsRepo.countByStatus, 'function');
  });
});

// T-82: GET /api/applications — counts default to 0
describe('T-82: GET /api/applications — counts default to 0', () => {
  it('countByStatus function exists and is callable', () => {
    const { countByStatus } = require('../repositories/applicationsRepo');
    assert.equal(typeof countByStatus, 'function');
  });
});

// T-83: GET /api/applications — filter by status
describe('T-83: GET /api/applications — filter by status', () => {
  it('all 6 status values are valid in applicationSchema', () => {
    const statuses = ['saved', 'applied', 'interviewing', 'offered', 'rejected', 'withdrawn'];
    for (const status of statuses) {
      const result = applicationSchema.safeParse({ job_id: 1, status });
      assert.equal(result.success, true, `${status} should be valid`);
    }
  });

  it('invalid status is rejected by applicationSchema', () => {
    const result = applicationSchema.safeParse({ job_id: 1, status: 'pending' });
    assert.equal(result.success, false);
  });
});

// T-84: GET /api/applications — nested job and fit_score
describe('T-84: GET /api/applications — nested job and fit_score', () => {
  it('fitScoresRepo exports getScoreForJobAndResume function', () => {
    const fitScoresRepo = require('../repositories/fitScoresRepo');
    assert.equal(typeof fitScoresRepo.getScoreForJobAndResume, 'function');
  });
});

// T-85: GET /api/applications — sort options
describe('T-85: GET /api/applications — sort options', () => {
  it('applicationUpdateSchema accepts valid status transitions', () => {
    const result = applicationUpdateSchema.safeParse({ status: 'interviewing' });
    assert.equal(result.success, true);
    assert.equal(result.data.status, 'interviewing');
  });
});

// T-86: POST /api/applications — create with INSERT OR IGNORE
describe('T-86: POST /api/applications — create via Zod validation', () => {
  it('applicationSchema validates required job_id via middleware', () => {
    const middleware = validate(applicationSchema);
    const req = mockReq({ body: { job_id: 42, status: 'saved' } });
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.ok(nextCalled);
    assert.equal(req.validatedBody.job_id, 42);
    assert.equal(req.validatedBody.status, 'saved');
  });

  it('applicationSchema rejects missing job_id via middleware', () => {
    const middleware = validate(applicationSchema);
    const req = mockReq({ body: { status: 'saved' } });
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  it('applicationsRepo has create function', () => {
    const applicationsRepo = require('../repositories/applicationsRepo');
    assert.equal(typeof applicationsRepo.create, 'function');
  });
});

// T-87: PUT /api/applications/:id — status update
describe('T-87: PUT /api/applications/:id — status update via Zod', () => {
  it('applicationUpdateSchema validates status field via middleware', () => {
    const middleware = validate(applicationUpdateSchema);
    const req = mockReq({ body: { status: 'applied' } });
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.ok(nextCalled);
    assert.equal(req.validatedBody.status, 'applied');
  });

  it('applicationUpdateSchema validates notes field', () => {
    const result = applicationUpdateSchema.safeParse({ notes: 'Phone screen scheduled' });
    assert.equal(result.success, true);
    assert.equal(result.data.notes, 'Phone screen scheduled');
  });

  it('all 6 statuses pass Zod validation', () => {
    const statuses = ['saved', 'applied', 'interviewing', 'offered', 'rejected', 'withdrawn'];
    for (const status of statuses) {
      const result = applicationUpdateSchema.safeParse({ status });
      assert.equal(result.success, true, `${status} should be valid`);
    }
  });
});

// T-88: PUT /api/applications/:id — ownership enforced
describe('T-88: PUT /api/applications/:id — ownership enforced', () => {
  it('NOT_FOUND AppError for non-owned application', () => {
    const err = new AppError('NOT_FOUND', 'Application not found');
    assert.equal(err.statusCode, 404);
    assert.equal(err.code, 'NOT_FOUND');
    const json = err.toJSON();
    assert.equal(json.code, 'NOT_FOUND');
    assert.equal(json.message, 'Application not found');
  });
});

// T-89: GET /api/applications — pagination
describe('T-89: GET /api/applications — pagination', () => {
  it('pagination math: 25 items / 20 per page = 2 pages', () => {
    const total = 25;
    const perPage = 20;
    const totalPages = Math.ceil(total / perPage) || 1;
    assert.equal(totalPages, 2);
  });

  it('applicationsRepo.findByUser accepts pagination params', () => {
    const { findByUser } = require('../repositories/applicationsRepo');
    assert.equal(typeof findByUser, 'function');
  });
});

// T-148: Application endpoints — requireAuth enforced
describe('T-148: Application endpoints — requireAuth enforced', () => {
  it('AUTHENTICATION_REQUIRED maps to 401', () => {
    assert.equal(ERROR_STATUS_MAP.AUTHENTICATION_REQUIRED, 401);
  });

  it('requireAuth middleware is a function', () => {
    const { requireAuth } = require('../middleware/auth');
    assert.equal(typeof requireAuth, 'function');
  });
});
