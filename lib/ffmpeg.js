'use strict';

/**
 * FFmpeg utilities — cross-platform (uses execFileSync with arg arrays,
 * no shell quoting issues, no '< /dev/null'). All functions take FILE PATHS.
 *
 *   combineVideos(inputPaths[], outputPath)
 *   extractAudio(inputPath, outputPath)
 *   burnSubtitles(inputPath, assFilePath, outputPath)
 *
 * Ported from veo-scripts; rewritten to be Windows-friendly.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');

function ffmpegBin() {
  return process.env.FFMPEG_BIN || 'ffmpeg';
}

function ffmpegAvailable() {
  try {
    execFileSync(ffmpegBin(), ['-version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Combine video files into a single 1080x1920 30fps MP4 (concat with audio).
 */
function combineVideos(inputPaths, outputPath) {
  if (!inputPaths || inputPaths.length === 0) {
    throw new Error('combineVideos: no input paths');
  }
  const n = inputPaths.length;

  const args = ['-y'];
  for (const p of inputPaths) {
    args.push('-i', p);
  }

  const fcParts = inputPaths.map(
    (_, i) =>
      `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[s${i}]`
  );
  const concatInputs = inputPaths.map((_, i) => `[s${i}][${i}:a]`).join('');
  fcParts.push(`${concatInputs}concat=n=${n}:v=1:a=1[vout][aout]`);
  args.push('-filter_complex', fcParts.join(';'));
  args.push('-map', '[vout]', '-map', '[aout]');
  args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23');
  args.push('-c:a', 'aac', '-b:a', '128k');
  args.push(outputPath);

  execFileSync(ffmpegBin(), args, { stdio: 'ignore', timeout: 600000 });
  return outputPath;
}

/**
 * Extract audio from a video as MP3.
 */
function extractAudio(inputPath, outputPath) {
  execFileSync(
    ffmpegBin(),
    ['-y', '-i', inputPath, '-vn', '-acodec', 'libmp3lame', '-q:a', '2', outputPath],
    { stdio: 'ignore', timeout: 600000 }
  );
  return outputPath;
}

/**
 * Burn .ass subtitles into a video. (Watermark blur omitted for portability.)
 */
function burnSubtitles(inputPath, assFilePath, outputPath) {
  const safeAss = assFilePath.replace(/\\/g, '/').replace(/:/g, '\\:');
  const filterComplex = `[0:v]ass='${safeAss}'[out]`;
  execFileSync(
    ffmpegBin(),
    ['-y', '-i', inputPath, '-filter_complex', filterComplex, '-map', '[out]', '-map', '0:a', '-c:a', 'copy', outputPath],
    { stdio: 'ignore', timeout: 600000 }
  );
  return outputPath;
}

module.exports = { combineVideos, extractAudio, burnSubtitles, ffmpegAvailable };
