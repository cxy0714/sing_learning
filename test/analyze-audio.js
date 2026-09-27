#!/usr/bin/env node
/* ============================================================
 * test/analyze-audio.js —— 给一段音频打分：评估「音高线提取」质量
 *   用法: node test/analyze-audio.js <音频文件>          # 先用 ffmpeg 转 wav
 *        node test/analyze-audio.js <音频文件> --raw     # 不滤波/不限范围（对照组）
 *
 *   输出的指标用于判断线是"跟到人声"还是"跟到贝斯"：
 *     · 真实检测率   —— 有多少帧真的测到音高（太低说明被伴奏淹没）
 *     · 落在人声区   —— 片段中位音高在 E2~E5 内的比例
 *     · 保持同音比例 / 平均跨度 —— 像歌（高/低）还是像噪声
 * ============================================================ */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const file = process.argv[2];
const rawMode = process.argv.includes('--raw');
if (!file) { console.log('用法: node test/analyze-audio.js <音频文件> [--raw]'); process.exit(1); }

function toWav(f) {
  if (/\.wav$/i.test(f)) return f;
  const out = path.join(require('os').tmpdir(), 'analyze-' + Date.now() + '.wav');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', f, '-ac', '1', '-ar', '22050', '-sample_fmt', 's16', out]);
  return out;
}
function readWav(p) {
  const b = fs.readFileSync(p);
  let pos = 12, fmt = null, off = -1, len = 0;
  while (pos + 8 <= b.length) {
    const id = b.toString('latin1', pos, pos + 4), size = b.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(pos + 10), sampleRate: b.readUInt32LE(pos + 12), bits: b.readUInt16LE(pos + 22) };
    else if (id === 'data') { off = pos + 8; len = size; break; }
    pos += 8 + size + (size % 2);
  }
  const n = Math.floor(len / (fmt.bits / 8));
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = b.readInt16LE(off + i * 2) / 32768;
  return { sampleRate: fmt.sampleRate, length: n, numberOfChannels: 1, duration: n / fmt.sampleRate, getChannelData: () => s };
}
function El() { const e = { dataset: {}, style: {}, _html: '', _text: '', children: [], hidden: false, value: '', checked: false, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, addEventListener() {}, appendChild(c) { this.children.push(c); return c; }, querySelector() { return El(); }, querySelectorAll() { return []; }, getContext() { return new Proxy({}, { get: () => () => {}, set: () => true }); }, getBoundingClientRect() { return { width: 900, height: 320 }; }, clientWidth: 900, clientHeight: 320, pause() {} };
  Object.defineProperty(e, 'innerHTML', { get() { return this._html; }, set(v) { this._html = v; } });
  Object.defineProperty(e, 'textContent', { get() { return this._text; }, set(v) { this._text = v; } });
  return e; }
const els = {};
const document = { readyState: 'complete', body: El(), getElementById(id) { if (!els[id]) els[id] = El(); return els[id]; }, createElement() { return El(); }, querySelector() { return El(); }, querySelectorAll() { return []; }, addEventListener() {} };
const sb = { console, Math, JSON, Date, Array, Object, Number, String, Boolean, isFinite, parseFloat, parseInt, Promise, Float32Array, Int16Array, Float64Array, Uint8Array,
  setTimeout, clearTimeout, setInterval, clearInterval, document,
  navigator: { mediaDevices: { getUserMedia: () => Promise.reject(new Error('x')) } },
  localStorage: { getItem: () => null, setItem() {} }, performance: { now: () => Date.now() }, requestAnimationFrame: () => 0, addEventListener: () => {},
  alert: () => {}, confirm: () => true, FileReader: function () {}, Blob: function () {}, URL: { createObjectURL: () => '', revokeObjectURL() {} }, window: null };
sb.window = sb; sb.self = sb; sb.globalThis = sb; vm.createContext(sb);
for (const f of ['js/pitch.js', 'js/songs.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f });
let src = fs.readFileSync(path.join(ROOT, 'js/karaoke.js'), 'utf8');
const hook = '\nwindow.__K={S,extractReference,buildRefSegs,vocalRange};\n';
const i = src.lastIndexOf('})();'); src = src.slice(0, i) + hook + src.slice(i);
vm.runInContext(src, sb, { filename: 'karaoke.js' });
const K = sb.__K, S = K.S, PT = sb.PitchTool;
if (rawMode) { S.vocalBand = false; S.vocalPreset = 'wide'; }

(async () => {
  const wav = toWav(file);
  const ab = readWav(wav);
  const t0 = Date.now();
  const track = await K.extractReference(ab, null);
  const ms = Date.now() - t0;
  const segs = K.buildRefSegs(track);
  if (!track.length) { console.log('❌ 没提取到内容'); return; }
  const det = track.filter(p => p.detected).length;
  const onLine = track.filter(p => !p.gap).length;
  const q = track.filter(p => !p.gap).map(p => p.q);
  const sorted = [...q].sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const inVocal = segs.filter(s => s.midi >= 40 && s.midi <= 76).length;
  const same = q.filter((v, k) => k && v === q[k - 1]).length;
  let jsum = 0, jn = 0, big = 0;
  for (let k = 1; k < q.length; k++) { const d = Math.abs(q[k] - q[k - 1]); jsum += d; jn++; if (d > 7) big++; }
  console.log('\n文件: ' + path.basename(file) + '   时长 ' + ab.duration.toFixed(0) + 's   ' + (rawMode ? '【对照：不滤波+不限范围】' : '【默认：人声滤波+人声范围 ' + K.vocalRange().label + '】'));
  console.log('  耗时            ' + ms + 'ms');
  console.log('  真实检测率       ' + (det / track.length * 100).toFixed(0) + '%   (' + det + '/' + track.length + ' 帧)');
  console.log('  连续覆盖率       ' + (onLine / track.length * 100).toFixed(0) + '%');
  console.log('  音域 / 中位      ' + PT.midiToName(sorted[0]) + ' ~ ' + PT.midiToName(sorted[sorted.length - 1]) + '   中位 ' + PT.midiToName(med) + ' (' + PT.midiToFreq(med, 440).toFixed(0) + 'Hz)');
  console.log('  分位 p10/50/90   ' + PT.midiToName(sorted[Math.floor(sorted.length * .1)]) + ' / ' + PT.midiToName(med) + ' / ' + PT.midiToName(sorted[Math.floor(sorted.length * .9)]));
  console.log('  片段数 / 时长     ' + segs.length + ' 个, 平均 ' + (segs.reduce((a, s) => a + s.endMs - s.startMs, 0) / segs.length / 1000).toFixed(2) + 's');
  console.log('  片段在 E2~E5 内  ' + inVocal + '/' + segs.length + ' (' + (inVocal / segs.length * 100).toFixed(0) + '%)   ← 越高越像人声');
  console.log('  保持同音 / 平均跨度 / 大跳 ' + (same / jn * 100).toFixed(0) + '%  ' + (jsum / jn).toFixed(2) + ' 半音  ' + (big / jn * 100).toFixed(1) + '%');
})();