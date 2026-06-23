'use strict';

/**
 * One-time Google OAuth2 token setup for optional Drive upload.
 * Credentials are read from .env (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET),
 * never hardcoded. Tokens are saved to GOOGLE_TOKENS_PATH (default tokens.json).
 *
 *   node setup-google.js
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function loadEnv() {
  if (!fs.existsSync('.env')) return;
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

async function main() {
  loadEnv();
  let google;
  try { google = require('googleapis').google; } catch (_) {
    console.error('googleapis not installed. Run: npm install');
    process.exit(1);
  }

  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');
    process.exit(1);
  }

  const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob';
  const TOKENS_PATH = process.env.GOOGLE_TOKENS_PATH || 'tokens.json';

  const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive'],
    prompt: 'consent',
  });

  console.log('\n=== Google OAuth2 Setup ===\n1. Open:\n' + authUrl);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise((res) => rl.question('\n2. Paste the auth code:\n> ', (a) => { rl.close(); res(a.trim()); }));
  if (!code) { console.error('No code.'); process.exit(1); }

  const { tokens } = await oauth2.getToken(code);
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), 'utf8');
  console.log('\nTokens saved to: ' + TOKENS_PATH);
}

main().catch((e) => { console.error('Setup failed: ' + e.message); process.exit(1); });
