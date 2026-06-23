'use strict';

/**
 * Connectivity self-test for the image + video clients (no agents needed).
 *   node selftest.js --crop tomato [--skip-video]
 *
 * - resolves the crop reference (local or GitHub)
 * - PoYo: upload ref → generate ONE scene image (gpt-image-2-edit)
 * - VeoNonStop: submit ONE image-to-video → poll → download   (unless --skip-video)
 *
 * Use this to prove the wiring before running the full pipeline.
 */

const fs = require('fs');
const path = require('path');
const { parseArgs, ensureDir, saveBuffer, stamp, sleep, ensureRefLocal } = require('./lib/util');
const poyo = require('./lib/poyo-image-gpt2');
const vns = require('./lib/veononstop');

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

const TEST_PROMPT =
  'Use the attached character reference image as the STRICT and ONLY source of truth for the character. ' +
  'Keep the character 100% identical. Vertical 9:16, semi-realistic cartoon realism, photorealistic organic textures, ' +
  'realistic detailed garden environment, warm natural sunlight. The character stands friendly in a garden, ' +
  'gentle welcoming gesture, soft smile. No subtitles, no text overlays, no watermark, no character redesign.';

async function main() {
  loadEnv();
  const args = parseArgs(process.argv);
  const crop = args.crop;
  if (!crop) { console.error('Usage: node selftest.js --crop <tomato|strawberry|cucumber|potato> [--skip-video]'); process.exit(1); }

  const cfgPath = path.join(__dirname, 'crops', crop + '.json');
  if (!fs.existsSync(cfgPath)) { console.error('Unknown crop: ' + crop); process.exit(1); }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

  const poyoKey = process.env.POYO_API_KEY;
  const poyoBase = process.env.POYO_BASE || 'https://api.poyo.ai';
  const vnsKey = process.env.VEONONSTOP_API_KEY;
  if (!poyoKey) { console.error('POYO_API_KEY required (.env)'); process.exit(1); }

  const outDir = ensureDir(path.join(__dirname, 'output', '_selftest', crop + '_' + stamp()));

  // --- PoYo image ---
  console.log('[1] resolving reference…');
  const refLocal = await ensureRefLocal(cfg, __dirname);
  console.log('    ref: ' + refLocal);

  console.log('[2] PoYo upload + generate image…');
  const refUrl = await poyo.uploadFile(poyoKey, poyoBase, refLocal);
  console.log('    ref url: ' + refUrl);
  const { buffer } = await poyo.generateImageRetry(poyoKey, poyoBase, TEST_PROMPT, [refUrl], {
    size: process.env.POYO_IMAGE_SIZE || '9:16',
    resolution: process.env.POYO_IMAGE_RESOLUTION || '1K',
    quality: process.env.POYO_IMAGE_QUALITY || 'low',
  }, 3);
  const imgFile = path.join(outDir, 'selftest_scene.jpg');
  saveBuffer(buffer, imgFile);
  console.log('    IMAGE OK -> ' + imgFile);

  if (args['skip-video'] || !vnsKey) {
    if (!vnsKey) console.log('\n[3] VEONONSTOP_API_KEY not set — skipping video test.');
    else console.log('\n[3] --skip-video: image test passed.');
    console.log('\nSELFTEST (image) PASSED');
    return;
  }

  // --- VeoNonStop video ---
  console.log('[3] PoYo upload scene image…');
  const sceneUrl = await poyo.uploadFile(poyoKey, poyoBase, imgFile);
  console.log('    scene url: ' + sceneUrl);

  console.log('[4] VeoNonStop submit image-to-video…');
  const submitted = await vns.submitVideoJob(vnsKey, 'Subtle natural motion, the character speaks gently to the viewer with natural lip movement; soft wind in foliage; no text, no subtitles.', sceneUrl);
  console.log('    task: ' + submitted.taskId);

  let item = Object.assign({ slot: 1, imageUrl: sceneUrl, prompt: 'selftest' }, submitted);
  const failed = ['failed', 'error', 'cancelled', 'failed_after_retries'];
  for (let round = 0; round < 120; round++) {
    [item] = await vns.checkVideoStatuses(vnsKey, [item]);
    console.log(`    round ${round}: status=${item.status}`);
    if (item.status === 'succeeded') break;
    if (failed.includes(String(item.status).toLowerCase())) { console.error('    VIDEO FAILED: ' + (item.error || item.status)); process.exit(1); }
    await sleep(10000);
  }
  if (item.status !== 'succeeded' || !item.videoUrl) { console.error('    VIDEO not ready: ' + item.status); process.exit(1); }

  const vbuf = await vns.downloadVideo(vnsKey, item.videoUrl);
  const vidFile = path.join(outDir, 'selftest_scene.mp4');
  saveBuffer(vbuf, vidFile);
  console.log('    VIDEO OK -> ' + vidFile);
  console.log('\nSELFTEST (image + video) PASSED');
}

main().catch((e) => { console.error('SELFTEST ERROR: ' + e.message); process.exit(1); });
