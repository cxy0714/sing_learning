#!/usr/bin/env node
/* ============================================================
 * test/selftest.js —— 离线回归测试（不需要浏览器、不需要麦克风）
 *   用法: node test/selftest.js
 *   覆盖：音高算法 / 音名换算 / 曲库 / K歌提取与打分 / 音准页统计与导出
 * ============================================================ */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0; const fails = [];
function chk(ok, msg, extra) { if (ok) { pass++; } else { fail++; fails.push(msg + (extra !== undefined ? '  → ' + extra : '')); } }
function sec(s) { console.log('\n── ' + s + ' ' + '─'.repeat(Math.max(0, 46 - s.length))); }

/* ---------- 桩 DOM ---------- */
function makeDom() {
  const calls = { clearRect: 0, fillRect: 0, stroke: 0, fillText: 0, arc: 0 };
  const ctx2d = new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => { if (calls[p] !== undefined) calls[p]++; }), set: (t, p, v) => { t[p] = v; return true; } });
  function El(tag, id) {
    const el = {
      tagName: (tag || 'DIV').toUpperCase(), id: id || '', dataset: {}, style: {}, _html: '', _text: '', hidden: false, children: [], parentNode: null,
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, f) { f === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (f ? this._s.add(c) : this._s.delete(c)); }, contains(c) { return this._s.has(c); } },
      value: '', checked: false, disabled: false, files: null, paused: true, currentTime: 0, src: '', options: [], selectedIndex: 0,
      clientWidth: 900, clientHeight: 320, width: 0, height: 0,
      scrollIntoView() {}, focus() {}, click() {}, setAttribute() {}, getAttribute() { return null; }, pause() {}, play() { return Promise.resolve(); },
      addEventListener() {}, removeEventListener() {},
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      removeChild(c) { this.children = this.children.filter(x => x !== c); return c; },
      querySelector() { return El('div'); }, querySelectorAll() { return []; },
      getContext() { return ctx2d; }, getBoundingClientRect() { return { width: 900, height: 320, left: 0, top: 0 }; }
    };
    Object.defineProperty(el, 'innerHTML', { get() { return this._html; }, set(v) { this._html = v; } });
    Object.defineProperty(el, 'textContent', { get() { return this._text; }, set(v) { this._text = v; } });
    return el;
  }
  const els = {};
  const document = {
    readyState: 'complete', body: El('body'),
    getElementById(id) { if (!els[id]) els[id] = El('div', id); return els[id]; },
    createElement(tag) { return El(tag); },
    querySelector() { return El('div'); }, querySelectorAll() { return []; }, addEventListener() {}
  };
  ['octaveSel', 'pracSel', 'a4Input', 'flatChk', 'liveWin', 'rangeSel', 'rangeLowSel', 'rangeHighSel', 'scopeChk', 'songSel', 'speedSel', 'trVal', 'guideChk', 'metroChk', 'lrcChk', 'vocalSel', 'vocalBandChk', 'audioFile', 'freeRecBtn']
    .forEach(id => { els[id] = El(id === 'a4Input' || id === 'liveWin' ? 'input' : 'select', id); });
  els['a4Input'].value = '440'; els['octaveSel'].value = '3'; els['liveWin'].value = '10';
  els['speedSel'].value = '1'; els['guideChk'].checked = true; els['metroChk'].checked = true; els['lrcChk'].checked = true;
  return { document, els, calls };
}

function makeSandbox(dom) {
  const store = (() => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } }; })();
  const sb = {
    console, Math, JSON, Date, Array, Object, Number, String, Boolean, isFinite, parseFloat, parseInt, Promise, Float32Array, Int16Array, Float64Array, Uint8Array, Buffer,
    setTimeout, clearTimeout, setInterval, clearInterval, document: dom.document,
    navigator: { mediaDevices: { getUserMedia: () => Promise.reject(new Error('no mic')) } },
    localStorage: store, performance: { now: () => Date.now() }, requestAnimationFrame: () => 0, addEventListener: () => {},
    alert: () => {}, confirm: () => true, FileReader: function () {},
    Blob: function (p) { this.parts = p; }, URL: { createObjectURL: () => 'blob:', revokeObjectURL() {} }, window: null
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  return sb;
}
function load(sb, f) { vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f }); }
function loadWithHook(sb, f, hookCode) {
  let src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const i = src.lastIndexOf('})();');
  src = src.slice(0, i) + '\n' + hookCode + '\n' + src.slice(i);
  vm.runInContext(src, sb, { filename: f });
}

