/* ============================================================
 * karaoke.js —— K歌练习：跟唱打分 + 音高线对比
 *   1) 内置曲库（公有领域旋律）合成引导音 → 算出「标准音高线」
 *   2) 麦克风实时检测你唱的 → 叠在同一条时间轴上
 *   3) 每个音比对中位数音高 → 逐音得分 + 总分
 *   4) 全程可导出 JSON（目标线 + 你的原始轨迹）
 * ============================================================ */
(function () {
  'use strict';

  var PT = window.PitchTool;
  var LIB = window.SONG_LIB || [];
  if (!PT || !LIB.length) { alert('pitch.js / songs.js 没加载成功'); return; }

  /* ---------- 小工具 ---------- */
  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }
  function median(a) {
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; });
    var m = s.length >> 1;
    return (s.length % 2) ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function num(v, d) { return Number(v).toFixed(d === undefined ? 1 : d); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function stamp() {
    var d = new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
           pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }
  function setStatus(m) { $('songInfo').innerHTML = m; }
  function scoreClass(s) { return s >= 85 ? 'ok' : (s >= 60 ? 'warn' : 'bad'); }

  var LS_SET = 'vpm.settings.v1';

  /* 提取旋律时的音高搜索范围：限制在人声基频区，伴奏里的贝斯/底鼓（<165Hz）直接被排除 */
  var VOCAL_PRESETS = [
    { id: 'male',   label: '男声（E3–C5，165–523Hz）', lo: 164.8, hi: 523.3 },
    { id: 'female', label: '女声（G3–E5，196–659Hz）', lo: 196.0, hi: 659.3 },
    { id: 'wide',   label: '很宽（E2–E5，82–659Hz）',  lo: 82.4,  hi: 659.3 }
  ];
  var LS_KARA = 'vpm.karaoke.v1';

  /* ---------- 状态 ---------- */
  var S = {
    /* 音频 */
    ctx: null, stream: null, micSource: null, analyser: null, buf: null, running: false,
    /* 设置 */
    a4: 440, rangeLow: 45, rangeHigh: 69,
    transpose: 0, speed: 1, guide: true, metro: true,
    /* 歌 */
    song: null, notes: [], totalMs: 0, sungMin: 0, sungMax: 0,
    /* 播放 */
    playing: false, mode: '', aT0: 0, t0Perf: 0, endAtPerf: 0, oscs: [], songPos: -9999,
    /* 采集 */
    samples: [], pitchHist: [], current: null, level: 0,
    lastAnalysis: 0, lastDraw: 0,
    /* 结果 */
    result: null,
    /* 自由练习 */
    freeRec: false, audioEl: null, audioUrl: null,
    refTrack: null, refSegs: null, refShiftOct: 0,
    lrc: null, _lyIdx: -1,
    vocalBand: true,         // 人声带通滤波（去贝斯/镲片），默认开
    vocalPreset: 'male'      // 音高搜索范围（排除贝斯/低音提琴等伴奏声部）
  };

  /* ============================================================
   * 启动
   * ============================================================ */
  function init() {
    loadSettings();
    buildSongList();
    buildVocalSelect();
    bindEvents();
    selectSong(LIB[0].id, true);
    updateRangeBadge();
    drawKara();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('这个浏览器不支持麦克风，或者页面不是 https / localhost。请用 Chrome / Edge / Safari。');
      $('startBtn').disabled = true;
    }
  }

  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(LS_SET) || '{}');
      if (s.a4 >= 415 && s.a4 <= 466) S.a4 = s.a4;
      if (s.rangeLow && s.rangeHigh && s.rangeHigh > s.rangeLow) {
        S.rangeLow = s.rangeLow; S.rangeHigh = s.rangeHigh;
      }
    } catch (e) {}
    try {
      var k = JSON.parse(localStorage.getItem(LS_KARA) || '{}');
      if (typeof k.speed === 'number' && k.speed > 0.3 && k.speed < 2) S.speed = k.speed;
      if (typeof k.guide === 'boolean') S.guide = k.guide;
      if (typeof k.metro === 'boolean') S.metro = k.metro;
      if (typeof k.transpose === 'number') S.transpose = k.transpose;
      if (typeof k.vocalBand === 'boolean') S.vocalBand = k.vocalBand;
      if (k.vocalPreset) S.vocalPreset = k.vocalPreset;
    } catch (e) {}
    $('speedSel').value = String(S.speed);
    $('guideChk').checked = S.guide;
    $('metroChk').checked = S.metro;
  }

  function saveSettings() {
    try {
      localStorage.setItem(LS_KARA, JSON.stringify({
        speed: S.speed, guide: S.guide, metro: S.metro, transpose: S.transpose,
        vocalBand: S.vocalBand, vocalPreset: S.vocalPreset
      }));
    } catch (e) {}
  }

  function updateRangeBadge() {
    var lo = PT.describeMidi(S.rangeLow, S.a4, S.useFlat !== undefined ? S.useFlat : false);
    var hi = PT.describeMidi(S.rangeHigh, S.a4, false);
    $('rangeBadge').innerHTML = '我的音域：<b>' + lo.solfege + lo.octave + '</b> ' + num(lo.freq, 1) + ' Hz ~ <b>' +
      hi.solfege + hi.octave + '</b> ' + num(hi.freq, 1) + ' Hz （在主页①里改）';
  }

  function buildVocalSelect() {
    var sel = $('vocalSel');
    sel.innerHTML = '';
    VOCAL_PRESETS.forEach(function (p) {
      var op = document.createElement('option');
      op.value = p.id;
      op.textContent = p.label;
      sel.appendChild(op);
    });
    sel.value = S.vocalPreset;
    $('vocalBandChk').checked = S.vocalBand;
  }

  function buildSongList() {
    var sel = $('songSel');
    sel.innerHTML = '';
    LIB.forEach(function (s) {
      var op = document.createElement('option');
      op.value = s.id;
      op.textContent = s.title + '（' + s.tag + '）';
      sel.appendChild(op);
    });
  }

  /* ============================================================
   * 选歌 / 时间轴 / 移调
   * ============================================================ */
  function selectSong(id, keepTranspose) {
    var song = null;
    LIB.forEach(function (s) { if (s.id === id) song = s; });
    if (!song) song = LIB[0];
    S.song = song;
    $('songSel').value = song.id;
    S.notes = parseMelody(song.melody);
    S.totalMs = S.notes.length ? S.notes[S.notes.length - 1].endMs : 0;
    if (!keepTranspose) {
      autoFit();
    } else {
      applyTranspose();
    }
    updateSongInfo();
    drawKara();
    updateHUD();
  }

  function parseMelody(str) {
    var toks = String(str).trim().split(/\s+/);
    var t = 0, out = [];
    toks.forEach(function (tok) {
      var p = tok.split(':');
      var name = p[0];
      var beats = p.length > 1 ? parseFloat(p[1]) : 1;
      var spb = 60 / (S.song ? S.song.bpm : 100) / S.speed;   // 秒/拍
      var dur = beats * spb * 1000;
      if (name !== 'R' && dur > 60) {
        var id = PT.midiFromName(name);
        out.push({
          name: name, beats: beats, startMs: t, endMs: t + dur,
          midi0: id, midi: id, durMs: dur
        });
      } else if (name === 'R' && dur > 30) {
        out.push({ name: 'R', beats: beats, startMs: t, endMs: t + dur, midi0: null, midi: null, durMs: dur });
      }
      t += dur;
    });
    return out;
  }

  function rebuildTimeline() {          // 改速度后重新算时间
    var song = S.song;
    S.notes = parseMelody(song.melody);
    S.totalMs = S.notes.length ? S.notes[S.notes.length - 1].endMs : 0;
    applyTranspose();
    updateSongInfo();
    drawKara();
  }

  function applyTranspose() {
    var lo = Infinity, hi = -Infinity;
    S.notes.forEach(function (n) {
      if (n.midi0 === null) { n.midi = null; return; }
      n.midi = n.midi0 + S.transpose;
      if (n.midi < lo) lo = n.midi;
      if (n.midi > hi) hi = n.midi;
      n.sol = PT.describeMidi(n.midi, S.a4, false).solfege;
      n.freq = PT.midiToFreq(n.midi, S.a4);
    });
    S.sungMin = isFinite(lo) ? lo : 0;
    S.sungMax = isFinite(hi) ? hi : 0;
    $('trVal').textContent = (S.transpose > 0 ? '+' : '') + S.transpose;
    updateSongInfo();
  }

  /** 自动挑一个移调量：优先整八度（保住原调），再看能否塞进音域，最后看离原调近不近 */
  function autoFit() {
    var lo = Infinity, hi = -Infinity;
    S.notes.forEach(function (n) {
      if (n.midi0 === null) return;
      if (n.midi0 < lo) lo = n.midi0;
      if (n.midi0 > hi) hi = n.midi0;
    });
    if (!isFinite(lo)) { S.transpose = 0; applyTranspose(); return null; }
    var best = null;
    for (var s = -24; s <= 12; s++) {
      var a = lo + s, b = hi + s;
      var overflow = Math.max(0, S.rangeLow - a) + Math.max(0, b - S.rangeHigh);
      var cand = { s: s, overflow: overflow, octave: (s % 12 === 0) ? 0 : 1, dist: Math.abs(s) };
      if (!best) { best = cand; continue; }
      if (cand.overflow !== best.overflow) { if (cand.overflow < best.overflow) best = cand; continue; }
      if (cand.octave !== best.octave) { if (cand.octave < best.octave) best = cand; continue; }
      if (cand.dist < best.dist) best = cand;
    }
    S.transpose = best.s;
    applyTranspose();
    saveSettings();
    return best;
  }

  function updateSongInfo() {
    if (!S.song) return;
    var loTxt = S.sungMin ? PT.describeMidi(S.sungMin, S.a4, false) : null;
    var hiTxt = S.sungMax ? PT.describeMidi(S.sungMax, S.a4, false) : null;
    var outOf = (S.sungMin < S.rangeLow || S.sungMax > S.rangeHigh);
    var secs = (S.totalMs / 1000).toFixed(1);
    setStatus(
      '<b>' + S.song.title + '</b> · ' + S.song.bpm + ' BPM · 约 ' + secs + ' 秒 · 移调 <b>' +
      (S.transpose > 0 ? '+' : '') + S.transpose + '</b> 个半音 · 唱到的音域 <b>' +
      (loTxt ? loTxt.solfege + loTxt.octave + ' ~ ' + hiTxt.solfege + hiTxt.octave : '—') + '</b>（' +
      (isFinite(S.sungMin) && S.sungMin ? num(PT.midiToFreq(S.sungMin, S.a4), 0) + '~' + num(PT.midiToFreq(S.sungMax, S.a4), 0) + ' Hz' : '—') + '）' +
      '<br>' + (S.song.tip || '') +
      (outOf ? '<br>⚠️ 这个调超出了你的音域，点「🎯 自动适配我的音域」。' : '')
    );
  }

  /* ============================================================
   * 音频：合成引导旋律 / 节拍器
   * ============================================================ */
  function ensureCtx() {
    if (!S.ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      S.ctx = new AC();
    }
    return S.ctx;
  }

  function scheduleTone(ctx, freq, t0, dur, vol, type) {
    var osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = type || 'triangle';
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.03);
    g.gain.setValueAtTime(vol, t0 + Math.max(0.06, dur - 0.09));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
    return osc;
  }

  function stopAudio() {
    S.oscs.forEach(function (o) { try { o.stop(); } catch (e) {} });
    S.oscs = [];
    S.playing = false;
    $('startBtn').disabled = false;
    $('demoBtn').disabled = false;
    $('stopBtn').disabled = true;
  }

  function playSequence(mode) {
    stopAudio();
    var ctx = ensureCtx();
    if (ctx.state === 'suspended') ctx.resume();
    var spb = 60 / (S.song.bpm * S.speed);
    var leadIn = mode === 'sing' ? (S.metro ? Math.max(2.0, spb * 4) : 1.2) : 0.6;
    var aT0 = ctx.currentTime + leadIn;
    S.aT0 = aT0;
    S.t0Perf = performance.now() + leadIn * 1000;
    S.mode = mode;
    S.playing = true;
    S.songPos = -leadIn * 1000;
    if (mode === 'sing') { S.samples = []; S.pitchHist = []; S.result = null; renderResult(); }

    /* 引导旋律 */
    if (S.guide) {
      S.notes.forEach(function (n) {
        if (n.midi === null) return;
        var f = PT.midiToFreq(n.midi, S.a4);
        var t0 = aT0 + n.startMs / 1000 + 0.02;
        var dur = Math.max(0.14, n.durMs / 1000 - 0.07);
        S.oscs.push(scheduleTone(ctx, f, t0, dur, 0.15, 'triangle'));
      });
    }
    /* 节拍器 + 起拍 */
    if (S.metro) {
      var nBeats = Math.floor(S.totalMs / (spb * 1000)) + 1;
      for (var b = 0; b < nBeats; b++) {
        S.oscs.push(scheduleTone(ctx, b % 4 === 0 ? 1600 : 1050, aT0 + b * spb, 0.05, 0.09, 'square'));
      }
      for (var k = 0; k < 4; k++) {
        S.oscs.push(scheduleTone(ctx, k === 3 ? 1600 : 1050, aT0 - (4 - k) * spb, 0.05, 0.09, 'square'));
      }
    }
    S.endAtPerf = S.t0Perf + S.totalMs + 350;
    $('startBtn').disabled = true;
    $('demoBtn').disabled = true;
    $('stopBtn').disabled = false;
    setStatus(mode === 'sing'
      ? (S.metro ? '🎤 数 4 拍就开始唱！' : '🎤 准备…开始唱！')
      : '▶ 正在播放标准旋律，先听一遍。');
  }

  /* ============================================================
   * 麦克风 & 分析
   * ============================================================ */
  function ensureMic() {
    if (S.running) return Promise.resolve();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('浏览器不支持麦克风'));
    }
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
    }).then(function (stream) {
      S.stream = stream;
      var ctx = ensureCtx();
      var go = function () {
        S.ctx.resume && S.ctx.resume();
        S.micSource = ctx.createMediaStreamSource(stream);
        S.analyser = ctx.createAnalyser();
        S.analyser.fftSize = 4096;
        S.buf = new Float32Array(4096);
        S.micSource.connect(S.analyser);
        S.running = true;
        requestAnimationFrame(loop);
      };
      if (ctx.state === 'suspended') { return ctx.resume().then(go); }
      go();
    });
  }

  function computeRms(buf) {
    var s = 0;
    for (var i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  }

  function loop(ts) {
    if (!S.running) return;
    requestAnimationFrame(loop);
    if (!ts) ts = performance.now();
    if (ts - S.lastDraw < 33) return;
    S.lastDraw = ts;
    if (ts - S.lastAnalysis >= 60) { S.lastAnalysis = ts; analyze(ts); }

    var now = performance.now();
    if (S.playing) {
      S.songPos = now - S.t0Perf;
      if (now > S.endAtPerf) {
        if (S.mode === 'sing') { finishSing(); }
        else { stopAudio(); S.songPos = S.totalMs; setStatus('播放完了，点「🎤 开始跟唱打分」换你来唱。'); }
      }
    } else if (S.freeRec) {
      if (S.audioEl && !S.audioEl.paused) {
        var aMs = S.audioEl.currentTime * 1000;
        var pMs = now - S.t0Perf;
        if (Math.abs(aMs - pMs) > 100) S.t0Perf = now - aMs;   // 和音频播放位置重新对齐
        S.songPos = aMs;
        if (S.refTrack && S.refTrack.length && S.samples.length > 40 && now - (S._lastShiftAt || 0) > 1500) {
          S._lastShiftAt = now;
          S.refShiftOct = refOctShift();                        // 随时把参考线挪到你的八度
        }
        updateLyrics(S.songPos);
      } else {
        S.songPos = now - S.t0Perf;
      }
    }
    drawKara();
    updateHUD();
  }

  function analyze(ts) {
    S.analyser.getFloatTimeDomainData(S.buf);
    var rms = computeRms(S.buf);
    S.level = rms;
    var detected = null;
    if (rms >= 0.003) {
      var res = PT.detectPitch(S.buf, S.ctx.sampleRate, { minFreq: 65, maxFreq: 1300, threshold: 0.15 });
      if (res.freq > 0 && res.confidence > 0.4) detected = res;
    }
    if (detected) S.pitchHist.push({ f: detected.freq, conf: detected.confidence, t: ts });
    var cutoff = ts - 400;
    S.pitchHist = S.pitchHist.filter(function (p) { return p.t >= cutoff; });

    var cur = null;
    if (S.pitchHist.length && rms >= 0.002) {
      var freqs = S.pitchHist.map(function (p) { return p.f; }).sort(function (a, b) { return a - b; });
      var med = freqs[Math.floor(freqs.length / 2)];
      var near = S.pitchHist.filter(function (p) { return Math.abs(1200 * Math.log2(p.f / med)) < 60; });
      if (near.length) {
        var sf = 0, sc = 0;
        near.forEach(function (p) { sf += p.f; sc += p.conf; });
        var f = sf / near.length;
        cur = { freq: f, conf: sc / near.length, midi: PT.freqToMidi(f, S.a4), rms: rms };
        cur.note = PT.describeMidi(cur.midi, S.a4, false);
      }
    }
    S.current = cur;

    /* 采点：跟唱模式 / 自由模式才记录 */
    if (cur && (S.mode === 'sing' && S.playing || S.freeRec)) {
      var t = ts - S.t0Perf;
      S.samples.push({ t: t, f: +cur.freq.toFixed(2) });
      if (S.samples.length > 20000) S.samples.splice(0, 4000);
    }
  }

  function finishSing() {
    stopAudio();
    S.songPos = S.totalMs;
    scoreAll();
    renderResult();
    drawKara();
    updateHUD();
    setStatus(scoreMsg());
  }

  function scoreMsg() {
    if (!S.result) return '';
    var r = S.result;
    if (!r.sungCount) return '😅 这一遍没采到多少声音：靠近麦克风、或者先把「播放引导旋律」关掉只留节拍器试试。';
    return '✅ 唱完了：总分 <b>' + r.total + '</b>，平均偏差 ' + num(r.avgAbs, 1) + ' 音分，命中 ' + r.sungCount + '/' + r.rows.length + ' 个音。'
      + ' 分最低的是 <b>' + r.worst.name + '</b>（' + num(r.worst.cents, 0) + ' 音分），回去单独练它。';
  }
  /* ============================================================
   * 画图：歌的标准音高线 + 你唱的线
   * ============================================================ */
  function targetAt(t) {
    for (var i = 0; i < S.notes.length; i++) {
      var n = S.notes[i];
      if (t >= n.startMs && t < n.endMs) return n;
    }
    return null;
  }

  function drawKara() {
    var cv = $('karaChart');
    if (!cv) return;
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth || 700, h = cv.clientHeight || 320;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var padL = 56, padR = 14, padT = 18, padB = 24;
    var plotW = Math.max(50, w - padL - padR), plotH = Math.max(50, h - padT - padB);
    var hasSamples = S.samples.length > 0;

    if (!S.notes.length && !hasSamples) {
      ctx.fillStyle = '#4b5b7d';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('选一首歌，点「▶ 先听一遍」看标准音高线，再点「🎤 开始跟唱打分」', w / 2, h / 2);
      return;
    }

    /* 纵轴范围：目标音 + 你唱的音 + 音域 */
    var lo = Infinity, hi = -Infinity;
    S.notes.forEach(function (n) {
      if (n.midi === null) return;
      if (n.midi < lo) lo = n.midi;
      if (n.midi > hi) hi = n.midi;
    });
    S.samples.forEach(function (s) {
      var m = PT.freqToMidi(s.f, S.a4);
      if (m < lo) lo = m;
      if (m > hi) hi = m;
    });
    if (S.refTrack && S.refTrack.length) {
      S.refTrack.forEach(function (p) {
        var m = PT.freqToMidi(p.f, S.a4) + (S.refShiftOct || 0);
        if (m < lo) lo = m;
        if (m > hi) hi = m;
      });
    }
    if (!isFinite(lo)) { lo = 60; hi = 72; }
    lo = Math.floor(lo) - 1; hi = Math.ceil(hi) + 1;
    if (isFinite(S.rangeLow) && S.rangeLow - 1 < lo) lo = S.rangeLow - 1;
    if (isFinite(S.rangeHigh) && S.rangeHigh + 1 > hi) hi = S.rangeHigh + 1;
    if (hi - lo < 8) { var c = (lo + hi) / 2; lo = c - 4; hi = c + 4; }

    var lastT = hasSamples ? S.samples[S.samples.length - 1].t : 0;
    if (S.refTrack && S.refTrack.length) lastT = Math.max(lastT, S.refTrack[S.refTrack.length - 1].t);
    var dur = Math.max(800, S.totalMs, lastT);
    function X(t) { return padL + clamp(t / dur, 0, 1) * plotW; }
    function Y(m) { return padT + (hi - m) / (hi - lo) * plotH; }

    /* 半音横线 + 唱名 */
    var MAJ = [0, 2, 4, 5, 7, 9, 11];
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var m = Math.ceil(lo); m <= Math.floor(hi); m++) {
      var info = PT.describeMidi(m, S.a4, false);
      var major = MAJ.indexOf(info.pc) >= 0;
      var out = (m < S.rangeLow || m > S.rangeHigh);
      ctx.strokeStyle = major ? 'rgba(148,163,184,.22)' : 'rgba(148,163,184,.08)';
      ctx.beginPath(); ctx.moveTo(padL, Y(m)); ctx.lineTo(padL + plotW, Y(m)); ctx.stroke();
      ctx.fillStyle = out ? '#4a5875' : (major ? '#8fa0c0' : '#44526e');
      ctx.fillText(info.solfege + info.octave, padL - 5, Y(m));
    }

    /* 音域带 */
    if (isFinite(S.rangeLow) && isFinite(S.rangeHigh)) {
      var bHi = Y(Math.min(hi, S.rangeHigh + 0.5)), bLo = Y(Math.max(lo, S.rangeLow - 0.5));
      if (bLo > bHi) {
        ctx.fillStyle = 'rgba(96,165,250,.07)';
        ctx.fillRect(padL, bHi, plotW, bLo - bHi);
      }
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(96,165,250,.45)';
      ctx.beginPath(); ctx.moveTo(padL, Y(S.rangeHigh)); ctx.lineTo(padL + plotW, Y(S.rangeHigh)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(padL, Y(S.rangeLow)); ctx.lineTo(padL + plotW, Y(S.rangeLow)); ctx.stroke();
      ctx.setLineDash([]);
    }

    /* 目标阶梯线（灰蓝） */
    ctx.lineCap = 'round';
    S.notes.forEach(function (n) {
      if (n.midi === null) return;
      var x0 = X(n.startMs), x1 = X(n.endMs);
      if (x1 - x0 < 0.6) return;
      var y = Y(n.midi);
      var active = S.songPos >= n.startMs && S.songPos < n.endMs;
      ctx.strokeStyle = active ? 'rgba(147,197,253,.95)' : 'rgba(130,150,190,.55)';
      ctx.lineWidth = active ? 9 : 6;
      ctx.beginPath(); ctx.moveTo(x0 + 1, y); ctx.lineTo(Math.max(x0 + 2, x1 - 1), y); ctx.stroke();
      if (x1 - x0 > 26) {
        var ni = PT.describeMidi(n.midi, S.a4, false);
        ctx.fillStyle = active ? '#dbeafe' : '#7b8aad';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(ni.solfege + ni.octave, (x0 + x1) / 2, y - 6);
      }
    });

    /* 你唱的线（彩色，颜色 = 相对当时目标音的偏差） */
    var prev = null;
    for (var i = 0; i < S.samples.length; i++) {
      var s = S.samples[i];
      var x = X(s.t), y = Y(PT.freqToMidi(s.f, S.a4));
      var color = '#60a5fa';
      var tg = targetAt(s.t);
      if (tg && tg.midi !== null) {
        var off = Math.abs((PT.freqToMidi(s.f, S.a4) - tg.midi) * 100);
        color = off <= 25 ? '#4ade80' : (off <= 50 ? '#fbbf24' : '#f87171');
      }
      var broken = !prev || (s.t - prev.t) > 700;
      if (!broken) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(x, y); ctx.stroke();
      } else {
        /* 断点/起笔：画个小圆点，让独点也看得见 */
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
      }
      prev = { x: x, y: y, t: s.t };
    }
    if (prev) {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(prev.x, prev.y, 2.6, 0, Math.PI * 2); ctx.fill();
    }

    /* 从本地音频里估出来的主旋律线：连续阶梯线（同一音横向、换音竖线），静音处断开 */
    if (S.refTrack && S.refTrack.length) {
      var rShift = S.refShiftOct || 0;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'butt';
      /* (a) 真有检测到人声的段落：实线 */
      ctx.strokeStyle = 'rgba(134,239,172,.9)';
      ctx.lineWidth = 2.4;
      var started2 = false, prevQ = null, prevY = 0;
      function drawSeg(detectedOnly) {
        ctx.beginPath();
        started2 = false; prevQ = null; prevY = 0;
        for (var r2 = 0; r2 < S.refTrack.length; r2++) {
          var rp = S.refTrack[r2];
          if (rp.t > dur + 200) break;
          if (rp.q === undefined || rp.gap || (detectedOnly ? !rp.detected : rp.detected)) {
            if (started2) { ctx.stroke(); started2 = false; prevQ = null; }
            continue;
          }
          var ry = Y(rp.q + rShift);
          if (!started2) { ctx.beginPath(); ctx.moveTo(X(rp.t), ry); started2 = true; }
          else if (rp.q !== prevQ) { ctx.lineTo(X(rp.t), prevY); ctx.lineTo(X(rp.t), ry); }
          else { ctx.lineTo(X(rp.t), ry); }
          prevQ = rp.q; prevY = ry;
        }
        if (started2) ctx.stroke();
      }
      drawSeg(true);
      /* (b) 没有真检测、由 Viterbi 推出来的段落：细虚线（提示"这段是估的"） */
      ctx.save();
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = 'rgba(134,239,172,.40)';
      ctx.lineWidth = 1.5;
      drawSeg(false);
      ctx.restore();
      ctx.fillStyle = 'rgba(134,239,172,.9)';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('灰绿阶梯线 = 从音频估的旋律（参考）', padL + 6, padT + plotH - 12);
    }

    /* 播放头 */
    if (S.mode) {
      var px = X(clamp(S.songPos, 0, dur));
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT + plotH); ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('▶ ' + Math.max(0, S.songPos / 1000).toFixed(1) + 's', px + 4, padT + 1);
    }
    ctx.fillStyle = '#64748b';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText('共 ' + (dur / 1000).toFixed(1) + ' 秒', padL + plotW, padT + 1);
  }

  /* ---------- 实时提示 ---------- */
  function updateHUD() {
    var tg = S.playing ? targetAt(S.songPos) : null;
    if (tg && tg.midi !== null) {
      var ti = PT.describeMidi(tg.midi, S.a4, false);
      $('hudTarget').innerHTML = ti.solfege + ti.octave + ' <small>' + num(PT.midiToFreq(tg.midi, S.a4), 1) + 'Hz</small>';
    } else if (tg && tg.midi === null) {
      $('hudTarget').innerHTML = '<small>休止 / 换气</small>';
    } else if (S.playing) {
      $('hudTarget').innerHTML = '<small>准备…</small>';
    } else {
      $('hudTarget').textContent = '--';
    }

    if (S.current && S.current.note) {
      var n = S.current.note;
      var txt = n.solfege + n.octave + ' <small>' + num(S.current.freq, 1) + 'Hz</small>';
      var cls = '';
      var cents = 0;
      if (tg && tg.midi !== null) {
        cents = (S.current.midi - tg.midi) * 100;
        cls = Math.abs(cents) <= 25 ? 'ok' : (Math.abs(cents) <= 50 ? 'warn' : 'bad');
        $('hudCents').innerHTML = (cents >= 0 ? '+' : '') + cents.toFixed(0) + ' <small>音分</small>';
        $('hudCents').className = 'v v-' + cls;
      } else {
        $('hudCents').textContent = '--';
      }
      $('hudYou').innerHTML = txt;
      $('hudYou').className = 'v ' + (cls ? 'v-' + cls : '');
    } else {
      $('hudYou').textContent = S.running ? '…' : '--';
      $('hudCents').textContent = '--';
    }

    /* 本音实时得分 */
    if (tg && tg.midi !== null) {
      var r = noteScore(S.samples, tg);
      if (r) {
        $('hudScore').innerHTML = '<b class="v-' + scoreClass(r.score) + '">' + r.score + '</b> <small>' +
          (r.cents >= 0 ? '+' : '') + r.cents.toFixed(0) + '音分</small>';
      } else {
        $('hudScore').innerHTML = '<small>等你唱…</small>';
      }
    } else {
      $('hudScore').textContent = '--';
    }

    var pct = S.totalMs ? clamp(S.songPos / S.totalMs * 100, 0, 100) : 0;
    $('hudProg').innerHTML = S.songPos > -9000
      ? (S.songPos < 0 ? '起拍…' : pct.toFixed(0) + '%')
      : '--';
  }

  /* ============================================================
   * 打分
   * ============================================================ */
  function noteScore(samples, n) {
    var t0 = n.startMs + 50;
    var t1 = Math.max(t0 + 80, n.endMs - 60);
    var vals = [];
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      if (s.t >= t0 && s.t <= t1) vals.push(PT.freqToMidi(s.f, S.a4));
    }
    if (!vals.length) return null;
    var med = median(vals);
    var cents = (med - n.midi) * 100;
    return {
      med: med, cents: cents, samples: vals.length,
      score: Math.max(0, Math.min(100, Math.round(100 - Math.abs(cents) * 1.2)))
    };
  }

  function scoreAll() {
    var rows = [];
    S.notes.forEach(function (n, i) {
      if (n.midi === null) return;
      var r = noteScore(S.samples, n);
      var ni = PT.describeMidi(n.midi, S.a4, false);
      rows.push({
        index: rows.length + 1,
        name: n.name,
        targetSol: ni.solfege + ni.octave,
        targetMidi: n.midi,
        targetFreq: PT.midiToFreq(n.midi, S.a4),
        startMs: n.startMs, endMs: n.endMs,
        medMidi: r ? r.med : null,
        cents: r ? r.cents : null,
        samples: r ? r.samples : 0,
        score: r ? r.score : 0
      });
    });
    var sung = rows.filter(function (r) { return r.cents !== null; });
    var total = rows.length ? Math.round(mean(rows.map(function (r) { return r.score; }))) : 0;
    var worst = null;
    rows.forEach(function (r) { if (!worst || r.score < worst.score) worst = r; });
    S.result = {
      rows: rows,
      total: total,
      sungCount: sung.length,
      coverage: rows.length ? sung.length / rows.length * 100 : 0,
      avgAbs: sung.length ? mean(sung.map(function (r) { return Math.abs(r.cents); })) : 0,
      bias: sung.length ? mean(sung.map(function (r) { return r.cents; })) : 0,
      in50: sung.length ? sung.filter(function (r) { return Math.abs(r.cents) <= 50; }).length / sung.length * 100 : 0,
      worst: worst
    };
    return S.result;
  }

  function renderResult() {
    var r = S.result;
    var body = $('resultBody');
    if (!r || !r.rows.length) {
      body.innerHTML = '<tr><td colspan="6" class="muted center">还没有成绩，先唱一遍</td></tr>';
      $('resultSummary').innerHTML = '';
      $('resultHint').textContent = '';
      return;
    }
    var c1 = r.total >= 85 ? 's1' : (r.total >= 60 ? 's2' : 's3');
    var biasTxt = r.bias >= 0 ? '整体偏高' : '整体偏低';
    var cards = [
      { k: '总分', v: '<span class="score-big ' + c1 + '">' + r.total + '</span>', cls: '' },
      { k: '平均|偏差|', v: num(r.avgAbs, 1) + ' 音分', cls: scoreClass(100 - Math.abs(r.avgAbs) * 1.2) },
      { k: '唱到的音', v: r.sungCount + ' / ' + r.rows.length + '（' + r.coverage.toFixed(0) + '%）', cls: r.coverage >= 90 ? 'good' : (r.coverage >= 60 ? 'warn' : 'bad') },
      { k: '±50 音分内', v: r.in50.toFixed(0) + '%', cls: r.in50 >= 85 ? 'good' : (r.in50 >= 60 ? 'warn' : 'bad') },
      { k: '偏高/偏低倾向', v: biasTxt + ' ' + num(Math.abs(r.bias), 0) + ' 音分', cls: Math.abs(r.bias) <= 15 ? 'good' : (Math.abs(r.bias) <= 30 ? 'warn' : 'bad') },
      { k: '最该练的音', v: r.worst ? (r.worst.targetSol + '（' + r.worst.score + ' 分）') : '—', cls: 'bad' }
    ];
    $('resultSummary').innerHTML = cards.map(function (c) {
      return '<div class="sum-item"><span class="k">' + c.k + '</span><span class="v ' + c.cls + '">' + c.v + '</span></div>';
    }).join('');

    body.innerHTML = r.rows.map(function (row) {
      var cls = scoreClass(row.score);
      var color = cls === 'ok' ? '#4ade80' : (cls === 'warn' ? '#fbbf24' : '#f87171');
      var you = row.medMidi === null ? '<span class="muted">没唱到</span>'
        : (function () { var ni = PT.describeMidi(row.medMidi, S.a4, false); return ni.solfege + ni.octave; })();
      var centsTxt = row.cents === null ? '—' : ((row.cents >= 0 ? '+' : '') + row.cents.toFixed(0));
      return '<tr>' +
        '<td>' + row.index + '</td>' +
        '<td><span class="note-pill">' + row.targetSol + '</span></td>' +
        '<td>' + you + '</td>' +
        '<td class="v-' + cls + '">' + centsTxt + '</td>' +
        '<td><b class="v-' + cls + '">' + row.score + '</b></td>' +
        '<td><span class="score-bar"><i style="width:' + row.score + '%;background:' + color + '"></i></span></td>' +
      '</tr>';
    }).join('');

    $('resultHint').innerHTML = '单音得分 = 100 − |偏差音分|×1.2（0 音分 = 100 分，50 音分 = 40 分，83 音分以上 = 0 分）；总分 = 每个音得分的平均，<b>漏唱记 0 分</b>。' +
      (Math.abs(r.bias) > 15 ? ' 你这一遍<b>' + biasTxt + '</b>，唱之前先在心里"预听"一下音高，或者把移调再往下调 1~2 个半音试试。' : '');
  }

  /* ============================================================
   * 导出
   * ============================================================ */
  function buildExport() {
    var targets = S.notes.filter(function (n) { return n.midi !== null; }).map(function (n) {
      var ni = PT.describeMidi(n.midi, S.a4, false);
      return {
        name: n.name, startMs: Math.round(n.startMs), endMs: Math.round(n.endMs),
        midi: n.midi, solfege: ni.solfege + ni.octave, freq: +PT.midiToFreq(n.midi, S.a4).toFixed(2)
      };
    });
    var points = S.samples.map(function (s) {
      var midi = PT.freqToMidi(s.f, S.a4);
      var tg = targetAt(s.t);
      return {
        t: Math.round(s.t), f: s.f, midi: +midi.toFixed(3),
        cents: +( (midi - Math.round(midi)) * 100 ).toFixed(1),
        targetMidi: tg && tg.midi !== null ? tg.midi : null,
        centsVsTarget: tg && tg.midi !== null ? +((midi - tg.midi) * 100).toFixed(1) : null
      };
    });
    return {
      app: 'vocal-pitch-monitor-karaoke',
      version: 1,
      createdAt: new Date().toISOString(),
      song: S.song ? { id: S.song.id, title: S.song.title, tag: S.song.tag, bpm: S.song.bpm } : null,
      a4: S.a4, transpose: S.transpose, speed: S.speed,
      guideMelody: S.guide, metronome: S.metro,
      myRange: { low: S.rangeLow, high: S.rangeHigh },
      summary: S.result ? {
        total: S.result.total, avgAbsCents: +S.result.avgAbs.toFixed(1),
        biasCents: +S.result.bias.toFixed(1), in50Percent: +S.result.in50.toFixed(1),
        sungNotes: S.result.sungCount, totalNotes: S.result.rows.length
      } : null,
      perNote: S.result ? S.result.rows.map(function (r) {
        return {
          index: r.index, targetSolfege: r.targetSol, targetMidi: r.targetMidi,
          yourMidi: r.medMidi === null ? null : +r.medMidi.toFixed(3),
          cents: r.cents === null ? null : +r.cents.toFixed(1),
          samples: r.samples, score: r.score
        };
      }) : [],
      fields: { t: '相对开始的毫秒', f: '检测到的频率Hz', midi: 'MIDI音号(69=la4=440Hz)', centsVsTarget: '相对该时刻目标音的偏差音分' },
      targets: targets,
      points: points
    };
  }

  function downloadFile(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'application/json') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function exportJSON() {
    if (!S.samples.length) { setStatus('还没有录音数据，先唱一遍。'); return; }
    var d = buildExport();
    downloadFile('karaoke-' + (S.song ? S.song.id : 'free') + '-' + stamp() + '.json', JSON.stringify(d, null, 2), 'application/json');
    setStatus('已导出 JSON（含目标音高线 + 你的原始轨迹），发给我我就能逐音分析。');
  }

  function exportCSV() {
    if (!S.samples.length) { setStatus('还没有录音数据，先唱一遍。'); return; }
    var rows = ['time_s,freq_hz,midi,cents_vs_nearest,cents_vs_target,note'];
    S.samples.forEach(function (s) {
      var midi = PT.freqToMidi(s.f, S.a4);
      var ni = PT.describeMidi(midi, S.a4, false);
      var tg = targetAt(s.t);
      rows.push([
        (s.t / 1000).toFixed(2), s.f.toFixed(2), midi.toFixed(3),
        ((midi - Math.round(midi)) * 100).toFixed(1),
        tg && tg.midi !== null ? ((midi - tg.midi) * 100).toFixed(1) : '',
        ni.letterName
      ].join(','));
    });
    downloadFile('karaoke-' + stamp() + '.csv', '\ufeff' + rows.join('\n'), 'text/csv');
    setStatus('已导出 CSV。');
  }

  /* ============================================================
   * 自由练习：上传自己的音频
   * ============================================================ */
  /** 解析 .lrc 歌词（[mm:ss.xx] 时间标签） */
  function parseLRC(text) {
    var out = [];
    String(text).split(/\r?\n/).forEach(function (line) {
      var tags = line.match(/\[\d+:\d+(?:\.\d+)?\]/g);
      if (!tags) return;
      var body = line.replace(/\[[^\]]*\]/g, '').trim();
      tags.forEach(function (tag) {
        var p = tag.match(/\[(\d+):(\d+(?:\.\d+)?)\]/);
        if (p) out.push({ t: (+p[1]) * 60000 + parseFloat(p[2]) * 1000, text: body });
      });
    });
    out.sort(function (a, b) { return a.t - b.t; });
    return out.filter(function (l, i) { return l.text || (i > 0 && out[i - 1].text); });
  }

  function baseName(n) { return String(n).replace(/\.[^.]+$/, ''); }

  /** 读文本：先按 UTF-8 严格解，失败再试 GBK（有些歌词是 GBK） */
  function readTextSmart(file) {
    return new Promise(function (resolve) {
      var fr = new FileReader();
      fr.onload = function () {
        var buf = fr.result, txt;
        try { txt = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
        catch (e1) {
          try { txt = new TextDecoder('gbk').decode(buf); }
          catch (e2) { txt = new TextDecoder('utf-8').decode(buf); }
        }
        resolve(txt);
      };
      fr.onerror = function () { resolve(''); };
      fr.readAsArrayBuffer(file);
    });
  }

  function updateLyrics(t) {
    var box = $('lyrics');
    if (!$('lrcChk').checked || !S.lrc || !S.lrc.length) { if (S._lyIdx !== -2) { box.innerHTML = ''; S._lyIdx = -2; } return; }
    var idx = -1;
    for (var i = 0; i < S.lrc.length; i++) { if (S.lrc[i].t <= t) idx = i; else break; }
    if (idx === S._lyIdx) return;
    S._lyIdx = idx;
    var from = Math.max(0, idx - 2), to = Math.min(S.lrc.length - 1, idx + 3);
    var html = '';
    for (var k = from; k <= to; k++) {
      html += '<div class="ly-line' + (k === idx ? ' ly-on' : '') + '">' + (S.lrc[k].text || '♪') + '</div>';
    }
    box.innerHTML = html;
  }

  function onFilePicked(e) {
    var list = e.target.files ? Array.prototype.slice.call(e.target.files) : [];
    var f = null, lrcFile = null, audioList = [];
    list.forEach(function (x) {
      if (/\.lrc$/i.test(x.name)) { if (!lrcFile) lrcFile = x; }
      else if (!f) { f = x; audioList.push(x); }
      else audioList.push(x);
    });
    if (!f) { if (lrcFile) { $('freeResult').textContent = '只选了歌词文件，还要再选一个音频文件（mp3/m4a/wav/flac）。'; } return; }
    if (!lrcFile && audioList.length > 1) {
      for (var q = 1; q < audioList.length; q++) {
        if (/\.lrc$/i.test(audioList[q].name)) { lrcFile = audioList[q]; break; }
      }
    }
    /* 同名 .lrc 优先 */
    if (!lrcFile) {
      for (var w = 0; w < list.length; w++) {
        if (/\.lrc$/i.test(list[w].name) && baseName(list[w].name) === baseName(f.name)) { lrcFile = list[w]; break; }
      }
    }
    loadAudioFile(f, lrcFile);
  }

  /** 通用入口：载入一个音频 File（+ 可选同名 .lrc）。曲库、文件选择都走这里 */
  function loadAudioFile(f, lrcFile) {
    if (lrcFile) {
      readTextSmart(lrcFile).then(function (txt) {
        S.lrc = parseLRC(txt);
        S._lyIdx = -1;
        updateLyrics(-1);
        $('freeResult').innerHTML = '📄 已配歌词 <b>' + lrcFile.name + '</b>（' + S.lrc.length + ' 行）'
          + (S.lrc.length ? '' : '：这个文件里没有时间标签，可能是个纯音乐。') + '。';
      });
    } else {
      S.lrc = null; S._lyIdx = -1;
      $('lyrics').innerHTML = '';
    }
    if (S.audioUrl) URL.revokeObjectURL(S.audioUrl);
    S.audioUrl = URL.createObjectURL(f);
    if (!S.audioEl) {
      S.audioEl = document.createElement('audio');
      S.audioEl.controls = true;
      S.audioEl.className = 'audio-player';
      $('audioName').parentNode.appendChild(S.audioEl);
      S.audioEl.addEventListener('play', function () {
        if (!S.freeRec) setStatus('▶ 音频播放中。要记录你的音高，点「⏺ 开始记录我的音高」。');
      });
    }
    S.audioEl.src = S.audioUrl;
    $('audioName').textContent = f.name + '（' + (f.size / 1048576).toFixed(1) + ' MB）';
    $('freeRecBtn').disabled = false;
    $('freeResult').innerHTML = '音频已载入。正在后台估计这首歌的旋律线…';
    if (!S.audioEl._vpmHooked) {
      S.audioEl._vpmHooked = true;
      S.audioEl.addEventListener('ended', function () {
        if (S.freeRec) stopFreeRec(true);
      });
    }
    extractFromFile(f);
  }

  function toggleFreeRec() {
    if (!S.freeRec) {
      ensureMic().then(function () {
        S.freeRec = true;
        S.samples = [];
        S.notes = [];
        S.result = null;
        S.songPos = 0;
        S.t0Perf = performance.now();
        $('freeRecBtn').textContent = '⏹ 停止记录';
        $('freeRecBtn').classList.add('recording');
        $('freeResult').innerHTML = '⏺ 正在记录你的音高…唱吧！（这个模式不评分）';
        setStatus('自由练习：正在记录你的音高（不评分）。');
      }).catch(function (e) {
        $('freeResult').textContent = '拿不到麦克风：' + (e && e.message ? e.message : e);
      });
    } else {
      stopFreeRec(false);
    }
  }


  /* ============================================================
   * 事件绑定
   * ============================================================ */
  function bindEvents() {
    $('songSel').addEventListener('change', function () { selectSong(this.value, false); });
    $('speedSel').addEventListener('change', function () {
      S.speed = parseFloat(this.value) || 1;
      rebuildTimeline();
      saveSettings();
    });
    $('trDown').addEventListener('click', function () { changeTranspose(-1); });
    $('trUp').addEventListener('click', function () { changeTranspose(+1); });
    $('autoTrBtn').addEventListener('click', function () {
      var b = autoFit();
      drawKara(); updateHUD();
      if (b) setStatus('已自动移调 <b>' + (b.s > 0 ? '+' : '') + b.s + '</b> 个半音' + (b.overflow ? '（这首歌对你来说跨度偏大，已经尽量贴近你的音域）' : '，现在整首歌都在你的音域里了。'));
    });
    $('guideChk').addEventListener('change', function () { S.guide = this.checked; saveSettings(); });
    $('metroChk').addEventListener('change', function () { S.metro = this.checked; saveSettings(); });
    $('demoBtn').addEventListener('click', function () {
      if (S.playing) { stopAudio(); return; }
      playSequence('demo');
      if (!S.running) requestAnimationFrame(visualLoop);
    });
    $('startBtn').addEventListener('click', startSing);
    $('stopBtn').addEventListener('click', function () {
      if (S.freeRec) { toggleFreeRec(); return; }
      if (S.mode === 'sing' && S.samples.length > 30) { finishSing(); }
      else { stopAudio(); setStatus('已停止。'); }
    });
    $('exportBtn').addEventListener('click', exportJSON);
    $('csvBtn').addEventListener('click', exportCSV);
    $('clearBtn').addEventListener('click', function () {
      S.samples = []; S.result = null; renderResult(); drawKara();
      setStatus('已清空本次录音数据。');
    });
    $('audioFile').addEventListener('change', onFilePicked);
    $('freeRecBtn').addEventListener('click', toggleFreeRec);
    $('syncRecBtn').addEventListener('click', syncSing);
    $('lrcChk').addEventListener('change', function () { S._lyIdx = -1; updateLyrics(S.songPos > -9000 ? S.songPos : 0); });
    $('vocalSel').addEventListener('change', function () {
      S.vocalPreset = this.value;
      saveSettings();
      if (S.refTrack && S.refTrack.length) {
        $('refProgress').innerHTML = '已切换到「' + this.options[this.selectedIndex].textContent +
          '」，请重新选择一次音频文件来重新提取（音频文件本身不用换）。';
      }
    });
    $('vocalBandChk').addEventListener('change', function () { S.vocalBand = this.checked; saveSettings(); });
  }

  function changeTranspose(d) {
    S.transpose = clamp(S.transpose + d, -24, 12);
    applyTranspose();
    saveSettings();
    drawKara(); updateHUD();
    if (S.sungMin < S.rangeLow || S.sungMax > S.rangeHigh) {
      setStatus('现在这个调超出你的音域了（唱到的音 ' + PT.midiToName(S.sungMin) + '~' + PT.midiToName(S.sungMax) +
        '），点「🎯 自动适配我的音域」或继续按 − 降调。');
    }
  }

  function startSing() {
    if (S.playing) { stopAudio(); return; }
    ensureMic().then(function () {
      playSequence('sing');
    }).catch(function (e) {
      setStatus('拿不到麦克风：' + (e && e.message ? e.message : e) + '（要点「允许」，并且页面必须是 https 或 localhost）');
    });
  }

  /* 没有麦克风时（只听旋律），也要能滚动画面 */
  function visualLoop(ts) {
    if (!S.playing || S.running) return;
    if (!ts) ts = performance.now();
    if (ts - S.lastDraw < 33) { requestAnimationFrame(visualLoop); return; }
    S.lastDraw = ts;
    var now = performance.now();
    S.songPos = now - S.t0Perf;
    if (now > S.endAtPerf) {
      stopAudio();
      S.songPos = S.totalMs;
      setStatus('播放完了。点「🎤 开始跟唱打分」换你来唱。');
    }
    drawKara();
    updateHUD();
    if (S.playing) requestAnimationFrame(visualLoop);
  }


/* ============================================================
   * 从本地音频里估「主旋律音高线」（实验性）
   *   用你自己的音频做评分基准 —— 伴奏/鼓/和声都会干扰，人声突出的歌更准
   * ============================================================ */
  function decodeFile(file) {
    if (!file.arrayBuffer) return Promise.reject(new Error('浏览器太旧，读不了本地文件'));
    return file.arrayBuffer().then(function (buf) {
      var ctx = ensureCtx();
      return new Promise(function (resolve, reject) {
        var done = false;
        var ok = function (b) { if (!done) { done = true; resolve(b); } };
        var bad = function (e) { if (!done) { done = true; reject(e || new Error('解码失败')); } };
        try {
          var ret = ctx.decodeAudioData(buf, ok, bad);
          if (ret && ret.then) ret.then(ok, bad);
        } catch (e) { bad(e); }
      });
    });
  }

  function vocalRange() {
    for (var i = 0; i < VOCAL_PRESETS.length; i++) {
      if (VOCAL_PRESETS[i].id === S.vocalPreset) return VOCAL_PRESETS[i];
    }
    return VOCAL_PRESETS[0];
  }

  /** 二阶双二次滤波器系数（RBJ cookbook） */
  function biquadCoef(type, sr, f0, Q) {
    var w0 = 2 * Math.PI * f0 / sr, cosw = Math.cos(w0), sinw = Math.sin(w0);
    var alpha = sinw / (2 * (Q || 0.707));
    var b0, b1, b2;
    if (type === 'hp') { b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2; }
    else { b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = (1 - cosw) / 2; }
    var a0 = 1 + alpha, a1 = -2 * cosw, a2 = 1 - alpha;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  /** 原地滤波（只多用一个临时数组，省内存） */
  function filterInPlace(x, cf) {
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (var i = 0; i < x.length; i++) {
      var xn = x[i];
      var yn = cf.b0 * xn + cf.b1 * x1 + cf.b2 * x2 - cf.a1 * y1 - cf.a2 * y2;
      x2 = x1; x1 = xn; y2 = y1; y1 = yn;
      x[i] = yn;
    }
    return x;
  }

  /** 分块处理，避免卡死页面；返回连续的旋律线 [{t, f, midi, q, conf, rms, gap}] */
  function extractReference(audioBuf, onProgress) {
    return new Promise(function (resolve) {
      var srcRate = audioBuf.sampleRate;
      var ratio = Math.max(1, Math.round(srcRate / 11025));   // 降到约 11kHz，够测人声
      var sr = srcRate / ratio;
      var len = Math.floor(audioBuf.length / ratio);
      var chs = [];
      for (var c = 0; c < audioBuf.numberOfChannels; c++) chs.push(audioBuf.getChannelData(c));

      /* 先按原始采样率混成单声道，再带通滤波，最后降采样。
         带通：高通 120Hz 甩掉贝斯/底鼓（它们周期性最强，不滤掉 YIN 会一直锁到贝斯），
               低通 1200Hz 甩掉镲片/齿音，同时充当降采样的抗混叠滤波。 */
      var full = new Float32Array(audioBuf.length);
      for (var i0 = 0; i0 < audioBuf.length; i0++) {
        var acc0 = 0;
        for (var k0 = 0; k0 < chs.length; k0++) acc0 += chs[k0][i0];
        full[i0] = acc0 / chs.length;
      }
      if (S.vocalBand) {
        filterInPlace(full, biquadCoef('hp', srcRate, 120, 0.707));
        filterInPlace(full, biquadCoef('lp', srcRate, 1200, 0.707));
      }
      var mono = new Float32Array(len);
      for (var i = 0; i < len; i++) mono[i] = full[i * ratio];
      full = null;
      var win = 1024, hop = 512;                              // 50% 重叠，时间分辨率约 46ms
      var frames = Math.max(1, Math.floor(Math.max(0, len - win) / hop) + 1);
      var raw = [];
      var idx = 0;
      var CHUNK = 100;
      function step() {
        var stop = Math.min(frames, idx + CHUNK);
        for (; idx < stop; idx++) {
          var off = idx * hop;
          var buf = mono.subarray(off, Math.min(len, off + win));
          var rms = 0;
          for (var j = 0; j < buf.length; j++) rms += buf[j] * buf[j];
          rms = Math.sqrt(rms / buf.length);
          var t = (off / sr) * 1000;
          if (rms < 0.005) { raw.push({ t: t, midi: null, f: null, conf: 0, rms: rms }); continue; }
          var vp = vocalRange();
          var r = PT.detectPitch(buf, sr, { minFreq: vp.lo, maxFreq: vp.hi, threshold: 0.16 });
          raw.push({
            t: t,
            f: r.freq > 0 ? r.freq : null,
            midi: (r.freq > 0 && r.confidence > 0.25) ? PT.freqToMidi(r.freq, S.a4) : null,
            conf: r.confidence || 0,
            rms: rms
          });
        }
        if (onProgress) onProgress(idx / frames);
        if (idx < frames) { setTimeout(step, 0); return; }
        resolve(viterbiPath(raw));
      }
      step();
    });
  }

  /**
   * 简化版 Viterbi：把逐帧候选串成一条「连续」的旋律线。
   *   代价 = 偏离该帧检测到的音高 + 0.4 × 换音跨度
   *   → 换音过渡帧不会造出假音，偶尔的八度跳变也会被拉回来，
   *     安静的间奏可以"维持"上一音（代价极小），所以整条线不会断成一段一段。
   */
  function viterbiPath(raw) {
    var voiced = raw.filter(function (r) { return r.midi !== null; });
    if (voiced.length < 3) return [];
    var lo = Infinity, hi = -Infinity;
    voiced.forEach(function (r) { if (r.midi < lo) lo = r.midi; if (r.midi > hi) hi = r.midi; });
    lo = Math.round(lo) - 3;
    hi = Math.round(hi) + 3;
    var N = raw.length, M = hi - lo + 1;
    if (M > 90) { hi = lo + 90; M = 91; }
    var INF = 1e9;
    var prev = new Float64Array(M), cur = new Float64Array(M);
    var back = new Int16Array(N * M);
    var i, s, p2;
    for (s = 0; s < M; s++) { prev[s] = emitCost(raw[0], lo + s); back[s] = -1; }
    for (i = 1; i < N; i++) {
      for (s = 0; s < M; s++) {
        var best = INF, bestP = -1;
        var pFrom = Math.max(0, s - 14), pTo = Math.min(M - 1, s + 14);
        for (p2 = pFrom; p2 <= pTo; p2++) {
          var d = Math.abs(s - p2);
          var cost = prev[p2] + 0.85 * d + (d > 0 ? 1.1 : 0);   // 换音要付"过路费"，过渡帧不会留下假音
          if (cost < best) { best = cost; bestP = p2; }
        }
        cur[s] = best + emitCost(raw[i], lo + s);
        back[i * M + s] = bestP;
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    var sBest = 0;
    for (s = 1; s < M; s++) if (prev[s] < prev[sBest]) sBest = s;
    var path = new Int16Array(N);
    var sCur = sBest;
    for (i = N - 1; i >= 0; i--) {
      path[i] = lo + sCur;
      sCur = back[i * M + sCur];
      if (sCur < 0) sCur = 0;
    }
    return raw.map(function (r, k) {
      return {
        t: r.t, f: r.f, midi: r.midi, conf: r.conf, rms: r.rms,
        q: path[k],
        detected: r.midi !== null,
        gap: (r.midi === null && r.rms < 0.012)
      };
    });
  }

  function emitCost(r, s) {
    if (r.midi === null) return r.rms < 0.012 ? 0.05 : 0.5;    // 静音：几乎免费地"维持"；有声音但没测准：小惩罚
    return Math.abs(r.midi - s) - Math.min(0.6, r.conf) * 0.5;
  }


  /** 把连续的旋律线切成「音符片段」（同一个半音、持续 ≥120ms，静音处断开）
   *  目标音高用片段内「原始检测值的中位数」，比取整更准（不受整条音轨音准微小偏移影响） */
  function buildRefSegs(track) {
    var segs = [], cur = null;
    function flush() { if (cur) { segs.push(cur); cur = null; } }
    track.forEach(function (p) {
      if (p.q === undefined || p.gap) { flush(); return; }
      if (!cur || cur.midi !== p.q || (p.t - cur.lastT) > 200) {
        flush();
        cur = { midi: p.q, startMs: p.t, lastT: p.t, n: 0, raws: [] };
      }
      cur.lastT = p.t;
      cur.n++;
      if (p.midi !== null) cur.raws.push(p.midi);
    });
    flush();
    return segs.filter(function (s) {
      /* 至少 1/3 的帧是真的检测到音高（其余是 Viterbi 推的），才算可靠的音、才拿去打分 */
      return (s.lastT - s.startMs) >= 120 && s.n >= 3 &&
             s.raws.length >= Math.max(2, Math.ceil(s.n * 0.33));
    }).map(function (s) {
      var fine = median(s.raws);
      return { startMs: s.startMs, endMs: s.lastT, midi: Math.round(fine), midiFine: fine, n: s.n };
    }).filter(function (s) {
      return (s.endMs - s.startMs) >= 150;                  // 太短的碎片（换音瞬间）直接丢掉
    }).reduce(function (acc, s) {
      /* 相邻且同音高的片段合并 */
      var last = acc[acc.length - 1];
      if (last && last.midi === s.midi && (s.startMs - last.endMs) < 220) {
        last.endMs = s.endMs;
        last.n += s.n;
        return acc;
      }
      acc.push(s);
      return acc;
    }, []);
  }

  /** 音分差折叠到 ±600（八度差不算错，男生唱女声歌很常见） */
  function foldCents(c) {
    c = ((c % 1200) + 1200) % 1200;
    if (c > 600) c -= 1200;
    return c;
  }

  /** 你这遍唱的是哪个八度（用来把参考线整体挪到你舒服的八度） */
  function refOctShift() {
    if (!S.samples.length || !S.refTrack || !S.refTrack.length) return 0;
    var diffs = [], idx = 0;
    for (var i = 0; i < S.samples.length; i++) {
      var s = S.samples[i];
      while (idx < S.refTrack.length - 1 && S.refTrack[idx + 1].t < s.t) idx++;
      var rt = S.refTrack[idx];
      if (Math.abs(rt.t - s.t) > 90) continue;
      diffs.push(PT.freqToMidi(s.f, S.a4) - PT.freqToMidi(rt.f, S.a4));
    }
    if (diffs.length < 20) return 0;
    return Math.round(median(diffs) / 12) * 12;
  }

  /** 用「音频里估出来的旋律线」当标准给这遍打分 */
  function scoreVsRef() {
    S.refShiftOct = refOctShift();
    var rows = [];
    S.refSegs.forEach(function (seg) {
      var target = (seg.midiFine === undefined ? seg.midi : seg.midiFine) + S.refShiftOct;
      var vals = [];
      for (var i = 0; i < S.samples.length; i++) {
        var s = S.samples[i];
        if (s.t >= seg.startMs + 60 && s.t <= Math.max(seg.startMs + 160, seg.endMs - 40)) {
          vals.push(PT.freqToMidi(s.f, S.a4));
        }
      }
      var med = vals.length ? median(vals) : null;
      var cents = med === null ? null : foldCents((med - target) * 100);
      var ti = PT.describeMidi(target, S.a4, false);
      rows.push({
        index: rows.length + 1,
        name: PT.midiToName(seg.midi),
        targetSol: ti.solfege + ti.octave,
        targetMidi: target,
        startMs: seg.startMs, endMs: seg.endMs,
        medMidi: med, cents: cents, samples: vals.length,
        score: cents === null ? 0 : Math.max(0, Math.min(100, Math.round(100 - Math.abs(cents) * 1.2)))
      });
    });
    if (!rows.length) { S.result = null; return null; }
    var sung = rows.filter(function (r) { return r.cents !== null; });
    var total = Math.round(mean(rows.map(function (r) { return r.score; })));
    var worst = null;
    rows.forEach(function (r) { if (!worst || r.score < worst.score) worst = r; });
    S.result = {
      rows: rows, total: total,
      sungCount: sung.length,
      coverage: sung.length / rows.length * 100,
      avgAbs: sung.length ? mean(sung.map(function (r) { return Math.abs(r.cents); })) : 0,
      bias: sung.length ? mean(sung.map(function (r) { return r.cents; })) : 0,
      in50: sung.length ? sung.filter(function (r) { return Math.abs(r.cents) <= 50; }).length / sung.length * 100 : 0,
      worst: worst,
      refBased: true
    };
    return S.result;
  }

  function extractFromFile(file) {
    var prog = $('refProgress');
    prog.textContent = '① 正在解码音频…（大文件要几秒）';
    S.refTrack = null; S.refSegs = null; S.refShiftOct = 0;
    $('syncRecBtn').disabled = true;
    decodeFile(file).then(function (ab) {
      prog.textContent = '② 音频 ' + (ab.length / ab.sampleRate).toFixed(0) + ' 秒，正在估计主旋律音高线…（别关页面）';
      return extractReference(ab, function (p) {
        prog.textContent = '② 正在估计主旋律… ' + (p * 100).toFixed(0) + '%（别关页面）';
      });
    }).then(function (track) {
      S.refTrack = track;
      S.refSegs = buildRefSegs(track);
      var secs = track.length ? (track[track.length - 1].t / 1000) : 0;
      prog.innerHTML = '<span class="ref-ok">✅ 提取完成</span>：' + track.length + ' 个音高点 → ' + S.refSegs.length +
        ' 个旋律片段（覆盖到 ' + secs.toFixed(0) + ' 秒）。' +
        (S.refSegs.length < 5
          ? ' <span class="ref-bad">片段太少：这首歌伴奏太满或人声太弱，提取不准，建议只用「⏺ 只记录我的音高」。</span>'
          : ' 看看②里那条<b>灰绿色细线</b>像不像这首歌的旋律 —— <b>像才用它打分</b>。');
      $('syncRecBtn').disabled = false;
      drawKara();
    }).catch(function (e) {
      prog.innerHTML = '<span class="ref-bad">❌ 提取失败：' + (e && e.message ? e.message : e) +
        '。常见原因：① 网易云下载的 .ncm / .uc! 是加密格式（先转成 mp3/flac）；② 浏览器不支持这个编码。<br>' +
        '也可以先用「⏺ 只记录我的音高」把我唱的音高录下来导出给我分析。</span>';
    });
  }

  /* ---------- 同步跟唱：歌和录音一起开始 ---------- */
  function syncSing() {
    if (!S.audioEl) { $('freeResult').textContent = '先选一个本地音频文件。'; return; }
    if (S.freeRec) { stopFreeRec(true); return; }
    ensureMic().then(function () {
      S.samples = [];
      S.notes = [];
      S.result = null;
      S.refShiftOct = 0;
      renderResult();
      S.freeRec = true;
      try { S.audioEl.currentTime = 0; } catch (e) {}
      S.t0Perf = performance.now();
      S.songPos = 0;
      var pr = S.audioEl.play();
      if (pr && pr.catch) pr.catch(function () {});
      $('syncRecBtn').textContent = '⏹ 停止并打分';
      $('syncRecBtn').classList.add('recording');
      $('freeRecBtn').disabled = true;
      $('freeResult').innerHTML = '🎤 正在同步跟唱：歌在放，同时记录你的音高。<b>戴耳机！</b>';
      S._lyIdx = -1;
      updateLyrics(0);
      setStatus('同步跟唱中…唱完会自动出分（基准 = 从音频估出来的旋律线）。');
    }).catch(function (e) {
      $('freeResult').textContent = '拿不到麦克风：' + (e && e.message ? e.message : e);
    });
  }

  function stopFreeRec(auto) {
    S.freeRec = false;
    $('syncRecBtn').textContent = '🎤 从头同步跟唱（自动对齐 · 可打分）';
    $('syncRecBtn').classList.remove('recording');
    $('freeRecBtn').disabled = false;
    $('freeRecBtn').textContent = '⏺ 只记录我的音高';
    try { if (S.audioEl && !S.audioEl.paused) S.audioEl.pause(); } catch (e) {}
    S._lyIdx = -1;
    if (S.refSegs && S.refSegs.length && S.samples.length) {
      scoreVsRef();
      renderResult();
      S.songPos = S.samples[S.samples.length - 1].t;
      $('freeResult').innerHTML = '✅ 出分啦，看③「成绩单」。评分基准 = 从音频里估出来的旋律线（' + S.refSegs.length +
        ' 个片段，已按你的八度对齐 ' + ((S.refShiftOct > 0 ? '+' : '') + S.refShiftOct) + ' 个半音）。<br>' +
        '⚠️ 如果那条灰绿细线和这首歌的旋律<b>不像</b>，这个分就不算数 —— 用「⏺ 只记录我的音高」+ 导出给我分析。';
    } else {
      freeSummary();
    }
    drawKara();
  }

  /** 自由练习（没有参考线时）的总结：只看你自己的音高范围 */
  function freeSummary() {
    if (!S.samples.length) { $('freeResult').textContent = '没有记录到声音，靠近麦克风再试一次。'; return; }
    var mids = S.samples.map(function (s) { return PT.freqToMidi(s.f, S.a4); }).sort(function (a, b) { return a - b; });
    var lo = mids[Math.floor(mids.length * 0.05)], hi = mids[Math.floor(mids.length * 0.95)];
    var loN = PT.describeMidi(lo, S.a4, false), hiN = PT.describeMidi(hi, S.a4, false);
    var secs = (S.samples[S.samples.length - 1].t / 1000).toFixed(1);
    $('freeResult').innerHTML =
      '这段你唱了 <b>' + secs + ' 秒</b>，音高范围 <b>' + loN.solfege + loN.octave + '</b>（' + num(PT.midiToFreq(lo, S.a4), 1) +
      ' Hz） ~ <b>' + hiN.solfege + hiN.octave + '</b>（' + num(PT.midiToFreq(hi, S.a4), 1) + ' Hz）。' +
      (hi > S.rangeHigh ? '<br>⚠️ 最高音超出你设的音域上限 ' + PT.midiToName(S.rangeHigh) + '，建议降 ' +
        Math.ceil(hi - S.rangeHigh) + ' 个半音唱。' : '') +
      '<br>把音频和这份数据一起发我，我帮你看哪一段把你自己顶住了。';
    setStatus('自由练习记录完成。');
  }

  /* 给曲库（js/library.js）用的接口 */
  window.KaraokeAPI = {
    load: loadAudioFile,
    status: setStatus,
    state: S,
    getRange: function () { return vocalRange(); }
  };

  /* 启动 */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
