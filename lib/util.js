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

const https = require('https');
const http = require('http');

/**
 * Download a URL to a local file (follows redirects). Returns dest path.
 */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch (e) { return reject(new Error('Invalid URL: ' + url)); }
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: 'GET',
      },
      (res) => {
        const status = res.statusCode || 0;
        const loc = res.headers && res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && loc) {
          res.resume();
          downloadFile(new URL(loc, url).toString(), dest).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) { reject(new Error('HTTP ' + status + ' for ' + url)); return; }
        ensureDir(path.dirname(dest));
        const ws = fs.createWriteStream(dest);
        res.pipe(ws);
        ws.on('finish', () => ws.close(() => resolve(dest)));
        ws.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Resolve a crop reference to a LOCAL file path.
 * If the local file exists, use it. Otherwise download from the crop's
 * reference_url (Google Drive) so refs live in Drive, not in the repo.
 */
async function ensureRefLocal(cfg, repoRoot) {
  const local = path.join(repoRoot || process.cwd(), cfg.reference);
  if (fs.existsSync(local)) return local;

  const url = cfg.reference_url;
  if (!url) throw new Error('No local reference and no reference_url in crop config');
  console.log('[ref] local missing, downloading from Drive: ' + url);
  await downloadFile(url, local);
  return local;
}

module.exports = { sleep, parseArgs, extractJson, ensureDir, saveBuffer, stamp, downloadFile, ensureRefLocal };
