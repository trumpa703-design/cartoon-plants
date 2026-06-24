'use strict';

/**
 * Agent pipeline: brainstorm → select → script → factcheck → imagePrompts → videoPrompts.
 * All steps via OpenRouter. The fact-check step uses a (optionally stronger) model.
 */

const OR = require('../lib/openrouter');
const prompts = require('./prompts');

function countRuWords(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Ensure every scene's voiceover is within [min,max] words via a corrective agent pass.
 */
async function enforceWordCount(apiKey, model, script, min, max) {
  const scenes = (script && script.scenes) || [];
  if (!scenes.length) return script;
  const isBad = (s) => { const c = countRuWords(s.voiceover); return c < min || c > max; };
  if (!scenes.some(isBad)) {
    console.log('   word-count OK (все ' + min + '-' + max + ' слов)');
    return script;
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const bad = scenes.filter(isBad).map((s) => ({ scene_number: s.scene_number, current: countRuWords(s.voiceover), target: max }));
    if (!bad.length) { console.log('   word-count исправлен'); break; }
    console.log('   word-count правка ' + (attempt + 1) + ': ' + bad.map((b) => 'сц' + b.scene_number + '=' + b.current + '→' + b.target).join(', '));
    const fixed = await OR.chatJsonRetry(apiKey, model, prompts.fixWordsSys(min, max), JSON.stringify({ script, fix_these: bad }, null, 2), {}, 3);
    const fscenes = (fixed && fixed.scenes) || [];
    fscenes.forEach((s) => { s.word_count = countRuWords(s.voiceover); });
    if (fscenes.length) script = fixed;
    if (!fscenes.some(isBad)) { console.log('   word-count исправлен'); break; }
  }
  // last-resort: fix each still-bad scene individually with a sharp target
  for (const s of scenes) {
    if (!isBad(s)) continue;
    console.log('   добивка сцены ' + s.scene_number + ' до ' + max + ' слов…');
    const sys = 'Перепиши voiceover РОВНО ' + max + ' русскими словами, сохранив смысл. Верни ТОЛЬКО JSON {"voiceover":"...","word_count":' + max + '}.';
    for (let t = 0; t < 3; t++) {
      const r = await OR.chatJsonRetry(apiKey, model, sys, JSON.stringify({ current: s.voiceover, target: max }, null, 2), {}, 3);
      const v = r && r.voiceover;
      const c = countRuWords(v);
      if (c >= min && c <= max) { s.voiceover = v; s.word_count = c; break; }
    }
  }
  console.log('   word-count итог: ' + scenes.map((s) => 'сц' + s.scene_number + '=' + countRuWords(s.voiceover)).join(', '));
  return script;
}

/**
 * Ensure the final scene's voiceover contains the mandatory CTA phrase (verbatim).
 */
async function enforceCTAPhrase(apiKey, model, script, min, max) {
  const scenes = (script && script.scenes) || [];
  if (!scenes.length) return script;
  const last = scenes[scenes.length - 1];
  const phrase = prompts.CTA_PHRASE;
  const hay = String(last.voiceover || '').toLowerCase();
  const ok = phrase.split(/\s+/).every((w) => hay.includes(w.toLowerCase()));
  if (ok) {
    console.log('   CTA-фраза на месте');
    return script;
  }
  console.log('   CTA-фраза отсутствует — вставляю в финальную сцену…');
  const sys = [
    'Ты — CTA Fixer. В финальной сцене voiceover ОБЯЗАТЕЛЬНО должен содержать дословно фразу:',
    '«' + phrase + '»',
    'вплетённую естественно в призыв (персонаж держит бутылку BIOGROWTH).',
    'Перепиши ТОЛЬКО voiceover финальной сцены: ' + min + '-' + max + ' слов, обязательно включая эту фразу дословно.',
    'Верни ТОЛЬКО валидный JSON: {"voiceover":"...","word_count":N}.',
  ].join('\n');
  for (let attempt = 0; attempt < 3; attempt++) {
    const fixed = await OR.chatJsonRetry(apiKey, model, sys, JSON.stringify({ current: last.voiceover }, null, 2), {}, 3);
    const v = fixed && fixed.voiceover;
    if (v) {
      const hv = v.toLowerCase();
      if (phrase.split(/\s+/).every((w) => hv.includes(w.toLowerCase()))) {
        last.voiceover = v;
        last.word_count = countRuWords(v);
        console.log('   CTA-фраза вставлена');
        return script;
      }
    }
  }
  // last resort: hard-embed the phrase
  last.voiceover = phrase + ' — подпишись на канал за советами по уходу.';
  last.word_count = countRuWords(last.voiceover);
  console.log('   CTA-фраза вшита принудительно');
  return script;
}

/**
 * Run the full agent pipeline for one crop.
 * @param {object} o
 *   apiKey, model, factModel, cfg (crop config), season, sceneCount
 * @returns {Promise<object>} { ideas, idea, script, factcheck, correctedScript, imagePrompts, videoPrompts }
 */
async function runPipeline(o) {
  const apiKey = o.apiKey;
  const model = o.model;
  const factModel = o.factModel || model;
  const cfg = o.cfg;
  const season = o.season || currentSeason();
  const sceneCount = o.sceneCount || cfg.sceneCount || 5;

  console.log(`\n[1/6] brainstorm идей (${cfg.crop_ru}, ${season})…`);
  const ideas = await OR.chatJsonRetry(
    apiKey, model,
    prompts.brainstormSys(cfg, season),
    JSON.stringify({ topic_examples: cfg.topic_examples, content_angles: cfg.content_angles, hook_styles: cfg.hook_styles }, null, 2),
    { temperature: 0.9 }, 3
  );

  console.log('[2/6] выбор лучшей идеи…');
  const idea = await OR.chatJsonRetry(
    apiKey, model,
    prompts.selectSys(cfg),
    JSON.stringify({ ideas }, null, 2),
    {}, 3
  );

  console.log('[3/6] сценарий…');
  let script = await OR.chatJsonRetry(
    apiKey, model,
    prompts.scriptSys(cfg, sceneCount),
    JSON.stringify({ idea, episode_structure: cfg.episode_structure }, null, 2),
    { temperature: 0.7 }, 3
  );

  // enforce voiceover word count (16-17) with a corrective pass if needed
  const wmin = cfg.voiceover_word_min || 16;
  const wmax = cfg.voiceover_word_max || 17;
  script = await enforceWordCount(apiKey, model, script, wmin, wmax);
  // enforce mandatory CTA phrase in the final scene
  script = await enforceCTAPhrase(apiKey, model, script, wmin, wmax);

  console.log('[4/6] ФАКТЧЕК агрономической точности…');
  const factcheck = await OR.chatJsonRetry(
    apiKey, factModel,
    prompts.factcheckSys(cfg, sceneCount),
    JSON.stringify({ script }, null, 2),
    {}, 4
  );
  const correctedScript = (factcheck && factcheck.corrected_script) || script;

  console.log('[5/6] image-промпты…');
  const imagePrompts = await OR.chatJsonRetry(
    apiKey, model,
    prompts.imageSys(cfg, sceneCount),
    JSON.stringify({ script: correctedScript, environment: cfg.environment_core }, null, 2),
    {}, 3
  );

  console.log('[6/6] video-промпты…');
  const videoPrompts = await OR.chatJsonRetry(
    apiKey, model,
    prompts.videoSys(cfg, sceneCount),
    JSON.stringify({ script: correctedScript, imagePrompts, voice_description: cfg.voice_description }, null, 2),
    {}, 3
  );

  return { ideas, idea, script, factcheck, correctedScript, imagePrompts, videoPrompts };
}

function currentSeason() {
  const m = new Date().getMonth() + 1; // 1..12
  if (m >= 3 && m <= 5) return 'весна';
  if (m >= 6 && m <= 8) return 'лето';
  if (m >= 9 && m <= 10) return 'осень (сбор)';
  return 'зима/межсезонье (подготовка)';
}

module.exports = { runPipeline, currentSeason };
