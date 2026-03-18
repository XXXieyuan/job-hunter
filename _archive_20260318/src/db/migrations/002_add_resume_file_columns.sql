ALTER TABLE resumes ADD COLUMN file_name TEXT;
ALTER TABLE resumes ADD COLUMN file_type TEXT;
ALTER TABLE resumes ADD COLUMN storage_path TEXT;
ALTER TABLE resumes ADD COLUMN is_main INTEGER DEFAULT 0;
ALTER TABLE resumes ADD COLUMN parsed_data TEXT;