/* ---------- 合成音频（纯正弦旋律） ---------- */
function makeAudio(sr, notes, amp) {
  const total = notes.reduce((a, n) => a + n[1], 0);
  const len = Math.floor(total * sr);
  const data = new Float32Array(len);
  let off = 0;
  notes.forEach(([f, d]) => {
    const n = Math.floor(d * sr);
    for (let k = 0; k < n && off + k < len; k++) {
      const env = Math.min(1, k / 400) * Math.min(1, (n - k) / 400);
      data[off + k] = (amp || 0.35) * env * Math.sin(2 * Math.PI * f * k / sr);
    }
    off += n;
  });
  return { sampleRate: sr, length: len, numberOfChannels: 1, duration: total, getChannelData: () => data };
}

/* ============================================================ */
/*  1. 音高算法 + 音名换算                                       */
/* ============================================================ */
sec('1. 音高检测与音名换算');
{
  const sb = makeSandbox(makeDom());
  load(sb, 'js/pitch.js');
  const PT = sb.PitchTool;
  let worst = 0;
  [65.41, 98.0, 130.81, 261.63, 392.0, 440.0, 493.88, 523.25, 880.0, 1046.5].forEach(f => {
    const buf = new Float32Array(4096);
    for (let i = 0; i < 4096; i++) buf[i] = 0.3 * Math.sin(2 * Math.PI * f * i / 48000);
    const r = PT.detectPitch(buf, 48000, { minFreq: 65, maxFreq: 1300, threshold: 0.15 });
    worst = Math.max(worst, Math.abs(1200 * Math.log2(r.freq / f)));
  });
  chk(worst < 2, '纯正弦检测误差 < 2 音分', worst.toFixed(2) + ' 音分');
  const silent = PT.detectPitch(new Float32Array(4096), 48000, {});
  chk(silent.freq === -1, '静音返回无音高');

  const want = { 'C4': 261.63, 'D4': 293.66, 'E4': 329.63, 'F4': 349.23, 'G4': 392.0, 'A4': 440.0, 'B4': 493.88, 'C5': 523.25 };
  let ok = true;
  PT.scaleNotes(4, 440, false).forEach(n => { if (Math.abs(n.freq - want[n.letterName]) > 0.02) ok = false; });
  chk(ok, 'do~do 八个音的标准频率正确');
  chk(PT.midiFromName('A2') === 45 && PT.midiFromName('A4') === 69 && PT.midiFromName('Bb2') === 46, '音名→MIDI（含降号）正确');
  chk(PT.midiToName(45) === 'A2' && PT.midiToName(69) === 'A4', 'MIDI→音名正确');
  chk(PT.midiToName(60.0002) === 'C4' && PT.midiToName(72.4) === 'C5', '小数 MIDI 也能正确取整命名（曾返回 NaN）');
  chk(true, '（内置曲目已移除）');
}

