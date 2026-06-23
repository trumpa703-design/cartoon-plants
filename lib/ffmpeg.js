'use strict';

/**
 * FFmpeg utilities — cross-platform (execFileSync with arg arrays, no shell quoting).
 *   probeDuration(path)                 → seconds
 *   combineVideos(inputPaths[], out, audioOut?)   concat 5 → 1080x1920 30fps (with audio)
 *   concatVisualOnly(inputPaths[], out)           concat 5 → 1080x1920 30fps (NO audio)
 *   buildFinal(combinedVideo, audioPath, assPath, out)  mux audio + burn .ass subtitles
 *   extractAudio(in, out)
 *   ffmpegAvailable()
 */

const { execFileSync } = require('child_process');

function ffmpegBin() {
  return process.env.FFMPEG_BIN || 'ffmpeg';
}
function ffprobeBin() {
  if (process.env.FFMPEG_BIN) return process.env.FFMPEG_BIN.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
  return 'ffprobe';
}

function ffmpegAvailable() {
  try {
    execFileSync(ffmpegBin(), ['-version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function probeDuration(file) {
  const out = execFileSync(
    ffprobeBin(),
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
    { encoding: 'utf8' }
  );
  return parseFloat(String(out).trim()) || 0;
}

function combineVideos(inputPaths, outputPath, audioOutputPath) {
  if (!inputPaths || !inputPaths.length) throw new Error('combineVideos: no input paths');
  const n = inputPaths.length;
  const args = ['-y'];
  for (const p of inputPaths) args.push('-i', p);
  const fcParts = inputPaths.map(
    (_, i) =>
      '[' + i + ':v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[s' + i + ']'
  );
  const concatInputs = inputPaths.map((_, i) => '[s' + i + '][' + i + ':a]').join('');
  fcParts.push(concatInputs + 'concat=n=' + n + ':v=1:a=1[vout][aout]');
  args.push('-filter_complex', fcParts.join('; '), '-map', '[vout]', '-map', '[aout]');
  args.push('-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath);
  execFileSync(ffmpegBin(), args, { stdio: 'ignore', timeout: 600000 });
  if (audioOutputPath) extractAudio(outputPath, audioOutputPath);
  return outputPath;
}

function concatVisualOnly(inputPaths, outputPath) {
  if (!inputPaths || !inputPaths.length) throw new Error('concatVisualOnly: no input paths');
  const n = inputPaths.length;
  const args = ['-y'];
  for (const p of inputPaths) args.push('-i', p);
  const fcParts = inputPaths.map(
    (_, i) =>
      '[' + i + ':v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[s' + i + ']'
  );
  fcParts.push(inputPaths.map((_, i) => '[s' + i + ']').join('') + 'concat=n=' + n + ':v=1:a=0[vout]');
  args.push('-filter_complex', fcParts.join('; '), '-map', '[vout]');
  args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23', outputPath);
  execFileSync(ffmpegBin(), args, { stdio: 'ignore', timeout: 600000 });
  return outputPath;
}

function escapeAssPath(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:');
}

/**
 * Mux voiceover audio (padded to video duration) and burn .ass subtitles.
 */
function buildFinal(combinedVideo, audioPath, assPath, outputPath) {
  const total = probeDuration(combinedVideo);
  const assFilter = "ass='" + escapeAssPath(assPath) + "'";
  const args = ['-y', '-i', combinedVideo, '-i', audioPath];
  const fc = [];
  fc.push('[1:a]apad=whole_dur=' + total.toFixed(3) + ',aresample=async=1[aout]');
  fc.push('[0:v]' + assFilter + '[vout]');
  args.push('-filter_complex', fc.join(';'));
  args.push('-map', '[vout]', '-map', '[aout]');
  args.push('-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath);
  execFileSync(ffmpegBin(), args, { stdio: 'ignore', timeout: 600000 });
  return outputPath;
}

function extractAudio(inputPath, outputPath) {
  execFileSync(
    ffmpegBin(),
    ['-y', '-i', inputPath, '-vn', '-acodec', 'libmp3lame', '-q:a', '2', outputPath],
    { stdio: 'ignore', timeout: 600000 }
  );
  return outputPath;
}

function burnSubtitles(inputPath, assFilePath, outputPath) {
  const filterComplex = "[0:v]ass='" + escapeAssPath(assFilePath) + "'[out]";
  execFileSync(
    ffmpegBin(),
    ['-y', '-i', inputPath, '-filter_complex', filterComplex, '-map', '[out]', '-map', '0:a', '-c:a', 'copy', outputPath],
    { stdio: 'ignore', timeout: 600000 }
  );
  return outputPath;
}

module.exports = {
  probeDuration, combineVideos, concatVisualOnly, buildFinal,
  extractAudio, burnSubtitles, ffmpegAvailable,
};
