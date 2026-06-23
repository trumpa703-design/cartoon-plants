'use strict';

/**
 * VeoNonStop API client — ported from veo-scripts (unchanged API surface).
 * Auth: apiKey passed in from process.env.VEONONSTOP_API_KEY by the caller.
 *
 * Endpoints:
 *   POST /image/banana/generate   — image gen (optional reference_images as base64)
 *   POST /video/image-to-video    — submit image-to-video job
 *   GET  /video/status/{taskId}   — poll video job status
 */

const http = require('http');
const https = require('https');

const DEFAULT_BASE = 'https://veononstop.org/api/v1';
const MAX_IMAGE_ATTEMPTS = 3;
const MAX_SLOT_WAIT_ATTEMPTS = 60;
const MAX_SUBMIT_ATTEMPTS = 3;
const MAX_VIDEO_RESUBMIT_ATTEMPTS = 12;
const SLOT_FULL_RESUBMIT_DELAY_MS = 45000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDriveUrl(url) {
  const text = String(url || '').trim();
  const fileMatch = text.match(/\/file\/d\/([^/]+)/);
  const idMatch = text.match(/[?&]id=([^&]+)/);
  const id = (fileMatch && fileMatch[1]) || (idMatch && idMatch[1]);
  return id ? 'https://drive.google.com/uc?export=download&id=' + id : text;
}

function requestBuffer(url, options, redirectCount) {
  if (redirectCount === undefined) redirectCount = 0;
  if (!options) options = {};

  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      return reject(new Error('Invalid URL: ' + url));
    }

    const lib = target.protocol === 'http:' ? http : https;
    const body = options.body ? Buffer.from(options.body) : null;
    const headers = Object.assign({}, options.headers || {});
    if (body && !headers['Content-Length'] && !headers['content-length']) {
      headers['Content-Length'] = body.length;
    }

    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: options.method || 'GET',
        headers,
        timeout: options.timeout || 600000,
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = res.headers && res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location && redirectCount < 10) {
          res.resume();
          const nextMethod = status === 303 ? 'GET' : (options.method || 'GET');
          const nextBody = status === 303 ? undefined : options.body;
          const nextUrl = new URL(location, target).toString();
          resolve(
            requestBuffer(
              nextUrl,
              Object.assign({}, options, { method: nextMethod, body: nextBody }),
              redirectCount + 1
            )
          );
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ statusCode: status, headers: res.headers, body: Buffer.concat(chunks) })
        );
        res.on('error', reject);
      }
    );

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout: ' + url)));
    if (body) req.write(body);
    req.end();
  });
}

async function requestJson(url, options, apiKey) {
  const opts = Object.assign({}, options || {});
  if (apiKey) {
    opts.headers = Object.assign({ 'X-API-Key': apiKey }, opts.headers || {});
  }
  const response = await requestBuffer(url, opts);
  const text = response.body.toString('utf8');
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error('Non-JSON response from ' + url + ': ' + text.slice(0, 500));
  }
  if (response.statusCode < 200 || response.statusCode >= 300 || json.success === false) {
    throw new Error(json.error || json.message || text.slice(0, 500));
  }
  return json;
}

function isSlotFullError(error) {
  const msg = String((error && error.message) || error || '').toLowerCase();
  return msg.includes('all cookie slots full') || msg.includes('cookie slots full');
}

async function downloadBuffer(url) {
  let downloadUrl = normalizeDriveUrl(url);
  if (!downloadUrl) throw new Error('Missing URL for download');

  if (downloadUrl.includes('drive.google.com/uc') && !downloadUrl.includes('confirm=')) {
    downloadUrl = downloadUrl.replace('?export=download', '?export=download&confirm=t');
  }

  const response = await requestBuffer(downloadUrl);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error('Cannot download ' + downloadUrl + ': HTTP ' + response.statusCode);
  }
  const contentType = String((response.headers && response.headers['content-type']) || 'image/jpeg');
  const mimeType = contentType.split(';')[0].trim();
  if (mimeType.includes('text/html')) {
    throw new Error('URL returned HTML instead of media: ' + downloadUrl);
  }

  const buf = response.body;
  if (buf.length < 12) {
    throw new Error('Downloaded file too small (' + buf.length + ' bytes): ' + downloadUrl);
  }
  const isPNG = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isJPEG = buf[0] === 0xff && buf[1] === 0xd8;
  const isWEBP = buf.slice(0, 12).indexOf(Buffer.from('WEBP')) !== -1;
  const isVideo = buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
  if (!isPNG && !isJPEG && !isWEBP && !isVideo) {
    throw new Error('Downloaded data not valid media. First bytes: ' + buf.slice(0, 64).toString('hex'));
  }
  return { buffer: buf, mimeType };
}

