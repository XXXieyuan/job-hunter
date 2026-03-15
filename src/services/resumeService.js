const fs = require('fs');
const path = require('path');
const {
  getResumeCount,
  insertResume,
  getAllResumes,
  getResumeById,
} = require('../repositories/resumesRepo');

async function ensureSampleResumeSeeded() {
  const count = getResumeCount();
  if (count > 0) return;

  const filePath = path.join(__dirname, '..', '..', 'data', 'sample-resume.json');
  const raw = fs.readFileSync(filePath, 'utf8');
  const json = JSON.parse(raw);

  const resume = {
    name: json.name,
    summary: json.summary,
    skills_json: JSON.stringify(json.skills || []),
    experience_json: JSON.stringify(json.experience || []),
    education_json: JSON.stringify(json.education || []),
    raw_json: JSON.stringify(json),
  };

  insertResume(resume);
}

function getPrimaryResume() {
  const resumes = getAllResumes();
  return resumes[0] || null;
}

module.exports = {
  ensureSampleResumeSeeded,
  getPrimaryResume,
  getResumeById,
  getAllResumes,
};

