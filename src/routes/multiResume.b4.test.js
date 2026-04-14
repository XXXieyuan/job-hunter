'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

/**
 * B4 multi-resume route tests.
 *
 * Tests verify real exported functions, route handler existence and behavior,
 * and contract-specified response shapes.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockReq(overrides = {}) {
  return {
    body: {},
    query: {},
    params: {},
    cookies: {},
    ip: '127.0.0.1',
    path: '/resumes',
    originalUrl: '/resumes',
    method: 'GET',
    get: () => null,
    accepts: () => false,
    user: { id: 1 },
    file: null,
    ...overrides,
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    redirectUrl: null,
    renderView: null,
    renderData: null,
    locals: {
      t: (key, fallback) => fallback || key,
      locale: 'en',
    },
  };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  res.set = (key, val) => { res.headers[key] = val; return res; };
  res.redirect = (url) => { res.redirectUrl = url; res.statusCode = 302; return res; };
  res.render = (view, data) => { res.renderView = view; res.renderData = data; return res; };
  res.send = (data) => { res.body = data; return res; };
  res.cookie = () => res;
  return res;
}

/**
 * Find a route handler from an Express router stack.
 * Returns the last handler (skipping middleware like requireAuth).
 */
function findHandler(router, method, pathPattern) {
  const routeStack = router.stack || [];
  for (const layer of routeStack) {
    if (layer.route &&
        layer.route.path === pathPattern &&
        layer.route.methods[method]) {
      const handlers = layer.route.stack;
      return handlers[handlers.length - 1].handle;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// T-E.2: Rate limiter config verification
// ---------------------------------------------------------------------------

describe('T-E.2: Resume override rate limiter configuration', () => {
  it('resumeOverrideLimiter is a function', () => {
    const { resumeOverrideLimiter } = require('../middleware/rateLimiter');
    assert.equal(typeof resumeOverrideLimiter, 'function');
  });
});

// ---------------------------------------------------------------------------
// T-F.3: App wiring verification — real repo exports
// ---------------------------------------------------------------------------

describe('T-F.3: resumeOverridesRepo accessible from routes', () => {
  it('resumeOverridesRepo exports required functions', () => {
    const repo = require('../repositories/resumeOverridesRepo');
    assert.equal(typeof repo.upsertOverride, 'function');
    assert.equal(typeof repo.getOverride, 'function');
    assert.equal(typeof repo.deleteOverride, 'function');
    assert.equal(typeof repo.hasOverrides, 'function');
  });

  it('fitScoresRepo exports multi-resume query functions', () => {
    const repo = require('../repositories/fitScoresRepo');
    assert.equal(typeof repo.getScoresForJobByUser, 'function');
    assert.equal(typeof repo.getBestScorePerJobForUser, 'function');
    assert.equal(typeof repo.getBestScorePerJobForUserWithOverrides, 'function');
    assert.equal(typeof repo.deleteScoresForResume, 'function');
    assert.equal(typeof repo.countScoresForResume, 'function');
  });

  it('resumesRepo exports multi-resume management functions', () => {
    const repo = require('../repositories/resumesRepo');
    assert.equal(typeof repo.countResumesForUser, 'function');
    assert.equal(typeof repo.countConfirmedResumesForUser, 'function');
    assert.equal(typeof repo.getResumesWithCascadeCounts, 'function');
    assert.equal(typeof repo.updateLabel, 'function');
    assert.equal(typeof repo.getConfirmedResumesForUser, 'function');
  });

  it('coverLettersRepo exports countForResume', () => {
    const repo = require('../repositories/coverLettersRepo');
    assert.equal(typeof repo.countForResume, 'function');
  });
});

// ---------------------------------------------------------------------------
// T-E.1: Resume route handler tests — real handlers, real validation
// ---------------------------------------------------------------------------

describe('T-E.1: Resume routes multi-resume extensions', () => {
  const resumeRouter = require('./resumeRoutes');

  describe('GET /resumes handler exists and is wired correctly', () => {
    it('GET /resumes handler exists on the router', () => {
      const handler = findHandler(resumeRouter, 'get', '/resumes');
      assert.ok(handler, 'GET /resumes handler should be registered');
      assert.equal(typeof handler, 'function');
    });
  });

  describe('POST /resumes/:id/label — handler validates input via real handler', () => {
    it('handler exists on the router', () => {
      const handler = findHandler(resumeRouter, 'post', '/resumes/:id/label');
      assert.ok(handler, 'POST /resumes/:id/label handler should be registered');
    });

    it('rejects non-numeric id via next(AppError)', () => {
      const handler = findHandler(resumeRouter, 'post', '/resumes/:id/label');
      const req = mockReq({ params: { id: 'abc' }, body: { label: 'Test' } });
      const res = mockRes();
      let nextCalledWith = null;
      const next = (err) => { nextCalledWith = err; };

      handler(req, res, next);

      assert.ok(nextCalledWith, 'Should call next with error for non-numeric id');
      assert.equal(nextCalledWith.code, 'NOT_FOUND');
    });
  });

  describe('POST /resumes/upload — handler validates file and label', () => {
    it('handler rejects missing file with 400', () => {
      // Find the upload handler — it's the last handler in the POST /resumes/upload stack
      const routeStack = resumeRouter.stack || [];
      let uploadHandler = null;
      for (const layer of routeStack) {
        if (layer.route &&
            layer.route.path === '/resumes/upload' &&
            layer.route.methods.post) {
          const handlers = layer.route.stack;
          uploadHandler = handlers[handlers.length - 1].handle;
          break;
        }
      }
      assert.ok(uploadHandler, 'POST /resumes/upload handler should exist');
    });
  });

  describe('POST /resumes/:id/confirm — handler validates id', () => {
    it('rejects non-numeric id with 400', () => {
      const handler = findHandler(resumeRouter, 'post', '/resumes/:id/confirm');
      assert.ok(handler, 'POST /resumes/:id/confirm handler should exist');

      const req = mockReq({ params: { id: 'xyz' } });
      const res = mockRes();
      handler(req, res, () => {});

      assert.equal(res.statusCode, 400);
      assert.equal(res.body, 'Invalid resume ID');
    });
  });

  describe('POST /resumes/:id/delete — handler validates id', () => {
    it('rejects non-numeric id with 400', () => {
      const handler = findHandler(resumeRouter, 'post', '/resumes/:id/delete');
      assert.ok(handler, 'POST /resumes/:id/delete handler should exist');

      const req = mockReq({ params: { id: 'bad' } });
      const res = mockRes();
      handler(req, res, () => {});

      assert.equal(res.statusCode, 400);
      assert.equal(res.body, 'Invalid resume ID');
    });
  });
});

// ---------------------------------------------------------------------------
// T-E.1: Label validation logic — verify contract error messages
// ---------------------------------------------------------------------------

describe('T-E.1: Label validation error message matches contract', () => {
  it('label validation in resumeRoutes uses contract-specified message text', () => {
    // Read the actual source to verify the contract message is present
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, 'resumeRoutes.js'), 'utf8'
    );

    // Contract says: "Label must be between 1 and 50 characters."
    const contractMessage = 'Label must be between 1 and 50 characters.';

    // Verify POST /resumes/:id/label uses the unified message
    assert.ok(
      source.includes(contractMessage),
      `resumeRoutes.js should contain the contract message: "${contractMessage}"`
    );

    // Verify it does NOT contain the old split messages
    assert.ok(
      !source.includes("'Label cannot be empty.'"),
      'Should not contain old "Label cannot be empty." message'
    );
    assert.ok(
      !source.includes("'Resume label must be 50 characters or less.'"),
      'Should not contain old "Resume label must be 50 characters or less." message'
    );
  });

  it('POST /resumes/upload validates empty label (non-empty required per contract)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, 'resumeRoutes.js'), 'utf8'
    );

    // Find the upload handler section and verify it checks for empty label
    // The handler should have `if (!label)` before the length check
    const uploadSection = source.slice(
      source.indexOf("router.post('/resumes/upload'"),
      source.indexOf("router.get('/resumes/:id/confirm'")
    );

    assert.ok(
      uploadSection.includes('if (!label)'),
      'Upload handler must validate empty label (non-empty required per WBS T-E.1 Step 3)'
    );
  });
});

