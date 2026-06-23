'use strict';

/**
 * Shared helpers. No external dependencies.
 */

const fs = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Parse CLI args: node run.js --crop tomato --scenes 5
 * Returns { crop: 'tomato', scenes: 5, ... }
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

/**
 * Robustly extract a JSON object from an LLM response string.
 * Handles markdown fences and surrounding prose.
 */
function extractJson(value) {
  if (value && typeof value === 'object') return value;
  const text = String(value || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('No JSON object found in response: ' + text.slice(0, 200));
  }
  return JSON.parse(text.slice(start, end + 1));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveBuffer(buf, filePath) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, buf);
  return filePath;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

module.exports = { sleep, parseArgs, extractJson, ensureDir, saveBuffer, stamp };
