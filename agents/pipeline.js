'use strict';

/**
 * Agent pipeline: brainstorm → select → script → factcheck → imagePrompts → videoPrompts.
 * All steps via OpenRouter. The fact-check step uses a (optionally stronger) model.
 */

const OR = require('../lib/openrouter');
const prompts = require('./prompts');

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
  const script = await OR.chatJsonRetry(
    apiKey, model,
    prompts.scriptSys(cfg, sceneCount),
    JSON.stringify({ idea, episode_structure: cfg.episode_structure }, null, 2),
    { temperature: 0.7 }, 3
  );

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
