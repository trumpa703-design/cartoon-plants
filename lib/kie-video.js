'use strict';

/**
 * kie.ai Veo video client (veo3_lite, image-to-video).
 * Ported from veo-scripts/ogorod_video_kie.js; key from caller (env).
 *
 *   POST /api/v1/veo/generate   { prompt, imageUrls, model, aspect_ratio, resolution, duration } → data.taskId
 *   GET  /api/v1/veo/record-info?taskId=   → data.response.resultUrls / data.resultUrls (data.successFlag 2|3 = fail)
 */

const https = require('https');
const http = require('http');

const KIE_BASE = 'https://api.kie.ai';
const NETERR = /ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EPIPE|socket hang up|EAI_AGAIN|socket timeout/i;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function once(url, o, b) {
  return new Promise((res, rej) => {
    const p = new URL(url);
    const lib = p.protocol === 'https:' ? https : http;
    const r = lib.request(
      { hostname: p.hostname, port: p.port || 443, path: p.pathname + p.search, method: o.method || 'GET', headers: o.headers || {}, timeout: 180000 },
      (x) => {
        const c = [];
        x.on('data', (d) => c.push(d));
        x.on('end', () => { const t = Buffer.concat(c).toString('utf8'); if (x.statusCode >= 400) return rej(new Error('HTTP ' + x.statusCode + ': ' + t.slice(0, 300))); res(t); });
      }
    );
    r.on('error', rej);
    r.on('timeout', () => r.destroy(new Error('socket timeout')));
    if (b) r.write(b);
    r.end();
  });
}

async function req(url, o, b) {
  let e;
  for (let a = 0; a < 6; a++) {
    try { return await once(url, o, b); }
    catch (x) { e = x; const m = String(x.message || ''); if (!(NETERR.test(m) || m.includes('HTTP 5'))) throw x; await sleep(2500 * (a + 1)); }
  }
  throw e;
}

function dlOnce(url) {
  return new Promise((res, rej) => {
    const p = new URL(url);
    const lib = p.protocol === 'https:' ? https : http;
    const r = lib.request(
      { hostname: p.hostname, port: p.port || 443, path: p.pathname + p.search, method: 'GET', timeout: 300000 },
      (x) => {
        if ([301, 302, 307, 308].includes(x.statusCode)) { const loc = x.headers.location; if (!loc) return rej(new Error('redir without location')); return res(dlOnce(loc)); }
        const c = []; x.on('data', (d) => c.push(d)); x.on('end', () => res(Buffer.concat(c)));
      }
    );
    r.on('error', rej);
    r.on('timeout', () => r.destroy(new Error('socket timeout')));
    r.end();
  });
}

async function dl(url) {
  let e;
  for (let a = 0; a < 6; a++) {
    try { return await dlOnce(url); }
    catch (x) { e = x; if (!NETERR.test(x.message)) throw x; await sleep(3000); }
  }
  throw e;
}

function hAuth(apiKey) { return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey }; }

function submit(apiKey, prompt, imageUrls, opts) {
  opts = opts || {};
  const body = JSON.stringify({
    prompt,
    imageUrls: imageUrls || [],
    model: opts.model || 'veo3_lite',
    aspect_ratio: opts.aspect_ratio || '9:16',
    resolution: opts.resolution || '720p',
    duration: opts.duration || 8,
  });
  const h = hAuth(apiKey);
  h['Content-Length'] = Buffer.byteLength(body);
  return req(KIE_BASE + '/api/v1/veo/generate', { method: 'POST', headers: h }, body).then((raw) => {
    const j = JSON.parse(raw);
    if (j.code !== 200 || !j.data || !j.data.taskId) throw new Error('kie veo generate: ' + JSON.stringify(j).slice(0, 300));
    return j.data.taskId;
  });
}

function pickUrls(d) {
  let u = null;
  if (d.response && d.response.resultUrls) u = d.response.resultUrls;
  else if (d.resultUrls) u = d.resultUrls;
  if (typeof u === 'string') { try { u = JSON.parse(u); } catch (_) { u = [u]; } }
  return u;
}

async function poll(apiKey, taskId) {
  for (let i = 0; i < 120; i++) {
    await sleep(10000);
    let raw;
    try { raw = await req(KIE_BASE + '/api/v1/veo/record-info?taskId=' + encodeURIComponent(taskId), { headers: hAuth(apiKey) }); }
    catch (_) { continue; }
    let j;
    try { j = JSON.parse(raw); } catch (_) { continue; }
    if (j.code !== 200 || !j.data) continue;
    const d = j.data;
    const urls = pickUrls(d);
    if (urls && urls.length) return urls[0];
    if (d.successFlag === 2 || d.successFlag === 3 || ['fail', 'failed', 'error'].includes(String(d.state || '').toLowerCase())) {
      throw new Error('kie veo failed: ' + (d.errorMessage || d.failMsg || 'flag=' + d.successFlag));
    }
  }
  throw new Error('kie veo timeout');
}

async function generateVideo(apiKey, prompt, imageUrls, opts) {
  const id = await submit(apiKey, prompt, imageUrls, opts);
  const url = await poll(apiKey, id);
  return { taskId: id, videoUrl: url };
}

async function generateVideoRetry(apiKey, prompt, imageUrls, opts, tries) {
  tries = tries || 3;
  let e;
  for (let a = 1; a <= tries; a++) {
    try { return await generateVideo(apiKey, prompt, imageUrls, opts); }
    catch (x) { e = x; console.error('[kie-video] attempt ' + a + '/' + tries + ': ' + x.message); if (a < tries) await sleep(8000); }
  }
  throw e;
}

async function downloadVideo(url) { return dl(url); }

module.exports = { submit, poll, generateVideo, generateVideoRetry, downloadVideo };
