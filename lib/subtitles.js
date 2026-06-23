'use strict';

/**
 * Build an ASS subtitle file (karaoke style, 3-word chunks, active word highlighted)
 * from word-level timestamps. Ported from veo-scripts whisper.transcriptToAss,
 * adapted to take a plain words array (so we don't need a Whisper server).
 *
 * words: [{ text, start, end }, ...]  (start/end in seconds)
 * totalDuration: optional, to extend the last chunk's end to the video length
 */

const ASS_HEADER =
  '[Script Info]\n' +
  'ScriptType: v4.00+\n' +
  'PlayResX: 1080\n' +
  'PlayResY: 1920\n' +
  'WrapStyle: 0\n' +
  '\n' +
  '[V4+ Styles]\n' +
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
  'Style: Default,Montserrat ExtraBold,70,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,12,5,2,20,20,580,1\n' +
  '\n' +
  '[Events]\n' +
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

function toAssTime(seconds) {
  const sec = Number(seconds || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
}

function cleanForScreen(text) {
  return String(text || '').replace(/[.,?!:;"'()\-—]/g, '').trim().toUpperCase();
}

/**
 * words: [{ text, start, end }]  (timestamps in seconds)
 */
function wordsToAss(words, totalDuration) {
  const CHUNK_SIZE = 3;
  const cleaned = (words || [])
    .map((w) => ({ start: Number(w.start || 0), end: Number(w.end || 0), word: cleanForScreen(w.text) }))
    .filter((w) => w.word.length > 0);

  if (!cleaned.length) {
    const dur = totalDuration || 40;
    return ASS_HEADER + 'Dialogue: 0,' + toAssTime(0) + ',' + toAssTime(dur) + ',Default,,0,0,0,,\n';
  }

  const chunks = [];
  for (let i = 0; i < cleaned.length; i += CHUNK_SIZE) chunks.push(cleaned.slice(i, i + CHUNK_SIZE));

  // fill gaps between chunks
  for (let ci = 0; ci < chunks.length - 1; ci++) {
    const gap = chunks[ci + 1][0].start - chunks[ci][chunks[ci].length - 1].end;
    if (gap > 0) chunks[ci][chunks[ci].length - 1].end = chunks[ci + 1][0].start;
  }
  if (totalDuration && chunks.length) {
    const last = chunks[chunks.length - 1];
    if (last[last.length - 1].end < totalDuration) last[last.length - 1].end = totalDuration;
  }

  let dialogues = '';
  chunks.forEach((chunk) => {
    chunk.forEach((active, j) => {
      const lineStart = active.start;
      const lineEnd = j + 1 < chunk.length ? chunk[j + 1].start : active.end;
      const text = chunk
        .map((w, k) => (k === j ? '{\\c&H00FFFF&}' + w.word + '{\\c&HFFFFFF&}' : w.word))
        .join(' ');
      if (text) dialogues += 'Dialogue: 0,' + toAssTime(lineStart) + ',' + toAssTime(lineEnd) + ',Default,,0,0,0,,' + text + '\n';
    });
  });

  return ASS_HEADER + dialogues;
}

module.exports = { wordsToAss, toAssTime };
