-- ============================================================
-- Data migration for 004_rebuild.sql
-- Migrates existing rows to work with the new schema
-- ============================================================

-- 1. Create default admin user for existing data
--    Password hash is a placeholder; real hash set at app startup from ADMIN_TOKEN
INSERT OR IGNORE INTO users (email, password_hash, display_name, role)
VALUES ('admin@localhost', '$2b$10$placeholder.admin.hash.needs.reset.at.startup', 'Admin', 'admin');

-- 2. Point existing resumes to the admin user
UPDATE resumes SET user_id = (SELECT id FROM users WHERE email = 'admin@localhost')
WHERE user_id IS NULL;

-- 3. Point existing cover_letters to the admin user
UPDATE cover_letters SET user_id = (SELECT id FROM users WHERE email = 'admin@localhost')
WHERE user_id IS NULL;

-- 4. Set default values for new jobs columns
UPDATE jobs SET is_active = 1 WHERE is_active IS NULL;
UPDATE jobs SET updated_at = created_at WHERE updated_at IS NULL;

-- 5. Set default values for new analysis_runs columns
UPDATE analysis_runs SET type = 'full' WHERE type IS NULL OR type = '';

-- 6. Rebuild FTS index from existing jobs data
INSERT INTO jobs_fts(jobs_fts) VALUES('rebuild');