/**
 * Generate a single scene image with optional reference images.
 * refs = [{ name, url }]
 */
async function generateSceneImage(apiKey, prompt, refs) {
  const refCache = new Map();
  async function getRef(url) {
    const key = normalizeDriveUrl(url);
    if (!refCache.has(key)) {
      refCache.set(
        key,
        downloadBuffer(key).then(({ buffer, mimeType }) => ({
          image_base64: buffer.toString('base64'),
          mime_type: mimeType,
        }))
      );
    }
    return refCache.get(key);
  }

  let lastError;
  let slotWaits = 0;

  for (let attempt = 1; attempt <= MAX_IMAGE_ATTEMPTS; attempt++) {
    try {
      const referenceImages =
        refs && refs.length > 0
          ? await Promise.all(
              refs.map(async (ref) => {
                const data = await getRef(ref.url);
                return { name: ref.name, image_base64: data.image_base64, mime_type: data.mime_type };
              })
            )
          : [];

      const body = {
        prompt: String(prompt || ''),
        aspect_ratio: '9:16',
        num_images: 1,
        model_key: 'GEM_PIX_2',
      };
      if (referenceImages.length > 0) {
        body.reference_images = referenceImages;
        body.use_all_ref_images = true;
      }

      const json = await requestJson(
        DEFAULT_BASE + '/image/banana/generate',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        apiKey
      );
      const media = json.data && json.data.media && json.data.media[0];
      if (!media || !media.fifeUrl) throw new Error('Image response has no media URL');
      return {
        imageUrl: media.fifeUrl,
        projectId: json.data.project_id,
        mediaGenerationId: media.mediaGenerationId,
        width: media.width,
        height: media.height,
        modelName: media.modelName,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      if (isSlotFullError(error) && slotWaits < MAX_SLOT_WAIT_ATTEMPTS) {
        slotWaits++;
        attempt--;
        await sleep(10000);
        continue;
      }
      if (attempt < MAX_IMAGE_ATTEMPTS) await sleep(4000 * attempt);
    }
  }
  throw new Error('Scene image failed after ' + MAX_IMAGE_ATTEMPTS + ' attempts: ' + ((lastError && lastError.message) || lastError));
}

/**
 * Submit a single image-to-video job.
 */
async function submitVideoJob(apiKey, prompt, imageUrl) {
  let lastError;
  let slotWaits = 0;

  for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt++) {
    try {
      const { buffer, mimeType } = await downloadBuffer(imageUrl);
      const json = await requestJson(
        DEFAULT_BASE + '/video/image-to-video',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: String(prompt || ''),
            image_base64: buffer.toString('base64'),
            mime_type: mimeType,
            aspect_ratio: '9:16',
            count: 1,
          }),
        },
        apiKey
      );
      const data = json.data || {};
      if (String(data.status || '').toLowerCase() === 'failed') {
        throw new Error(data.error || data.message || 'Video task failed during submit');
      }
      if (!data.task_id) throw new Error('Video response has no task_id');
      return { taskId: data.task_id, status: data.status || 'submitted', stage: data.type || 'image_to_video', attempt };
    } catch (error) {
      lastError = error;
      if (isSlotFullError(error) && slotWaits < 30) {
        slotWaits++;
        attempt--;
        await sleep(10000);
        continue;
      }
      if (attempt < MAX_SUBMIT_ATTEMPTS) await sleep(3000 * attempt);
    }
  }
  throw new Error('Video submit failed after ' + MAX_SUBMIT_ATTEMPTS + ' attempts: ' + ((lastError && lastError.message) || lastError));
}

/**
 * Submit N video jobs in parallel. scenes = [{ slot, prompt, imageUrl }, ...]
 */