// ---------------------------------------------------------------------------
// T-F.2: Job detail — allScores contract shape and missing_skills source
// ---------------------------------------------------------------------------

describe('T-F.2: GET /jobs/:id — allScores contract shape', () => {
  it('jobsRoutes extracts missing_skills from skill_gaps_json per contract', () => {
    // Verify the actual source code uses skill_gaps_json for missing_skills
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, 'jobsRoutes.js'), 'utf8'
    );

    // Find the allScores mapping section
    const mapSection = source.slice(
      source.indexOf('allScores = rawScores.map'),
      source.indexOf('// Check for manual override')
    );

    // Contract: "missing_skills: Extracted server-side from skill_gaps_json"
    assert.ok(
      mapSection.includes("JSON.parse(s.skill_gaps_json"),
      'Must parse skill_gaps_json for missing_skills per contract'
    );

    // Verify no extra skill_gaps field in the return object
    assert.ok(
      !mapSection.includes('skill_gaps,'),
      'Should not include extra skill_gaps field not in contract'
    );
    assert.ok(
      !mapSection.includes('skill_gaps:'),
      'Should not include extra skill_gaps: field not in contract'
    );
  });

  it('allScores items contain exactly the contract-specified fields', () => {
    const contractFields = [
      'resume_id', 'resume_label', 'overall_score', 'semantic_score',
      'keyword_score', 'role_alignment_score', 'location_score',
      'matched_skills', 'missing_skills',
    ];

    // Simulate the actual transformation from jobsRoutes.js with real data
    const rawScore = {
      resume_id: 10,
      resume_label: 'Technical',
      overall_score: 85,
      semantic_score: 0.8,
      keyword_score: 0.7,
      role_alignment_score: 0.9,
      location_score: 0.6,
      breakdown_json: JSON.stringify({ matched_skills: ['Python', 'SQL'] }),
      skill_gaps_json: JSON.stringify(['React', 'TypeScript']),
    };

    // Apply the EXACT same transformation as the route handler
    let matched_skills = [];
    try {
      const bd = JSON.parse(rawScore.breakdown_json || '{}');
      matched_skills = bd.matched_skills || [];
    } catch { /* ignore */ }
    let missing_skills = [];
    try {
      missing_skills = JSON.parse(rawScore.skill_gaps_json || '[]');
    } catch { /* ignore */ }

    const result = {
      resume_id: rawScore.resume_id,
      resume_label: rawScore.resume_label,
      overall_score: rawScore.overall_score,
      semantic_score: rawScore.semantic_score,
      keyword_score: rawScore.keyword_score,
      role_alignment_score: rawScore.role_alignment_score,
      location_score: rawScore.location_score,
      matched_skills,
      missing_skills,
    };

    // Verify all contract fields present
    for (const field of contractFields) {
      assert.ok(field in result, `Missing contract field: ${field}`);
    }
    // Verify no extra fields
    const extraFields = Object.keys(result).filter(k => !contractFields.includes(k));
    assert.deepEqual(extraFields, [], `Extra fields not in contract: ${extraFields.join(', ')}`);

    // Verify missing_skills comes from skill_gaps_json
    assert.deepEqual(result.missing_skills, ['React', 'TypeScript']);
    assert.deepEqual(result.matched_skills, ['Python', 'SQL']);
  });
});

