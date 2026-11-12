// Builds captions.srt from the marks of a recording and burns it into the video.
// Each caption stays until the next one begins. The caption text is fixed, except where marks.json says what this
// run showed (PayPal's total read back, the amount paid and refunded, the reply grounded in a quote): those
// captions have a second wording, so a caption never claims what is not on screen. Captions sit in a band below the page, never on top of it.
// Usage: node captions.mjs --dir <folder holding raw.webm and marks.json> [--srt-only]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { captionsFor } from './caption-text.mjs';

const args = process.argv.slice(2);
const dirArg = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : undefined;
if (!dirArg) throw new Error('Usage: --dir <folder> [--srt-only]');
const dir = resolve(dirArg);
const take = JSON.parse(readFileSync(join(dir, 'marks.json'), 'utf8'));
const { marks, end } = take;
// Each caption is a claim about what is on screen at that moment; caption-text.mjs words it from what this run returned.
const CAPTIONS = captionsFor(take);

const FRAME = { width: 1920, height: 1080 };      // the recording (3840x1920) is scaled to 1920x960; the band below it holds the captions
// FontSize and MarginV are in the subtitle script's 288-line scale: 13 is about 49 px here, 9 centres one line in the 120 px band.
const STYLE = 'FontName=DejaVu Sans,FontSize=13,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=1,Shadow=0,MarginV=9';
const CRF = 20;

const stamp = s => { const ms = Math.round(s * 1000), pad = (n, w = 2) => String(n).padStart(w, '0'); return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`; };
const starts = CAPTIONS.map((_, i) => marks[i + 1]);
if (starts.some(s => typeof s !== 'number')) throw new Error('marks.json lacks a mark for every caption');
const srt = CAPTIONS.map((text, i) => `${i + 1}\n${stamp(starts[i])} --> ${stamp(starts[i + 1] ?? end)}\n${text}\n`).join('\n');
writeFileSync(join(dir, 'captions.srt'), srt);
console.log(`captions.srt: ${CAPTIONS.length} captions, last ends at ${end} s`);

if (!args.includes('--srt-only')) {
  // Run inside the folder so the subtitles filter gets a bare file name (a path with spaces would need filter escaping).
  const raw = existsSync(join(dir, 'raw.mkv')) ? 'raw.mkv' : 'raw.webm';   // record.mjs writes raw.mkv; older recordings are raw.webm
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-vf', `scale=${FRAME.width}:-2:flags=lanczos,pad=${FRAME.width}:${FRAME.height}:0:0:black,subtitles=captions.srt:force_style='${STYLE}'`, '-c:v', 'libx264', '-crf', String(CRF), '-preset', 'slow', '-pix_fmt', 'yuv420p', '-r', '30', '-an', '-movflags', '+faststart', 'invoiceproof-demo.mp4'], { cwd: dir, stdio: 'inherit' });
  console.log(join(dir, 'invoiceproof-demo.mp4'));
}
