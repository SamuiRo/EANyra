/**
 * src/platforms/linkedin/csvParser.js
 *
 * Pure CSV parsing functions for LinkedIn data exports.
 * No side effects — each function takes a file path and returns
 * plain objects. All LinkedIn-specific field names and quirks
 * are handled here so nothing else in the codebase needs to know
 * about the raw export format.
 *
 * LinkedIn export format notes:
 *   - Encoding: UTF-8
 *   - Date format: "YYYY-MM-DD HH:mm:ss" (UTC)
 *   - Multi-line text fields are quoted with double-quote escaping
 *   - ShareCommentary contains the full post text including newlines
 *   - Visibility values seen in practice: MEMBER_NETWORK (= public to connections)
 *   - ShareLink format: https://www.linkedin.com/feed/update/urn%3Ali%3A...
 *
 * Supported export files (obtained via linkedin.com/mypreferences/d/data-export):
 *   Shares.csv   — published posts
 *   Profile.csv  — account profile (single data row)
 */

import fs   from 'fs';
import path from 'path';

// ─── CSV tokeniser ────────────────────────────────────────────────────────────

/**
 * Parse a CSV string into an array of row objects.
 * Handles:
 *   - Quoted fields (may contain commas and newlines)
 *   - Doubled-quote escaping ("" → ")
 *   - Windows (CRLF) and Unix (LF) line endings
 *
 * Node's built-in has no CSV parser — we keep this dependency-free
 * rather than adding a package for two small files.
 *
 * @param {string} raw
 * @returns {Record<string, string>[]}
 */
export function parseCsvString(raw) {
  // Normalise line endings
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const rows    = [];
  let   headers = null;
  let   pos     = 0;

  while (pos < text.length) {
    const { fields, nextPos } = parseRow(text, pos);
    pos = nextPos;

    if (fields === null) break; // trailing newline / empty tail

    if (!headers) {
      headers = fields;
      continue;
    }

    const row = {};
    headers.forEach((h, i) => { row[h] = fields[i] ?? ''; });
    rows.push(row);
  }

  return rows;
}

/**
 * Parse one CSV row starting at `pos`. Returns the parsed fields
 * and the position after the row terminator.
 *
 * @param {string} text
 * @param {number} pos
 * @returns {{ fields: string[]|null, nextPos: number }}
 */
function parseRow(text, pos) {
  if (pos >= text.length) return { fields: null, nextPos: pos };

  const fields = [];
  let   field  = '';

  while (pos < text.length) {
    const ch = text[pos];

    if (ch === '"') {
      // Quoted field
      pos++; // skip opening quote
      while (pos < text.length) {
        if (text[pos] === '"') {
          if (text[pos + 1] === '"') {
            // Escaped quote
            field += '"';
            pos += 2;
          } else {
            pos++; // skip closing quote
            break;
          }
        } else {
          field += text[pos++];
        }
      }
    } else if (ch === ',') {
      fields.push(field);
      field = '';
      pos++;
    } else if (ch === '\n') {
      pos++;
      break;
    } else {
      field += ch;
      pos++;
    }
  }

  fields.push(field);

  // Skip a completely empty row (e.g. trailing newline at EOF)
  if (fields.length === 1 && fields[0] === '') {
    return { fields: null, nextPos: pos };
  }

  return { fields, nextPos: pos };
}

// ─── File readers ─────────────────────────────────────────────────────────────

/**
 * Read and parse a LinkedIn Shares.csv export.
 *
 * @param {string} filePath  Absolute path to Shares.csv
 * @returns {ParsedShare[]}
 */
export function parseSharesFile(filePath) {
  const raw  = fs.readFileSync(filePath, 'utf-8');
  const rows = parseCsvString(raw);

  return rows.map(r => ({
    date:        r['Date']             ? new Date(r['Date'])    : null,
    shareLink:   r['ShareLink']?.trim()   || null,
    text:        r['ShareCommentary']?.trim() || '',
    sharedUrl:   r['SharedUrl']?.trim()   || null,
    mediaUrl:    r['MediaUrl']?.trim()    || null,
    visibility:  r['Visibility']?.trim()  || null,
  }));
}

/**
 * Read and parse a LinkedIn Profile.csv export.
 * Profile.csv always has exactly one data row.
 *
 * @param {string} filePath  Absolute path to Profile.csv
 * @returns {ParsedProfile|null}
 */
export function parseProfileFile(filePath) {
  const raw  = fs.readFileSync(filePath, 'utf-8');
  const rows = parseCsvString(raw);
  if (!rows.length) return null;

  const r = rows[0];

  // Websites field format: "[LABEL:url][LABEL:url]..."
  const websites = parseWebsites(r['Websites'] ?? '');

  return {
    firstName:   r['First Name']?.trim()   || '',
    lastName:    r['Last Name']?.trim()    || '',
    headline:    r['Headline']?.trim()     || '',
    summary:     r['Summary']?.trim()      || '',
    industry:    r['Industry']?.trim()     || '',
    geoLocation: r['Geo Location']?.trim() || '',
    websites,
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Parse LinkedIn's "[LABEL:url][LABEL:url]" websites string.
 * Returns an array of { label, url } objects.
 *
 * @param {string} raw  e.g. "[PORTFOLIO:https://example.com]"
 * @returns {{ label: string, url: string }[]}
 */
function parseWebsites(raw) {
  const results = [];
  const pattern = /\[([^\]:]+):([^\]]+)\]/g;
  let   m;
  while ((m = pattern.exec(raw)) !== null) {
    results.push({ label: m[1].trim(), url: m[2].trim() });
  }
  return results;
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ParsedShare
 * @property {Date|null}   date
 * @property {string|null} shareLink   Direct URL to the post on LinkedIn
 * @property {string}      text        Full post commentary
 * @property {string|null} sharedUrl   External URL shared in the post (if any)
 * @property {string|null} mediaUrl    Attached media URL (if any)
 * @property {string|null} visibility  e.g. "MEMBER_NETWORK"
 */

/**
 * @typedef {Object} ParsedProfile
 * @property {string}                          firstName
 * @property {string}                          lastName
 * @property {string}                          headline
 * @property {string}                          summary
 * @property {string}                          industry
 * @property {string}                          geoLocation
 * @property {{ label: string, url: string }[]} websites
 */