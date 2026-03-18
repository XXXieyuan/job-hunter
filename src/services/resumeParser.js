'use strict';

const fs = require('fs/promises');
const path = require('path');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const { log } = require('../utils/logger');

const SECTION_PATTERN = /(skills?|technical skills?|core competencies|experience|employment|work history|education|qualifications?)/i;

function normalizeText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/\u2022/g, '\n- ')
    .replace(/\t/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \f\v]+/g, ' ')
    .trim();
}

function splitLines(text) {
  return normalizeText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function extractName(lines, rawText) {
  const firstLine = lines.find((line) => line && !SECTION_PATTERN.test(line));
  if (firstLine && firstLine.length <= 80 && !/@/.test(firstLine)) {
    return firstLine.replace(/[^a-zA-Z .'-]/g, '').trim() || 'Unknown Candidate';
  }

  const emailMatch = rawText.match(/([a-zA-Z0-9._%+-]+)@/);
  if (emailMatch) {
    return emailMatch[1]
      .split(/[._-]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  return 'Unknown Candidate';
}

function extractSection(lines, sectionNames) {
  const lowered = sectionNames.map((name) => name.toLowerCase());
  const startIndex = lines.findIndex((line) => lowered.includes(line.toLowerCase().replace(/:$/, '')));

  if (startIndex === -1) {
    return [];
  }

  const collected = [];

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (SECTION_PATTERN.test(line) && collected.length > 0) {
      break;
    }
    collected.push(line);
  }

  return collected;
}

function uniqueNormalized(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function extractSkills(lines, rawText) {
  const sectionLines = extractSection(lines, ['skills', 'skill', 'technical skills', 'core competencies']);
  const fromSection = sectionLines
    .flatMap((line) => line.split(/[|,;/]/))
    .map((item) => item.replace(/^[-•*]\s*/, '').trim());

  const skillPattern = /\b(JavaScript|TypeScript|Node\.js|Node|Python|SQL|SQLite|PostgreSQL|AWS|Azure|GCP|Docker|Kubernetes|TensorFlow|PyTorch|Machine Learning|Deep Learning|NLP|React|Vue|Angular|Express|Java|C\+\+|C#|R|Pandas|NumPy|Scikit-learn|OpenAI|Prompt Engineering)\b/gi;
  const fromKeywords = [];
  let match;

  while ((match = skillPattern.exec(rawText)) !== null) {
    fromKeywords.push(match[1]);
  }

  return uniqueNormalized([...fromSection, ...fromKeywords]);
}

function extractExperience(lines) {
  const sectionLines = extractSection(lines, ['experience', 'employment', 'work history']);
  const fallback = lines.filter((line) => /\b(engineer|scientist|developer|analyst|manager|consultant|intern)\b/i.test(line));

  return uniqueNormalized((sectionLines.length ? sectionLines : fallback).slice(0, 8));
}

function extractEducation(lines) {
  const sectionLines = extractSection(lines, ['education', 'qualifications']);
  const fallback = lines.filter((line) => /\b(bachelor|master|phd|degree|university|college|tafe)\b/i.test(line));

  return uniqueNormalized((sectionLines.length ? sectionLines : fallback).slice(0, 6));
}

function buildParsedResume(rawText) {
  const normalizedText = normalizeText(rawText);
  const lines = splitLines(normalizedText);

  return {
    name: extractName(lines, normalizedText),
    skills: extractSkills(lines, normalizedText),
    experience: extractExperience(lines),
    education: extractEducation(lines),
    rawText: normalizedText
  };
}

async function parseDocx(filePath) {
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    return buildParsedResume(result.value);
  } catch (error) {
    log('warn', 'RESUME_PARSE_DOCX_ERROR', error.message);
    return { error: true, message: error.message };
  }
}

async function parsePdf(filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    const result = await pdfParse(buffer);
    return buildParsedResume(result.text);
  } catch (error) {
    log('warn', 'RESUME_PARSE_PDF_ERROR', error.message);
    return { error: true, message: error.message };
  }
}

async function parseResume(filePath, fileType) {
  const normalizedType = String(fileType || path.extname(filePath).replace('.', '')).toLowerCase();

  if (normalizedType === 'docx') {
    return parseDocx(filePath);
  }

  if (normalizedType === 'pdf') {
    return parsePdf(filePath);
  }

  return { error: true, message: `Unsupported file type: ${normalizedType}` };
}

module.exports = {
  parseDocx,
  parsePdf,
  parseResume
};

Object.assign(globalThis, { parseDocx, parsePdf, parseResume });