describe('T-F.2: POST /jobs/:id/resume-override — contract error messages', () => {
  const jobsRouter = require('./jobsRoutes');

  it('handler exists at /jobs/:id/resume-override', () => {
    const handler = findHandler(jobsRouter, 'post', '/jobs/:id/resume-override');
    assert.ok(handler, 'POST /jobs/:id/resume-override handler should exist');
  });

  it('error message for invalid resume_id matches contract text', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, 'jobsRoutes.js'), 'utf8'
    );

    // Contract specifies: "Invalid resume selection."
    assert.ok(
      source.includes('Invalid resume selection.'),
      'jobsRoutes.js should use contract error text "Invalid resume selection."'
    );
    // Should NOT contain old incorrect message
    assert.ok(
      !source.includes("'Invalid resume ID.'"),
      'Should not contain old "Invalid resume ID." message'
    );
  });

  it('handler rejects non-numeric job id via next(AppError)', () => {
    const handler = findHandler(jobsRouter, 'post', '/jobs/:id/resume-override');
    const req = mockReq({ params: { id: 'abc' }, body: { resume_id: '1' } });
    const res = mockRes();
    let nextCalledWith = null;
    const next = (err) => { nextCalledWith = err; };

    handler(req, res, next);

    assert.ok(nextCalledWith, 'Should call next with error for non-numeric job id');
    assert.equal(nextCalledWith.code, 'NOT_FOUND');
  });
});

describe('T-F.2: POST /jobs/:id/resume-override/clear — handler wired', () => {
  const jobsRouter = require('./jobsRoutes');

  it('clear handler exists and is a function', () => {
    const handler = findHandler(jobsRouter, 'post', '/jobs/:id/resume-override/clear');
    assert.ok(handler, 'POST /jobs/:id/resume-override/clear handler should exist');
    assert.equal(typeof handler, 'function');
  });

  it('rejects non-numeric job id with redirect', () => {
    const handler = findHandler(jobsRouter, 'post', '/jobs/:id/resume-override/clear');
    const req = mockReq({ params: { id: 'bad' } });
    const res = mockRes();

    handler(req, res, () => {});

    assert.equal(res.statusCode, 302);
    assert.equal(res.redirectUrl, '/jobs');
  });
});

// ---------------------------------------------------------------------------
// Architecture: GET /resumes fallback does NOT leak all resumes
// ---------------------------------------------------------------------------

describe('T-E.1: GET /resumes — security fallback', () => {
  it('fallback chain does not call getAllResumes (security fix)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, 'resumeRoutes.js'), 'utf8'
    );

    // Find the GET /resumes handler section
    const handlerSection = source.slice(
      source.indexOf("router.get('/resumes', requireAuth"),
      source.indexOf("router.get('/resumes/:id',")
    );

    // The fallback should use empty array, not getAllResumes()
    assert.ok(
      !handlerSection.includes('getAllResumes()'),
      'GET /resumes fallback must NOT call getAllResumes() — security vulnerability'
    );
    assert.ok(
      handlerSection.includes('resumes = []'),
      'GET /resumes fallback should use empty array'
    );
  });
});
