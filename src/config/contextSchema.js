/**
 * Schemas for the author context YAML (voice, bio, platforms, projects and
 * the matching persona overrides). See docs/CONTEXT_GUIDE.md.
 *
 * Errors name the exact field and block only the file they occur in, so the
 * previously synced version stays in use. Warnings (unknown keys, cadence the
 * content plan cannot read) never block.
 */

import { parseFrequency } from '../shared/frequency.js';

export class ContextValidationError extends Error {
  constructor(errors) {
    super(errors.join('; '));
    this.errors = errors;
  }
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;
const PROJECT_STATUSES = ['active', 'paused', 'archived'];

/** Known misspellings → the field that is actually read. */
const ALIASES = {
  frequency: 'posting_frequency', post_frequency: 'posting_frequency', cadence: 'posting_frequency',
  max_chars: 'max_length', length: 'max_length', lang: 'language',
  examples: 'example_post', example: 'example_post', example_posts: 'example_post',
  dont: 'dislikes', avoid: 'dislikes', rules: 'posting_rules', angles: 'content_angles', stack: 'tech_stack',
};

const VOICE = {
  tone: 'string', likes: 'strings', dislikes: 'strings', example_post: 'string', taboo: 'strings',
};
const BIO_ENTRY = { short: 'string', full: 'string?' };
const PLATFORM_RULES = {
  max_length: 'positiveInt', language: 'language', style: 'string', formats: 'strings', avoid: 'strings',
  posting_frequency: 'frequency',
};
const PROJECT = {
  slug: 'slug', name: 'string', status: 'status', archive: 'boolean', description: 'string?',
  tech_stack: 'strings', links: 'links', content_angles: 'strings', posting_rules: 'strings',
};

class Report {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }

  throwIfErrors() {
    if (this.errors.length) throw new ContextValidationError(this.errors);
  }
}

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate one value against a type name; push a message on mismatch. */
function check(type, value, where, report) {
  if (value === undefined) return;
  switch (type) {
    case 'string':
      if (typeof value !== 'string') report.errors.push(`${where} must be text`);
      return;
    case 'string?':
      if (value !== null && typeof value !== 'string') report.errors.push(`${where} must be text or null`);
      return;
    case 'strings':
      if (!Array.isArray(value)) report.errors.push(`${where} must be a list (one "- item" per line)`);
      else value.forEach((item, i) => { if (typeof item !== 'string') report.errors.push(`${where}[${i}] must be text`); });
      return;
    case 'boolean':
      if (typeof value !== 'boolean') report.errors.push(`${where} must be true or false`);
      return;
    case 'positiveInt':
      if (!Number.isInteger(value) || value <= 0) report.errors.push(`${where} must be a positive whole number`);
      return;
    case 'language':
      if (typeof value !== 'string' || !LANGUAGE.test(value)) {
        report.errors.push(`${where} must be a language code such as "uk" or "en"`);
      }
      return;
    case 'frequency':
      if (typeof value !== 'string') report.errors.push(`${where} must be text such as "3 posts per week"`);
      else if (value.trim() && !parseFrequency(value)) {
        report.warnings.push(`${where} "${value}" is not understood by the content plan; use e.g. "daily", "3 posts per week" or "щодня"`);
      }
      return;
    case 'slug':
      if (typeof value !== 'string' || !SLUG.test(value)) report.errors.push(`${where} must be lowercase kebab-case`);
      return;
    case 'status':
      if (!PROJECT_STATUSES.includes(value)) report.errors.push(`${where} must be one of ${PROJECT_STATUSES.join(', ')}`);
      return;
    case 'links':
      if (!isMapping(value)) {
        report.errors.push(`${where} must be a mapping of name: URL`);
        return;
      }
      for (const [key, url] of Object.entries(value)) {
        if (url === null || url === '') continue;
        if (typeof url !== 'string' || !isHttpUrl(url)) report.errors.push(`${where}.${key} must be an http(s) URL or null`);
      }
      return;
    default:
      throw new Error(`Unknown schema type ${type}`);
  }
}

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function checkFields(schema, data, where, report) {
  for (const [key, value] of Object.entries(data)) {
    if (schema[key]) {
      check(schema[key], value, `${where}${key}`, report);
    } else {
      const hint = ALIASES[key] && schema[ALIASES[key]] ? ` (did you mean "${ALIASES[key]}"?)` : '';
      report.warnings.push(`${where}${key} is not a known field and is ignored by EANyra${hint}`);
    }
  }
}

function asMapping(data, label, report) {
  if (data === null || data === undefined) return {};
  if (!isMapping(data)) {
    report.errors.push(`${label} must be a YAML mapping (key: value lines)`);
    return null;
  }
  return data;
}

// ── Public validators ─────────────────────────────────────────────────────────

/** @returns {{ value: object, warnings: string[] }} throws ContextValidationError */
export function validateVoice(data, label = 'voice') {
  const report = new Report();
  const value = asMapping(data, label, report);
  if (value) checkFields(VOICE, value, label === 'voice' ? '' : `${label}.`, report);
  report.throwIfErrors();
  return { value: value ?? {}, warnings: report.warnings };
}

export function validateBio(data, label = 'bio') {
  const report = new Report();
  const value = asMapping(data, label, report);
  for (const [platform, entry] of Object.entries(value ?? {})) {
    const where = `${label === 'bio' ? '' : `${label}.`}${platform}`;
    if (typeof entry === 'string') continue;   // shorthand: platform: "short bio"
    if (!isMapping(entry)) report.errors.push(`${where} must be text or a mapping with short/full`);
    else checkFields(BIO_ENTRY, entry, `${where}.`, report);
  }
  report.throwIfErrors();
  return { value: value ?? {}, warnings: report.warnings };
}

export function validatePlatforms(data, label = 'platforms') {
  const report = new Report();
  const value = asMapping(data, label, report);
  for (const [platform, rules] of Object.entries(value ?? {})) {
    const where = `${label === 'platforms' ? '' : `${label}.`}${platform}`;
    if (!isMapping(rules)) report.errors.push(`${where} must be a mapping of rules`);
    else checkFields(PLATFORM_RULES, rules, `${where}.`, report);
  }
  report.throwIfErrors();
  return { value: value ?? {}, warnings: report.warnings };
}

/** @param {string} fileSlug filename without .yaml */
export function validateProject(data, fileSlug) {
  const report = new Report();
  const value = asMapping(data, 'project', report);
  if (value) {
    checkFields(PROJECT, value, '', report);
    const slug = value.slug ?? fileSlug;
    if (typeof slug === 'string' && slug !== fileSlug) {
      report.errors.push(`slug "${slug}" must match the filename "${fileSlug}.yaml"`);
    }
    if (!SLUG.test(fileSlug)) report.errors.push(`the filename "${fileSlug}.yaml" must be lowercase kebab-case`);
    if (Array.isArray(value.content_angles) && value.content_angles.length === 0) {
      report.warnings.push('content_angles is empty; the agent has no hooks for this project');
    }
  }
  report.throwIfErrors();
  return { value: value ?? {}, warnings: report.warnings };
}
