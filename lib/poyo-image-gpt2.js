'use strict';

/**
 * PoYo AI image client — GPT Image 2 / GPT Image 2 edit.
 * Auth via process.env.POYO_API_KEY (passed in by caller).
 *
 * Flow:
 *   1. (optional) uploadFile()  — upload a LOCAL reference image → public URL
 *   2. submitTask(prompt, imageUrls)  → task_id
 *      gpt-image-2       (text-to-image, no refs)
 *      gpt-image-2-edit  (with reference images)
 *   3. pollTask(taskId)  → { buffer, mimeType }
 *
 * Ported from veo-scripts; hardcoded key replaced with caller-supplied apiKey.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DEFAULT_SIZE = '9:16';
const DEFAULT_RESOLUTION = '1K';
const DEFAULT_QUALITY = 'low';
const POLL_INTERVAL_MS = 8000;
const MAX_POLLS = 90; // 90 × 8s = 12 min

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = lib.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
          return;
        }
        resolve(raw);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    if (options.timeout) req.setTimeout(options.timeout);
    if (body) req.write(body);
    req.end();
  });
}

function downloadBuffer(url, redirectCount) {
  if (redirectCount === undefined) redirectCount = 0;
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
      },
      (res) => {
        const status = res.statusCode || 0;
        const loc = res.headers && res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && loc && redirectCount < 10) {
          res.resume();
          resolve(downloadBuffer(new URL(loc, url).toString(), redirectCount + 1));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            buffer: Buffer.concat(chunks),
            mimeType: String((res.headers['content-type'] || 'image/jpeg')).split(';')[0].trim(),
          });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Upload a LOCAL image file to PoYo storage → returns a public file_url.
 * Uses multipart/form-data endpoint: POST /api/common/upload/stream
 * Required because gpt-image-2-edit needs image_urls (public URLs).
 */
async function uploadFile(apiKey, base, filePath) {
  const boundary = '----CP' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  const fileName = path.basename(filePath);
  const fileBuf = fs.readFileSync(filePath);
  const mime = fileName.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

  const pre = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`
  );
  const post = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="file_name"\r\n\r\n${fileName}\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([pre, fileBuf, post]);

  const raw = await httpRequest(base + '/api/common/upload/stream', {
    method: 'POST',
    timeout: 120000,
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': body.length,
    },
  }, body);

  let json;
  try { json = JSON.parse(raw); } catch (_) { throw new Error('upload bad JSON: ' + raw.slice(0, 300)); }
  if (!json.success || !json.data || !json.data.file_url) {
    throw new Error('upload failed: ' + raw.slice(0, 300));
  }
  return json.data.file_url;
}

/**
 * Submit image generation. Uses edit model when reference URLs are provided.
 */
async function submitTask(apiKey, base, prompt, imageUrls, opts) {
  opts = opts || {};
  const input = {
    prompt,
    size: opts.size || DEFAULT_SIZE,
    resolution: opts.resolution || DEFAULT_RESOLUTION,
    quality: opts.quality || DEFAULT_QUALITY,
  };

  let model;
  if (imageUrls && imageUrls.length > 0) {
    model = 'gpt-image-2-edit';
    input.image_urls = imageUrls;
  } else {
    model = 'gpt-image-2';
  }

  const bodyStr = JSON.stringify({ model, input });
  const raw = await httpRequest(base + '/api/generate/submit', {
    method: 'POST',
    timeout: 120000,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
      'Content-Length': Buffer.byteLength(bodyStr),
    },
  }, bodyStr);

  let json;
  try { json = JSON.parse(raw); } catch (_) { throw new Error('submit bad JSON: ' + raw.slice(0, 300)); }
  if (json.code !== 200 || !json.data || !json.data.task_id) {
    throw new Error('submit failed: ' + JSON.stringify(json).slice(0, 300));
  }
  return json.data.task_id;
}

/**
 * Poll until finished/failed. Returns { buffer, mimeType }.
 */
async function pollTask(apiKey, base, taskId) {
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const raw = await httpRequest(base + '/api/generate/status/' + encodeURIComponent(taskId), {
      method: 'GET',
      timeout: 60000,
      headers: { Authorization: 'Bearer ' + apiKey },
    });
    let json;
    try { json = JSON.parse(raw); } catch (_) { throw new Error('status bad JSON: ' + raw.slice(0, 200)); }
    if (json.code !== 200 || !json.data) throw new Error('status error: ' + JSON.stringify(json).slice(0, 200));

    const data = json.data;
    const status = String(data.status || '').toLowerCase();

    if (status === 'finished') {
      const files = data.files || [];
      const img = files.find((f) => f.file_type === 'image') || files[0];
      if (!img || !img.file_url) throw new Error('No file_url in finished task');
      return await downloadBuffer(img.file_url);
    }
    if (status === 'failed') {
      throw new Error(`PoYo task ${taskId} failed: ${data.error_message || 'unknown'}`);
    }
  }
  throw new Error(`PoYo task ${taskId} timed out after ${(MAX_POLLS * POLL_INTERVAL_MS) / 1000}s`);
}

/**
 * Generate one image. Returns { buffer, mimeType }.
 */
async function generateImage(apiKey, base, prompt, imageUrls, opts) {
  const taskId = await submitTask(apiKey, base, prompt, imageUrls || [], opts);
  return pollTask(apiKey, base, taskId);
}

/**
 * Generate with retry.
 */
async function generateImageRetry(apiKey, base, prompt, imageUrls, opts, maxRetries) {
  maxRetries = maxRetries || 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await generateImage(apiKey, base, prompt, imageUrls, opts);
    } catch (e) {
      lastErr = e;
      console.error(`[poyo-image] attempt ${attempt}/${maxRetries} failed: ${e.message}`);
      if (attempt < maxRetries) await sleep(5000 * attempt);
    }
  }
  throw lastErr;
}

module.exports = {
  uploadFile,
  submitTask,
  pollTask,
  generateImage,
  generateImageRetry,
  downloadBuffer,
};
