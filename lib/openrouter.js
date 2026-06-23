'use strict';

/**
 * OpenRouter API client — chat completions via Node built-in https.
 * Auth: key passed in from process.env.OPENROUTER_API_KEY by the caller.
 * Ported from veo-scripts, unchanged API surface.
 */

const https = require('https');

const BASE_PATH = '/api/v1/chat/completions';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Single chat completion. Returns assistant text.
 */
async function chatCompletion(apiKey, model, systemMsg, userMsg, opts) {
  opts = opts || {};
  const messages = [];
  if (systemMsg) messages.push({ role: 'system', content: systemMsg });
  if (userMsg !== undefined && userMsg !== null) {
    messages.push({ role: 'user', content: String(userMsg) });
  }

  const payloadObj = { model, messages };
  if (opts.temperature !== undefined) payloadObj.temperature = opts.temperature;
  if (opts.response_format) payloadObj.response_format = opts.response_format;

  const payload = JSON.stringify(payloadObj);
  const payloadBuf = Buffer.from(payload, 'utf8');

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'openrouter.ai',
        path: BASE_PATH,
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'Content-Length': payloadBuf.length,
          'HTTP-Referer': 'https://github.com/trumpa703-design/cartoon-plants',
          'X-Title': 'CartoonPlants',
        },
        timeout: 180000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch (_) {
            return reject(new Error('Non-JSON from OpenRouter: ' + text.slice(0, 500)));
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const errMsg =
              (json.error && (json.error.message || json.error)) ||
              json.message ||
              text.slice(0, 500);
            return reject(new Error('OpenRouter error (' + res.statusCode + '): ' + errMsg));
          }
          const content =
            json.choices &&
            json.choices[0] &&
            json.choices[0].message &&
            json.choices[0].message.content;
          if (content === undefined || content === null) {
            return reject(new Error('OpenRouter no content: ' + JSON.stringify(json).slice(0, 500)));
          }
          resolve(content);
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('OpenRouter request timeout')));
    req.write(payloadBuf);
    req.end();
  });
}

/**
 * Chat completion that returns parsed JSON (strips markdown fences).
 */
async function chatCompletionJson(apiKey, model, systemMsg, userMsg, opts) {
  const raw = await chatCompletion(apiKey, model, systemMsg, userMsg, opts);
  const cleaned = String(raw || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('OpenRouter response is not JSON: ' + cleaned.slice(0, 500));
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function withRetry(fn, maxRetries, label) {
  maxRetries = maxRetries || 3;
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        console.error(`[openrouter] ${label} attempt ${attempt}/${maxRetries} failed: ${error.message}`);
        await sleep(2000 * attempt);
      }
    }
  }
  throw new Error(`${label} failed after ${maxRetries} attempts: ${(lastError && lastError.message) || lastError}`);
}

async function chatJsonRetry(apiKey, model, systemMsg, userMsg, opts, maxRetries) {
  return withRetry(() => chatCompletionJson(apiKey, model, systemMsg, userMsg, opts), maxRetries || 3, 'chatJson');
}

module.exports = {
  chatCompletion,
  chatCompletionJson,
  chatJsonRetry,
  withRetry,
};