async function submitVideoJobs(apiKey, scenes) {
  async function submitOne(scene) {
    const result = await submitVideoJob(apiKey, scene.prompt, scene.imageUrl);
    return Object.assign({ slot: scene.slot, prompt: scene.prompt, imageUrl: scene.imageUrl }, result);
  }
  const results = await Promise.all(scenes.map(submitOne));
  results.sort((a, b) => a.slot - b.slot);
  return results;
}

/**
 * Check status of all video jobs once.
 */
async function checkVideoStatuses(apiKey, items) {
  async function resubmitOne(item, reason) {
    const nextAttempt = Number(item.videoAttempt || 1) + 1;
    if (nextAttempt > MAX_VIDEO_RESUBMIT_ATTEMPTS) {
      return Object.assign({}, item, { status: 'failed_after_retries', error: reason, videoAttempt: Number(item.videoAttempt || 1) });
    }
    await sleep(SLOT_FULL_RESUBMIT_DELAY_MS);
    try {
      const { buffer, mimeType } = await downloadBuffer(item.imageUrl);
      const json = await requestJson(
        DEFAULT_BASE + '/video/image-to-video',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: String(item.prompt || ''),
            image_base64: buffer.toString('base64'),
            mime_type: mimeType,
            aspect_ratio: '9:16',
            count: 1,
          }),
        },
        apiKey
      );
      const data = json.data || {};
      if (!data.task_id) throw new Error('Resubmit response has no task_id');
      return Object.assign({}, item, {
        previousTaskId: item.taskId,
        taskId: data.task_id,
        videoAttempt: nextAttempt,
        status: data.status || 'submitted',
        error: null,
        lastRetryReason: reason,
      });
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (isSlotFullError(msg)) {
        return Object.assign({}, item, { status: 'queued', error: null, lastRetryReason: msg, videoAttempt: nextAttempt });
      }
      return Object.assign({}, item, { status: 'error', error: msg });
    }
  }

  async function checkOne(item) {
    if (item.status === 'succeeded') return item;
    try {
      const json = await requestJson(DEFAULT_BASE + '/video/status/' + item.taskId, {}, apiKey);
      const data = json.data || {};
      const status = data.status || 'unknown';

      if (status === 'completed') {
        const video = (data.videos && data.videos[0]) || {};
        return Object.assign({}, item, {
          status: 'succeeded',
          videoUrl: video.fifeUrl || video.servingBaseUri || null,
          mediaGenerationId: video.mediaGenerationId || null,
          completedAt: data.completed_at || null,
          progress: data.progress || null,
          error: null,
        });
      }
      if (status === 'failed') {
        const reason = data.error || data.message || 'Video task failed';
        if (isSlotFullError(reason)) return resubmitOne(item, reason);
        return Object.assign({}, item, { status: 'failed', error: reason });
      }
      return Object.assign({}, item, { status, progress: data.progress || null, error: null });
    } catch (error) {
      const msg = (error && error.message) || String(error);
      if (isSlotFullError(msg)) return resubmitOne(item, msg);
      return Object.assign({}, item, { status: 'error', error: msg });
    }
  }

  const checked = await Promise.all(items.map(checkOne));
  checked.sort((a, b) => a.slot - b.slot);
  const failedStatuses = ['failed', 'error', 'cancelled', 'failed_after_retries'];
  const hasFailed = checked.some((item) => failedStatuses.includes(String(item.status || '').toLowerCase()));
  const allReady = checked.length === items.length && checked.every((item) => item.status === 'succeeded');
  return checked.map((item) => Object.assign({}, item, { hasFailed, allReady }));
}

async function downloadVideo(apiKey, videoUrl) {
  const response = await requestBuffer(videoUrl, { timeout: 600000 });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error('Failed to download video: HTTP ' + response.statusCode + ' from ' + videoUrl);
  }
  const ct = String(response.headers['content-type'] || '');
  if (ct.includes('text/html')) {
    throw new Error('Video URL returned HTML: ' + response.body.slice(0, 200).toString('utf8'));
  }
  return response.body;
}

async function downloadUrl(url) {
  const result = await downloadBuffer(url);
  return result.buffer;
}

module.exports = {
  normalizeDriveUrl,
  downloadUrl,
  downloadBuffer,
  generateSceneImage,
  submitVideoJob,
  submitVideoJobs,
  checkVideoStatuses,
  downloadVideo,
  sleep,
};
