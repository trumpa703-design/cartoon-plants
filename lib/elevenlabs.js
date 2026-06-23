'use strict';

/**
 * ElevenLabs TTS client with character-level timestamps (gives us voice + subtitle
 * timing in one call — no separate Whisper server needed).
 *
 *   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps
 * Auth via xi-api-key header (from process.env.ELEVENLABS_API_KEY by the caller).
 *
 * Returns { audio: Buffer, mimeType, words: [{text, start, end}] }
 * (words reconstructed from character alignment).
 */

const https = require('https');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Synthesize speech with timestamps.
 * @param {string} apiKey
 * @param {string} voiceId
 * @param {string} text
 * @param {object} [opts]  { modelId, stability, similarityBoost, style }
 */
function ttsWithTimestamps(apiKey, voiceId, text, opts) {
  opts = opts || {};
  const modelId = opts.modelId || 'eleven_multilingual_v2';
  const payload = JSON.stringify({
    text: String(text || ''),
    model_id: modelId,
    voice_settings: {
      stability: opts.stability !== undefined ? opts.stability : 0.5,
      similarity_boost: opts.similarityBoost !== undefined ? opts.similarityBoost : 0.8,
      style: opts.style !== undefined ? opts.style : 0.0,
      use_speaker_boost: true,
    },
  });
  const payloadBuf = Buffer.from(payload, 'utf8');
  const path = '/v1/text-to-speech/' + encodeURIComponent(voiceId) + '/with-timestamps';

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.elevenlabs.io',
        path,
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': payloadBuf.length,
        },
        timeout: 180000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error('ElevenLabs TTS ' + res.statusCode + ': ' + buf.toString('utf8').slice(0, 300)));
          }
          let json;
          try {
            json = JSON.parse(buf.toString('utf8'));
          } catch (e) {
            return reject(new Error('ElevenLabs non-JSON response'));
          }
          const audio = Buffer.from(json.audio_base64 || '', 'base64');
          if (!audio.length) return reject(new Error('ElevenLabs returned empty audio'));
          const words = alignmentToWords(json.alignment || {});
          resolve({ audio, mimeType: 'audio/mpeg', words });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('ElevenLabs TTS timeout')));
    req.write(payloadBuf);
    req.end();
  });
}

/**
 * Convert ElevenLabs character-level alignment into word-level entries.
 * characters: ["П","р","и","в","е","т"," ","м","и","р"]
 * character_start_times_seconds / character_end_times_seconds: number[]
 */
function alignmentToWords(alignment) {
  const chars = alignment.characters || [];
  const starts = alignment.character_start_times_seconds || [];
  const ends = alignment.character_end_times_seconds || [];
  const words = [];
  let cur = null;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const s = Number(starts[i] || 0);
    const e = Number(ends[i] || s);
    if (/\s/.test(ch)) {
      if (cur) { words.push(cur); cur = null; }
      continue;
    }
    if (!cur) {
      cur = { text: ch, start: s, end: e };
    } else {
      cur.text += ch;
      cur.end = e;
    }
  }
  if (cur) words.push(cur);
  return words;
}

async function ttsWithTimestampsRetry(apiKey, voiceId, text, opts, maxRetries) {
  maxRetries = maxRetries || 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await ttsWithTimestamps(apiKey, voiceId, text, opts);
    } catch (e) {
      lastErr = e;
      console.error('[elevenlabs] attempt ' + attempt + '/' + maxRetries + ' failed: ' + e.message);
      if (attempt < maxRetries) await sleep(4000 * attempt);
    }
  }
  throw lastErr;
}

module.exports = { ttsWithTimestamps, ttsWithTimestampsRetry, alignmentToWords };
