'use strict';

/**
 * cartoon-plants — main orchestrator.
 *
 *   node run.js --crop tomato [--only agents|images|videos|stitch|all]
 *
 * Pipeline:
 *   agents  → OpenRouter: brainstorm→select→script→FACTCHECK→imagePrompts→videoPrompts
 *   images  → PoYo gpt-image-2-edit (reference image = canonical character)
 *   videos  → VeoNonStop image-to-video (scene image uploaded to PoYo first)
 *   stitch  → ffmpeg combine into one 1080x1920 30fps MP4
 *
 * Each stage is self-contained: if the required API key is missing it logs and skips.
 */

const fs = require('fs');
const path = require('path');

const { parseArgs, ensureDir, saveBuffer, stamp, sleep, extractJson, ensureRefLocal } = require('./lib/util');
const { runPipeline } = require('./agents/pipeline');
const poyo = require('./lib/poyo-image-gpt2');
const vns = require('./lib/veononstop');
const ffmpeg = require('./lib/ffmpeg');
const google = require('./lib/google');

// ---------- tiny .env loader (no dotenv dependency) ----------
function loadEnv(file) {
  file = file || '.env';
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
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

const CROPS = ['tomato', 'strawberry', 'cucumber', 'potato'];

function loadCrop(cropId) {
  const p = path.join(__dirname, 'crops', cropId + '.json');
  if (!fs.existsSync(p)) throw new Error('Unknown crop: ' + cropId + '. Valid: ' + CROPS.join(', '));
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function refPath(cfg) {
  return path.join(__dirname, cfg.reference);
}

// ---------- STAGE: agents ----------
async function stageAgents(cfg, runDir, env, sceneCount) {
  const apiKey = env.OR;
  const model = env.OR_MODEL;
  const factModel = env.OR_FACT || env.OR_MODEL;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required for the agents stage');

  const result = await runPipeline({
    apiKey, model, factModel, cfg, sceneCount,
  });

  const pack = {
    crop: cfg.crop_id,
    generated_at: new Date().toISOString(),
    idea: result.idea,
    factcheck: {
      overall_confidence: result.factcheck && result.factcheck.overall_confidence,
      myths_found: (result.factcheck && result.factcheck.myths_found) || [],
      scenes: (result.factcheck && result.factcheck.scenes) || [],
    },
    script: result.correctedScript,
    imagePrompts: result.imagePrompts && result.imagePrompts.image_prompts,
    videoPrompts: result.videoPrompts && result.videoPrompts.video_prompts,
  };
  fs.writeFileSync(path.join(runDir, 'pack.json'), JSON.stringify(pack, null, 2), 'utf8');

  console.log('\n--- СЦЕНАРИЙ (после фактчекинга) ---');
  for (const s of (pack.script.scenes || [])) {
    console.log(`  Сцена ${s.scene_number} [${s.scene_role}]: ${s.voiceover}`);
  }
  console.log('--- Сохранено: pack.json ---\n');
  return pack;
}

function loadPack(runDir) {
  const p = path.join(runDir, 'pack.json');
  if (!fs.existsSync(p)) throw new Error('pack.json not found in ' + runDir + ' — run --only agents first');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------- STAGE: images ----------
async function stageImages(cfg, runDir, env) {
  const apiKey = env.POYO;
  const base = env.POYO_BASE || 'https://api.poyo.ai';
  if (!apiKey) throw new Error('POYO_API_KEY is required for the images stage');

  const pack = loadPack(runDir);
  const prompts = pack.imagePrompts || [];
  if (!prompts.length) throw new Error('No image_prompts in pack.json — run agents first');

  console.log('[images] uploading reference image…');
  const refLocal = await ensureRefLocal(cfg, __dirname);
  const refUrl = await poyo.uploadFile(apiKey, base, refLocal);
  console.log('[images] ref url: ' + refUrl);

  const imgDir = ensureDir(path.join(runDir, 'images'));
  const imageFiles = [];
  for (const pr of prompts) {
    const n = pr.scene_number;
    console.log(`[images] scene ${n}…`);
    const { buffer } = await poyo.generateImageRetry(apiKey, base, pr.prompt, [refUrl], {
      size: process.env.POYO_IMAGE_SIZE || '9:16',
      resolution: process.env.POYO_IMAGE_RESOLUTION || '1K',
      quality: process.env.POYO_IMAGE_QUALITY || 'low',
    }, 3);
    const file = path.join(imgDir, `scene_${n}.jpg`);
    saveBuffer(buffer, file);
    imageFiles.push({ scene_number: n, file });
    console.log(`[images] scene ${n} OK -> ${file}`);
    await sleep(2000);
  }

  pack.images = imageFiles;
  fs.writeFileSync(path.join(runDir, 'pack.json'), JSON.stringify(pack, null, 2), 'utf8');
  return imageFiles;
}

// ---------- STAGE: videos ----------
async function stageVideos(cfg, runDir, env) {
  const vnsKey = env.VNS;
  const poyoKey = env.POYO;
  const poyoBase = env.POYO_BASE || 'https://api.poyo.ai';
  if (!vnsKey) throw new Error('VEONONSTOP_API_KEY is required for the videos stage');

  const pack = loadPack(runDir);
  const videos = pack.videoPrompts || [];
  const images = pack.images || [];
  if (!videos.length) throw new Error('No video_prompts in pack.json — run agents first');
  if (images.length < videos.length) throw new Error('Scene images missing — run --only images first');

  // Upload each scene image to PoYo to get a public URL for VeoNonStop
  const imgUrls = {};
  if (poyoKey) {
    for (const im of images) {
      console.log(`[videos] uploading scene ${im.scene_number} image…`);
      imgUrls[im.scene_number] = await poyo.uploadFile(poyoKey, poyoBase, im.file);
    }
  } else {
    throw new Error('POYO_API_KEY needed to publish scene images for video generation');
  }

  const vidDir = ensureDir(path.join(runDir, 'videos'));

  // submit all
  const scenes = videos.map((v) => ({
    slot: v.scene_number,
    prompt: v.prompt,
    imageUrl: imgUrls[v.scene_number],
  }));
  console.log('[videos] submitting ' + scenes.length + ' jobs…');
  let items = await vns.submitVideoJobs(vnsKey, scenes);

  // poll
  const failedStatuses = ['failed', 'error', 'cancelled', 'failed_after_retries'];
  for (let round = 0; round < 120; round++) {
    items = await vns.checkVideoStatuses(vnsKey, items);
    const done = items.filter((i) => i.status === 'succeeded').length;
    console.log(`[videos] round ${round}: ${done}/${items.length} ready`);
    if (items.some((i) => failedStatuses.includes(String(i.status).toLowerCase())) && items.every((i) => i.status === 'succeeded' || failedStatuses.includes(String(i.status).toLowerCase()))) break;
    if (items.every((i) => i.status === 'succeeded')) break;
    await sleep(10000);
  }

  // download
  const videoFiles = [];
  for (const it of items) {
    if (it.status !== 'succeeded' || !it.videoUrl) {
      console.log(`[videos] scene ${it.slot} NOT ready (status=${it.status})`);
      continue;
    }
    const buf = await vns.downloadVideo(vnsKey, it.videoUrl);
    const file = path.join(vidDir, `scene_${it.slot}.mp4`);
    saveBuffer(buf, file);
    videoFiles.push({ scene_number: it.slot, file });
    console.log(`[videos] scene ${it.slot} OK -> ${file}`);
  }

  pack.videos = videoFiles;
  fs.writeFileSync(path.join(runDir, 'pack.json'), JSON.stringify(pack, null, 2), 'utf8');
  return videoFiles;
}

// ---------- STAGE: stitch ----------
function stageStitch(cfg, runDir) {
  const pack = loadPack(runDir);
  const vids = (pack.videos || []).slice().sort((a, b) => a.scene_number - b.scene_number);
  if (!vids.length) throw new Error('No videos to stitch — run --only videos first');
  if (!ffmpeg.ffmpegAvailable()) {
    console.log('[stitch] ffmpeg not found — skipping (install ffmpeg or set FFMPEG_BIN)');
    return null;
  }
  const out = path.join(runDir, `final_${cfg.crop_id}_${stamp()}.mp4`);
  ffmpeg.combineVideos(vids.map((v) => v.file), out);
  pack.finalVideo = out;
  fs.writeFileSync(path.join(runDir, 'pack.json'), JSON.stringify(pack, null, 2), 'utf8');
  console.log('[stitch] final -> ' + out);
  return out;
}

// ---------- main ----------
async function main() {
  loadEnv();
  const args = parseArgs(process.argv);
  const cropId = args.crop;
  const only = args.only || 'all';
  const sceneCount = Number(process.env.SCENE_COUNT || args.scenes || 5);

  if (!cropId || !CROPS.includes(cropId)) {
    console.error('Usage: node run.js --crop <' + CROPS.join('|') + '> [--only agents|images|videos|stitch|all] [--resume <stamp>]');
    process.exit(1);
  }

  const cfg = loadCrop(cropId);
  // --resume <stamp>: reuse output/<crop>/<stamp> so stages can run separately.
  // --run <path>: reuse an explicit run directory.
  let runDir;
  if (args.resume) {
    runDir = path.join(__dirname, 'output', cropId, args.resume);
    if (!fs.existsSync(runDir)) { console.error('Resume dir not found: ' + runDir); process.exit(1); }
  } else if (args.run) {
    runDir = path.isAbsolute(args.run) ? args.run : path.join(__dirname, args.run);
    ensureDir(runDir);
  } else {
    runDir = ensureDir(path.join(__dirname, 'output', cropId, stamp()));
  }

  const env = {
    OR: process.env.OPENROUTER_API_KEY,
    OR_MODEL: process.env.OPENROUTER_MODEL || 'openai/gpt-5-nano',
    OR_FACT: process.env.OPENROUTER_MODEL_FACTCHECK,
    POYO: process.env.POYO_API_KEY,
    POYO_BASE: process.env.POYO_BASE || 'https://api.poyo.ai',
    VNS: process.env.VEONONSTOP_API_KEY,
  };

  console.log(`=== cartoon-plants | crop=${cropId} | stage=${only} | scenes=${sceneCount} ===`);
  console.log(`run dir: ${runDir}`);

  try {
    if (only === 'agents' || only === 'all') {
      await stageAgents(cfg, runDir, env, sceneCount);
    }
    if (only === 'images' || only === 'all') {
      await stageImages(cfg, runDir, env);
    }
    if (only === 'videos' || only === 'all') {
      await stageVideos(cfg, runDir, env);
    }
    if (only === 'stitch' || only === 'all') {
      stageStitch(cfg, runDir);
    }

    // optional Drive upload
    if (process.env.GOOGLE_DRIVE_FOLDER_ID) {
      const pack = loadPack(runDir);
      if (pack.finalVideo) {
        const link = await google.uploadFile(pack.finalVideo, path.basename(pack.finalVideo));
        if (link) { pack.driveLink = link; fs.writeFileSync(path.join(runDir, 'pack.json'), JSON.stringify(pack, null, 2), 'utf8'); console.log('[drive] ' + link); }
      }
    }

    console.log('\nDONE. Output: ' + runDir);
  } catch (e) {
    console.error('\nERROR: ' + e.message);
    process.exit(1);
  }
}

module.exports = { main };
if (require.main === module) main();
