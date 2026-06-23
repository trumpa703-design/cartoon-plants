'use strict';

/**
 * Google Drive uploader (optional delivery step).
 * Auth: OAuth tokens.json (see setup-google.js) OR a service account JSON.
 * Mirrors veo-scripts' google.js pattern but env-driven and optional.
 *
 * If no credentials are configured, functions no-op and return null.
 */

const fs = require('fs');
const path = require('path');

function loadAuth() {
  let google;
  try {
    google = require('googleapis').google;
  } catch (_) {
    return null; // googleapis not installed — skip
  }

  const tokensPath = process.env.GOOGLE_TOKENS_PATH || 'tokens.json';
  if (fs.existsSync(tokensPath)) {
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
    const oAuth2 = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob'
    );
    oAuth2.setCredentials(tokens);
    return { drive: google.drive({ version: 'v3', auth: oAuth2 }), mode: 'oauth' };
  }

  const sa = process.env.GOOGLE_SERVICE_ACCOUNT_PATH;
  if (sa && fs.existsSync(sa)) {
    const auth = new google.auth.GoogleAuth({ keyFile: sa, scopes: ['https://www.googleapis.com/auth/drive'] });
    return { drive: google.drive({ version: 'v3', auth }), mode: 'service' };
  }

  return null;
}

/**
 * Upload a local file to Google Drive. Returns the webViewLink or null.
 */
async function uploadFile(localPath, name) {
  const ctx = loadAuth();
  if (!ctx) {
    console.log('[google] no credentials configured — skipping Drive upload');
    return null;
  }
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || undefined;
  const res = await ctx.drive.files.create({
    requestBody: { name: name || path.basename(localPath), parents: folderId ? [folderId] : undefined },
    media: { body: fs.createReadStream(localPath) },
    fields: 'id, webViewLink',
  });
  const fileId = res.data && res.data.id;
  if (fileId && folderId) {
    try {
      await ctx.drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });
    } catch (_) {}
  }
  return (res.data && (res.data.webViewLink || (fileId ? `https://drive.google.com/file/d/${fileId}/view` : null))) || null;
}

module.exports = { uploadFile, loadAuth };
