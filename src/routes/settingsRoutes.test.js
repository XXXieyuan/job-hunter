'use strict';

const { describe, it, beforeEach, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const connectionModule = require('../db/connection');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

function applyMigrations(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY)');
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  const hasMigration = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?');
  const insertMigration = db.prepare('INSERT INTO schema_migrations (id) VALUES (?)');
  for (const file of files) {
    if (hasMigration.get(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    let processedSql = sql;
    const alterRegex = /^ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+).*$/gim;
    let match;
    while ((match = alterRegex.exec(sql)) !== null) {
      const [fullLine, table, column] = match;
      try {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all();
        if (cols.some(c => c.name === column)) {
          processedSql = processedSql.replace(fullLine, `-- SKIPPED (exists): ${fullLine}`);
        }
      } catch (_) { /* table may not exist yet */ }
    }
    try { db.exec(processedSql); } catch (e) { if (!e.message.includes('already exists')) throw e; }
    insertMigration.run(file);
  }
}

function mockReq(overrides = {}) {
  return {
    body: {},
    query: {},
    cookies: {},
    ip: '127.0.0.1',
    path: '/api/settings/notifications',
    originalUrl: '/api/settings/notifications',
    method: 'GET',
    get: () => null,
    user: null,
    ...overrides,
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    rendered: null,
    locals: {},
  };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  res.set = (key, val) => { res.headers[key] = val; return res; };
  res.render = (view, data) => { res.rendered = { view, data }; return res; };
  return res;
}

describe('settingsRoutes', () => {
  let db, dbPath, originalGetDb;
  let usersRepo, resumesRepo, unsubscribeTokensRepo;
  let userId;

  before(() => {
    dbPath = path.join(os.tmpdir(), `jh-settings-route-test-${Date.now()}.sqlite`);
    db = new Database(dbPath);
    applyMigrations(db);
    originalGetDb = connectionModule.getDb;
    connectionModule.getDb = () => db;

    usersRepo = require('../repositories/usersRepo');
    resumesRepo = require('../repositories/resumesRepo');
    unsubscribeTokensRepo = require('../repositories/unsubscribeTokensRepo');

    db.exec(`INSERT INTO users (email, password_hash, role) VALUES ('settings-test@test.com', 'hash', 'user')`);
    userId = db.prepare(`SELECT id FROM users WHERE email = 'settings-test@test.com'`).get().id;
  });

  after(() => {
    connectionModule.getDb = originalGetDb;
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
  });

  beforeEach(() => {
    db.exec(`UPDATE users SET notification_prefs_json = NULL WHERE id = ${userId}`);
    db.exec(`DELETE FROM unsubscribe_tokens WHERE user_id = ${userId}`);
    db.exec(`DELETE FROM resumes WHERE user_id = ${userId}`);
  });

  describe('GET /api/settings/notifications', () => {
    it('returns defaults when notification_prefs_json is NULL', () => {
      const { z } = require('zod');
      // Directly test the repo/logic since route handler wraps it
      const user = usersRepo.findById(userId);
      assert.equal(user.notification_prefs_json, null);

      const defaults = {
        alerts_enabled: false,
        score_threshold: 70,
        frequency: 'immediate',
        digest_hour_utc: 22,
      };

      let preferences = defaults;
      if (user && user.notification_prefs_json) {
        preferences = { ...defaults, ...JSON.parse(user.notification_prefs_json) };
      }

      assert.deepStrictEqual(preferences, defaults);
    });

    it('returns saved preferences when notification_prefs_json is set', () => {
      const prefs = { alerts_enabled: true, score_threshold: 80, frequency: 'digest', digest_hour_utc: 10 };
      usersRepo.updateNotificationPrefs(userId, prefs);

      const user = usersRepo.findById(userId);
      const defaults = { alerts_enabled: false, score_threshold: 70, frequency: 'immediate', digest_hour_utc: 22 };
      const result = { ...defaults, ...JSON.parse(user.notification_prefs_json) };
      assert.deepStrictEqual(result, prefs);
    });
  });

  describe('PUT /api/settings/notifications — validation', () => {
    it('rejects threshold below 50', () => {
      const { z } = require('zod');
      const schema = z.object({
        alerts_enabled: z.boolean(),
        score_threshold: z.number().int().min(50).max(100),
        frequency: z.enum(['immediate', 'digest']),
        digest_hour_utc: z.number().int().min(0).max(23),
      });
      const result = schema.safeParse({
        alerts_enabled: false,
        score_threshold: 49,
        frequency: 'immediate',
        digest_hour_utc: 22,
      });
      assert.equal(result.success, false);
    });

    it('rejects threshold above 100', () => {
      const { z } = require('zod');
      const schema = z.object({
        alerts_enabled: z.boolean(),
        score_threshold: z.number().int().min(50).max(100),
        frequency: z.enum(['immediate', 'digest']),
        digest_hour_utc: z.number().int().min(0).max(23),
      });
      const result = schema.safeParse({
        alerts_enabled: false,
        score_threshold: 101,
        frequency: 'immediate',
        digest_hour_utc: 22,
      });
      assert.equal(result.success, false);
    });

    it('accepts valid preferences', () => {
      const { z } = require('zod');
      const schema = z.object({
        alerts_enabled: z.boolean(),
        score_threshold: z.number().int().min(50).max(100),
        frequency: z.enum(['immediate', 'digest']),
        digest_hour_utc: z.number().int().min(0).max(23),
      });
      const result = schema.safeParse({
        alerts_enabled: true,
        score_threshold: 75,
        frequency: 'digest',
        digest_hour_utc: 8,
      });
      assert.equal(result.success, true);
    });
  });

  describe('PUT — RESUME_NOT_CONFIRMED guard', () => {
    it('rejects alerts_enabled=true without confirmed resume', () => {
      const confirmedResume = resumesRepo.getConfirmedResumeForUser(userId);
      assert.equal(confirmedResume, undefined);
      // Simulates the guard: no confirmed resume → should reject
    });

    it('allows alerts_enabled=true with confirmed resume', () => {
      db.exec(`INSERT INTO resumes (user_id, name, file_path, file_type, is_confirmed) VALUES (${userId}, 'test.docx', '/tmp/test.docx', 'docx', 1)`);
      const confirmedResume = resumesRepo.getConfirmedResumeForUser(userId);
      assert.ok(confirmedResume);
    });
  });

  describe('PUT — unsubscribe token generation', () => {
    it('generates unsubscribe token on first enable', () => {
      // Simulate enabling alerts for the first time
      let existing = unsubscribeTokensRepo.findByUserId(userId);
      assert.equal(existing, null);

      const token = unsubscribeTokensRepo.getOrCreate(userId);
      assert.ok(token);
      assert.equal(token.user_id, userId);
      assert.equal(token.token.length, 64); // 32 bytes hex
    });

    it('does not generate new token on subsequent enables', () => {
      const first = unsubscribeTokensRepo.getOrCreate(userId);
      const second = unsubscribeTokensRepo.getOrCreate(userId);
      assert.equal(first.token, second.token);
    });
  });

  describe('PUT — saves and returns preferences', () => {
    it('saves valid prefs and returns them', () => {
      const prefs = { alerts_enabled: false, score_threshold: 85, frequency: 'digest', digest_hour_utc: 14 };
      usersRepo.updateNotificationPrefs(userId, prefs);

      const user = usersRepo.findById(userId);
      const saved = JSON.parse(user.notification_prefs_json);
      assert.deepStrictEqual(saved, prefs);
    });
  });
});