/* ============================================================ */
/*  2. K歌：提取旋律线 + 打分                                     */
/* ============================================================ */
sec('2. K歌提取与打分');
(async () => {
  const dom = makeDom();
  const sb = makeSandbox(dom);
  load(sb, 'js/pitch.js');
  loadWithHook(sb, 'js/karaoke.js', 'window.__K={S,extractReference,buildRefSegs,scoreVsRef,foldCents,viterbiPath,renderResult,buildExport,drawKara,updateHUD,parseLRC,updateLyrics,karaWindow,refTargetAt};');
  const K = sb.__K, S = K.S, PT = sb.PitchTool;

  chk(true, '（只保留本地歌曲模式：目标线来自音频提取）');

  sec('2b. 从合成音频提取旋律（do re mi sol la）');
  const ab = makeAudio(44100, [[261.63, .55], [293.66, .55], [329.63, .55], [392, .55], [440, .55]]);
  const track = await K.extractReference(ab, null);
  const segs = K.buildRefSegs(track);
  const vtr = track.filter(p => !p.gap && p.q !== undefined);
  const names = [...new Set(vtr.map(p => p.q))].sort((a, b) => a - b).map(m => PT.midiToName(m));
  chk(names.join(',') === 'C4,D4,E4,G4,A4', '提取出 5 个音且顺序正确', names.join(','));
  chk(vtr.length / track.length > 0.95, '旋律线连续（>95% 帧落在线上）', (vtr.length / track.length * 100).toFixed(0) + '%');
  let mid = 0;
  vtr.forEach((p, i) => { if (i && p.q !== vtr[i - 1].q && p.q !== (vtr[i + 1] || {}).q) mid++; });
  chk(mid <= 2, '换音处没有停留假音', mid + ' 个孤立帧');
  chk(segs.length === 5, '切成 5 个音符片段', segs.length);
  chk(segs.every(s => s.midi >= 60 && s.midi <= 69), '片段音高正确', segs.map(s => PT.midiToName(s.midi)).join(','));

  /* ---- 前奏是纯伴奏/静音时，不应该画出音高线（用户反馈的问题）---- */
  {
    const sr2 = 22050, n2 = sr2 * 3;
    const d2 = new Float32Array(n2);
    for (let i = Math.floor(sr2 * 1.5); i < n2; i++) {          // 前 1.5 秒静音，之后 330Hz
      const env = Math.min(1, (i - sr2 * 1.5) / 400) * Math.min(1, (n2 - i) / 400);
      d2[i] = 0.35 * env * Math.sin(2 * Math.PI * 330 * i / sr2);
    }
    const ab2 = { sampleRate: sr2, length: n2, numberOfChannels: 1, duration: 3, getChannelData: () => d2 };
    const t2 = await K.extractReference(ab2, null);
    const seg2 = K.buildRefSegs(t2);
    chk(seg2.length === 1 && seg2[0].startMs > 1350, '前奏静音段不出线（只在人声处才有音符）',
      seg2.length + ' 段，首段起点 ' + (seg2.length ? Math.round(seg2[0].startMs) : '-') + 'ms');
    chk(t2.filter(p => p.gap).length > 15, '静音帧被标成 gap（线断开，不画绿色）',
      t2.filter(p => p.gap).length + '/' + t2.length + ' 帧');
  }
  sec('2c. 打分（含八度对齐）');
  S.refTrack = track; S.refSegs = segs; S.refShiftOct = 0;
  function sing(oct, detune) {
    S.samples = [];
    segs.forEach(sg => { for (let t = sg.startMs + 100; t < sg.endMs - 30; t += 70) S.samples.push({ t: t, f: PT.midiToFreq(sg.midi + oct, 440) * Math.pow(2, (detune || 0) / 1200) }); });
  }
  sing(0, 0); let r = K.scoreVsRef();
  chk(r.total >= 98, '原八度完美演唱 ≈ 100 分', r.total);
  sing(-12, 0); r = K.scoreVsRef();
  chk(r.total >= 98 && S.refShiftOct === -12, '低八度唱不吃亏且自动识别', r.total + ' 分 / 平移 ' + S.refShiftOct);
  sing(-12, 30); r = K.scoreVsRef();
  chk(r.total >= 60 && r.total <= 70, '低八度 + 偏高 30 音分 → 60~70 分', r.total);
  S.samples = []; r = K.scoreVsRef();
  chk(r.total === 0 && r.sungCount === 0, '没唱 → 0 分');
  sing(-12, 0); K.scoreVsRef();
  const ex = K.buildExport();
  chk(ex.targets.length === (S.refSegs || []).length && ex.points.length > 0, '导出含目标线 + 原始轨迹', ex.targets.length + ' 目标 / ' + ex.points.length + ' 采样');
  chk(ex.points[0].centsVsTarget !== null && ex.points[0].centsVsTarget !== undefined, '每个采样点带上「相对目标旋律」的偏差', ex.points[0].centsVsTarget);
  sing(-12, 0); K.scoreVsRef(); K.renderResult(); K.drawKara(); K.updateHUD();
  chk(dom.calls.stroke > 0 && String(dom.els['resultBody']._html).indexOf('note-pill') >= 0, '成绩单与图形渲染正常');
  chk(K.foldCents(1200) === 0 && Math.abs(K.foldCents(1250) - 50) < 0.01, '音分八度折叠正确');

  sec('2e. 音高线只显示局部窗口（跟随滚动）');
  {
    const W = K.karaWindow;
    const k1 = W(28800, 4, 14000);
    chk(Math.round(k1.t1 - k1.t0) === 4000 && k1.t0 < 14000 && k1.t1 > 14000,
      '4 秒窗口且包含当前播放位置', Math.round(k1.t0) + 'ms ~ ' + Math.round(k1.t1) + 'ms');
    const k2 = W(28800, 8, 1000);
    chk(Math.round(k2.t0) === 0 && Math.round(k2.t1) === 8000, '开头不越界', JSON.stringify(k2));
    const k3 = W(28800, 8, 28500);
    chk(Math.round(k3.t1) === 28800 && Math.round(k3.t1 - k3.t0) === 8000, '结尾不越界', JSON.stringify(k3));
    const k4 = W(28800, 0, 14000);
    chk(k4.t0 === 0 && k4.t1 === 28800, 'viewWin=0 → 全曲总览');
    const k5 = W(3000, 8, 1000);
    chk(k5.t0 === 0 && k5.t1 === 3000, '歌比窗口短 → 显示全长');
    const k6 = W(28800, 4, -500);
    chk(Math.round(k6.t0) === 0, '起拍阶段（位置为负）显示开头', JSON.stringify(k6));

    /* 缩放效果：局部模式的纵轴跨度应该明显更小（音高细节被放大） */
    S.notes = []; S.refTrack = track; S.refSegs = segs; S.mode = 'free';
    S.samples = []; S.songPos = 1200;
    S.viewWin = 0; S.karaAxis = null; K.drawKara();
    const spanFull = S.karaAxis.hi - S.karaAxis.lo;
    S.viewWin = 4; S.karaAxis = null; K.drawKara();
    const spanLoc = S.karaAxis.hi - S.karaAxis.lo;
    chk(spanLoc > 0 && spanLoc < spanFull, '局部模式的纵轴跨度更小（细节被放大）',
      '全曲 ' + spanFull.toFixed(1) + ' 个半音 → 局部 ' + spanLoc.toFixed(1) + ' 个半音');
    S.playing = false;
  }
  sec('2d. 歌词解析');
  const lrc = K.parseLRC('[00:01.50]第一行\n[00:03.00]第二行\n[00:05.25]第三行');
  chk(lrc.length === 3 && lrc[0].t === 1500 && lrc[2].t === 5250, 'LRC 时间标签解析正确', JSON.stringify(lrc.map(l => l.t)));
  S.lrc = lrc; S._lyIdx = -1; dom.els['lrcChk'].checked = true;
  K.updateLyrics(3200);
  chk(String(dom.els['lyrics']._html).indexOf('ly-on') >= 0 && String(dom.els['lyrics']._html).indexOf('第二行') >= 0, '歌词按时间高亮正确');

  /* ============================================================ */
  /*  3. 音准页：统计 / 导出 / 音域                                */
  /* ============================================================ */
  sec('3. 音准检测页');
  const dom2 = makeDom();
  const sb2 = makeSandbox(dom2);
  load(sb2, 'js/pitch.js');
  loadWithHook(sb2, 'js/app.js', 'window.__T={S,loop,analyze,updateReadout,computeStats,buildExport,drawChart,renderStats,applyRange,onRangePreset,isOutOfRange,startPractice,clearLive,updateShift,playShiftTone,recordRangeNote,voiceText,renderRangeLog,loadRangeLog,todayKey};');
  const T = sb2.__T, SA = T.S, PT2 = sb2.PitchTool;
  chk(SA.ladderOctave === 3 && SA.rangeLow === 45 && SA.rangeHigh === 69, '默认第 3 组 + 音域 A2–A4', SA.ladderOctave + ' / ' + PT2.midiToName(SA.rangeLow) + '-' + PT2.midiToName(SA.rangeHigh));

  // 造一段 do re mi fa sol la xi do 的录音（sol 偏 +45，la 偏 -30）
  const bias = { 60: 45, 62: 0, 64: -10, 65: 0, 67: 45, 69: -30, 71: 0, 72: 5 };
  const trk = []; let tt = 0;
  [60, 62, 64, 65, 67, 69, 71, 72].forEach(m => {
    const f0 = PT2.midiToFreq(m, 440) * Math.pow(2, (bias[m] || 0) / 1200);
    for (let i = 0; i < 30; i++) { const w = Math.sin(i / 3) * 6; trk.push({ t: tt += 70, f: f0 * Math.pow(2, w / 1200), rms: .05, conf: .9 }); }
  });
  const stt = T.computeStats(trk);
  const rowsOk = [60, 62, 64, 65, 67, 69, 71, 72].every(m => { const r = stt.list.find(x => x.midi === m); return r && Math.abs(r.avg - bias[m]) < 3; });
  chk(rowsOk, '逐音平均偏差统计正确（含 +45 / -30）');
  chk(stt.summary.worst && Math.abs(stt.summary.worst.avg) > 40, '能找出最偏的音', stt.summary.worst.sol + ' ' + stt.summary.worst.avg.toFixed(0));
  chk(stt.summary.rangeLowMidi !== undefined && Math.round(stt.summary.rangeHighMidi) === 72, '本段音高范围识别正确', PT2.midiToName(stt.summary.rangeLowMidi) + '~' + PT2.midiToName(stt.summary.rangeHighMidi));

  // 实时分析循环（喂 392Hz 正弦）
  const fkParam = () => ({ setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} });
  SA.audioCtx = { sampleRate: 48000, currentTime: 0, state: 'running', destination: {}, resume() {},
    createOscillator() { return { type: '', frequency: fkParam(), connect() {}, start() {}, stop() {} }; },
    createGain() { return { gain: fkParam(), connect() {} }; } };
  SA.buf = new Float32Array(2048);
  SA.analyser = { fftSize: 2048, getFloatTimeDomainData(b) { b.set(SA.buf); } };
  SA.running = true; let ts = 1000;
  for (let k = 0; k < 8; k++) {
    for (let i = 0; i < 2048; i++) SA.buf[i] = 0.25 * Math.sin(2 * Math.PI * 392 * i / 48000);
    ts += 100; T.loop(ts);
  }
  chk(dom2.els['noteSol']._text === 'sol' && String(dom2.els['noteOct']._text) === '4', '实时显示 sol4', dom2.els['noteSol']._text + dom2.els['noteOct']._text);
  chk(Math.abs(parseFloat(dom2.els['freqVal']._text) - 392) < 2, '实时频率显示正确', dom2.els['freqVal']._text);

  T.onRangePreset('birthday' in {} ? 'baritenor' : 'baritenor');
  chk(SA.rangeLow === 45 && SA.rangeHigh === 69, '音域预设切换正常');
  T.applyRange(48, 60, 'custom');
  chk(SA.rangeLow === 48 && SA.rangeHigh === 60 && T.isOutOfRange(62) && !T.isOutOfRange(60), '自定义音域 + 越界判断正确');
  T.applyRange(45, 69, 'baritenor');

  // 变调助手
  dom2.els['songHighSel'].value = 72; dom2.els['songLowSel'].value = '';
  T.updateShift();
  chk(SA.shiftSuggest === 4, '变调助手：最高音 C5 超出 A4 → 建议降 4 个半音', SA.shiftSuggest);
  dom2.els['songHighSel'].value = 60; T.updateShift();
  chk(SA.shiftSuggest === 0, '变调助手：最高音 C4 → 原调可唱');
  T.playShiftTone(); T.drawChart(trk); T.renderStats(stt);
  chk(true, '试听/画图/统计渲染无异常');

  sec('3b. 每日音域记录 + 声部判断');
  {
    sb2.localStorage.setItem('vpm.range.v1', '{}');
    T.recordRangeNote(40); T.recordRangeNote(74); T.recordRangeNote(64);   // E2 / D5 / E4
    const lg = JSON.parse(sb2.localStorage.getItem('vpm.range.v1'));
    const day = lg[Object.keys(lg)[0]];
    chk(day && day.low === 40 && day.high === 74, '记录每天的最低/最高音', day ? (day.low + ' ~ ' + day.high) : '无');
    chk(T.voiceText(40, 74) === '下限像男低音，上限像男高音', 'E2–D5 → 下限像男低音、上限像男高音', T.voiceText(40, 74));
    chk(T.voiceText(45, 69).indexOf('男中音') >= 0, 'A2–A4 → 男中音区间', T.voiceText(45, 69));
    chk(T.voiceText(48, 72).indexOf('男高音') >= 0, 'C3–C5 → 男高音', T.voiceText(48, 72));
    chk(T.voiceText(60, 84).indexOf('女高音') >= 0, 'C4–C6 → 女高音', T.voiceText(60, 84));
    T.renderRangeLog();
    chk(String(dom2.els['rangeBody']._html).indexOf('半音') >= 0, '音域表格渲染正常');
  }
  /* ============================================================ */
  /*  4. 本地曲库（扫描 / 搜索 / 合并）                              */
  /* ============================================================ */
  sec('4. 本地曲库');
  {
    const sb3 = makeSandbox(makeDom());
    load(sb3, 'js/library.js');
    const SL = sb3.SongLibrary;
    chk(!!SL && !!SL.buildCatalog, 'library.js 暴露 SongLibrary 接口');

    const p1 = SL.parseSongName('周华健 - 难念的经');
    chk(p1.artist === '周华健' && p1.title === '难念的经', '歌名解析「歌手 - 歌名」', p1.artist + '/' + p1.title);
    const p2 = SL.parseSongName('2Cellos,Robin Smith - Game of Thrones Medley.ncm');
    chk(p2.artist === '2Cellos,Robin Smith' && p2.title === 'Game of Thrones Medley', '多歌手解析', p2.artist);
    const p3 = SL.parseSongName('Despacito');
    chk(p3.artist === '未知歌手' && p3.title === 'Despacito', '没有「 - 」时归到未知歌手', p3.artist);
    chk(SL.stripCopySuffix('红豆 (1)') === '红豆' && SL.stripCopySuffix('难念的经 (Live版)') === '难念的经 (Live版)', '去掉重复下载的 (1) 后缀、保留 (Live版)');

    const G = () => Promise.resolve(null);
    const items = [
      { name: '周华健 - 难念的经.mp3', rel: 'CloudMusic/周华健 - 难念的经.mp3', getFile: G },
      { name: '周华健 - 难念的经.mp3', rel: 'CloudMusic/converted/周华健 - 难念的经.mp3', getFile: G },
      { name: '周华健 - 难念的经.lrc', rel: 'CloudMusic/周华健 - 难念的经.lrc', getFile: G },
      { name: '周华健 - 难念的经.vocals.mp3', rel: 'CloudMusic/vocals/周华健 - 难念的经.vocals.mp3', getFile: G },
      { name: '王菲 - 红豆.ncm', rel: 'CloudMusic/王菲 - 红豆.ncm', getFile: G },
      { name: '邓紫棋 - 光年之外.flac', rel: 'CloudMusic/邓紫棋 - 光年之外.flac', getFile: G },
      { name: '邓紫棋 - 光年之外.lrc', rel: 'CloudMusic/邓紫棋 - 光年之外.lrc', getFile: G }
    ];
    const cat = SL.buildCatalog(items);
    chk(cat.songs.length === 2, '同名副本合并成一条（跨文件夹）', cat.songs.length + ' 首');
    const z = cat.songs.find(s => s.title === '难念的经');
    chk(z && z.audio && z.vocals && z.lrc, '一份条目里同时配上 音频+人声版+歌词',
      z ? [z.audio.name, z.vocals.name, z.lrc.name].join(' | ') : '');
    chk(z && z.audio.name === '周华健 - 难念的经.mp3', '主音频优先选「歌词在旁边」的那份', z ? z.audio.name : '');
    chk(cat.ncmCount === 1, '.ncm 会统计成「未转换」提示', cat.ncmCount);
    chk(SL.filterCatalog(cat.songs, '周华健').length === 1, '按歌手搜索');
    chk(SL.filterCatalog(cat.songs, '难念').length === 1, '按歌名搜索');
    chk(SL.filterCatalog(cat.songs, '周华健 难念').length === 1, '多关键词搜索');
    chk(SL.filterCatalog(cat.songs, 'zzz不存在').length === 0, '搜不到就返回空');

    /* 回归：只有人声版的那条 + 只有完整版的那条，合并后必须两样都有（曾丢掉主音频） */
    const items2 = [
      { name: '徐佳莹 - 白旗.mp3', rel: 'CloudMusic/converted/徐佳莹 - 白旗.mp3', getFile: G },
      { name: '徐佳莹 - 白旗.vocals.mp3', rel: 'CloudMusic/vocals/徐佳莹 - 白旗.vocals.mp3', getFile: G },
      { name: '徐佳莹 - 白旗.no_vocals.mp3', rel: 'CloudMusic/vocals/徐佳莹 - 白旗.no_vocals.mp3', getFile: G },
      { name: '徐佳莹 - 白旗.lrc', rel: 'CloudMusic/徐佳莹 - 白旗.lrc', getFile: G }
    ];
    const c2 = SL.buildCatalog(items2);
    const s2 = c2.songs[0];
    chk(c2.songs.length === 1 && !!s2.audio && !!s2.vocals && !!s2.accomp && !!s2.lrc,
      '一条曲目同时拿到 音频+人声版+伴奏版+歌词（合并不能丢字段）',
      c2.songs.length + ' 条 / audio=' + (s2.audio ? '有' : '❌无') + ' vocals=' + (s2.vocals ? '有' : '❌无') +
      ' accomp=' + (s2.accomp ? '有' : '❌无') + ' lrc=' + (s2.lrc ? '有' : '❌无'));
    /* 本机真有音乐目录时，拿真实文件名跑一遍 */
    try {
      if (fs.existsSync('C:/CloudMusic')) {
        const scanDir = (dir, rel, out) => {
          for (const n of fs.readdirSync(dir)) {
            const p = path.join(dir, n);
            if (fs.statSync(p).isDirectory()) scanDir(p, rel + n + '/', out);
            else out.push({ name: n, rel: rel + n, getFile: G });
          }
        };
        const real = [];
        scanDir('C:/CloudMusic', '', real);
        const rc = SL.buildCatalog(real);
        chk(rc.songs.length > 500, '真实音乐目录扫描（C:\\CloudMusic）', real.length + ' 个文件 → ' + rc.songs.length + ' 首 / ' +
          new Set(rc.songs.map(s => s.artist)).size + ' 位歌手 / 带歌词 ' + rc.songs.filter(s => s.lrc).length);
        chk(rc.ncmCount > 0, '能识别未转换的 .ncm 数量', rc.ncmCount);
      } else {
        chk(true, '本机没有 C:\\CloudMusic，跳过真实目录测试');
      }
    } catch (e) { chk(false, '真实目录扫描不应报错', e.message); }
  }
  /* ---------- 结果 ---------- */
  console.log('\n' + '='.repeat(52));
  if (fail) {
    console.log('❌ 失败 ' + fail + ' 项：');
    fails.forEach(f => console.log('   · ' + f));
  }
  console.log((fail ? '⚠️' : '✅') + ' 通过 ' + pass + ' 项' + (fail ? '，失败 ' + fail + ' 项' : '，全部通过 🎉'));
  process.exitCode = fail ? 1 : 0;
})();