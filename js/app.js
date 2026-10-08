/* ============================================================
 * app.js —— 界面逻辑
 *   实时音准 / 标准频率表 / 录音统计 / 单音跟唱测试 / 轨迹图
 * ============================================================ */
(function () {
  'use strict';

  var PT = window.PitchTool;
  if (!PT) { alert('pitch.js 没有加载成功，请检查文件是否完整。'); return; }

  /* ---------- 小工具 ---------- */
  function $(id) { return document.getElementById(id); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }
  function std(a) {
    if (a.length < 2) return 0;
    var m = mean(a);
    return Math.sqrt(mean(a.map(function (x) { return (x - m) * (x - m); })));
  }
  function num(v, d) { return Number(v).toFixed(d === undefined ? 1 : d); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function stamp(d) {
    d = d || new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
           pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  var MIN_FREQ = 65;     // C2
  var MAX_FREQ = 1300;   // ~E6
  var REC_INTERVAL = 70; // 录音采样间隔 ms
  var LS_KEY = 'vpm.sessions.v1';
  var LS_SETTINGS = 'vpm.settings.v1';

  /* 常见音域预设（写的是「能唱到的极限音」，不是舒服的音） */
  var RANGE_PRESETS = [
    { id: 'bass',      label: '男低音 Bass（E2–E4）',          low: 'E2', high: 'E4', oct: 2 },
    { id: 'baritone',  label: '男中音 Baritone（A2–F4）',      low: 'A2', high: 'F4', oct: 3 },
    { id: 'baritenor', label: '男中音偏男高（A2–A4）',         low: 'A2', high: 'A4', oct: 3 },
    { id: 'tenor',     label: '男高音 Tenor（C3–A4）',         low: 'C3', high: 'A4', oct: 3 },
    { id: 'alto',      label: '女低音 Alto（F3–F5）',          low: 'F3', high: 'F5', oct: 3 },
    { id: 'mezzo',     label: '女中音 Mezzo（A3–A5）',         low: 'A3', high: 'A5', oct: 4 },
    { id: 'soprano',   label: '女高音 Soprano（C4–C6）',       low: 'C4', high: 'C6', oct: 4 },
    { id: 'custom',    label: '自定义…',                       low: null, high: null, oct: null }
  ];

  /* ---------- 全局状态 ---------- */
  var S = {
    /* 音频 */
    running: false, audioCtx: null, stream: null, analyser: null, micSource: null,
    buf: null, lastAnalysis: 0, analysisInterval: 60, lastDraw: 0,
    pitchHist: [],          // 最近检测到的频率，用于中位数平滑
    level: 0,
    current: null,          // { freq, conf, rms, note }
    live: [],               // 实时曲线样本 { t, midi }
    axis: { lo: 0, hi: 0 }, // 实时曲线纵轴的平滑跟随值
    /* 设置 */
    a4: 440, useFlat: false, ladderOctave: 3,
    liveWin: 10, scopeOn: true,
    rangeLow: 45,           // A2 = 110 Hz
    rangeHigh: 69,          // A4 = 440 Hz
    rangePreset: 'baritenor',
    holdMidi: null, holdN: 0,      // 稳定音判定（连续 3 帧算"唱到了"）
    /* 录音 */
    recording: false, recStart: 0, lastPush: 0, track: [], lastStatsAt: 0,
    /* 本地记录 */
    sessions: [],
    /* 测试 */
    pracBusy: false,
    /* 换声区扫描 */
    scan: null, lastScanResult: null
  };

  /* ============================================================
   * 启动
   * ============================================================ */
  function init() {
    loadSettings();
    buildOctaveSelect();
    buildRangeSelect();
    bindEvents();
    buildLadder();
    buildRefTable();
    buildPracticeSelect();
    buildShiftSelects();
    buildPassStartSelect();
    buildPassManualSelect();
    renderRangeInfo();
    renderRangeLog();
    renderRangeFolder();
    renderPassaggio();
    if (window.RecordFolder) {
      window.RecordFolder.onChange(renderRangeFolder);
      window.RecordFolder.load().then(renderRangeFolder).catch(renderRangeFolder);
    }
    updateShift();
    drawLive(performance.now());
    loadSessions();
    renderSessions();
    drawChart([]);
    window.addEventListener('resize', function () { drawChart(currentChartTrack()); });

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('这个浏览器不支持麦克风录音，或者你打开的不是 https / localhost 页面。请用 Chrome / Edge / Safari 打开，或者用本地服务器测试。');
      $('micBtn').disabled = true;
    }
  }

  function bindEvents() {
    $('micBtn').addEventListener('click', toggleMic);
    $('a4Input').addEventListener('change', onA4Change);
    $('flatChk').addEventListener('change', function () {
      S.useFlat = this.checked;
      buildLadder(); buildRefTable(); buildPracticeSelect();
      if (S.current) updateReadout(S.current);
    });
    $('octaveSel').addEventListener('change', function () {
      S.ladderOctave = parseInt(this.value, 10);
      saveSettings();
      buildLadder(); buildRefTable(); buildPracticeSelect();
      renderRangeInfo();
    });
    $('rangeSel').addEventListener('change', function () { onRangePreset(this.value); });
    $('rangeLowSel').addEventListener('change', function () { onCustomRange('low', parseInt(this.value, 10)); });
    $('rangeHighSel').addEventListener('change', function () { onCustomRange('high', parseInt(this.value, 10)); });
    $('songHighSel').addEventListener('change', updateShift);
    $('songLowSel').addEventListener('change', updateShift);
    $('shiftPlayBtn').addEventListener('click', playShiftTone);
    $('rangeUseBtn').addEventListener('click', function () {
      var log = loadRangeLog(), d = log[todayKey()];
      if (!d || d.low === null || d.high === null) { setStatus('今天还没有记录到稳定的最低/最高音，先唱几个音。'); return; }
      if (d.high - d.low < 6) { setStatus('今天记录到的跨度太小（' + (d.high - d.low) + ' 个半音），多唱一会儿再点。'); return; }
      S.rangePreset = 'custom';
      $('rangeSel').value = 'custom';
      applyRange(d.low, d.high, 'custom');
      setStatus('✅ 已把今天的音域 ' + PT.midiToName(d.low) + ' – ' + PT.midiToName(d.high) + ' 设为「我的音域」，K歌页会跟着用。');
    });
    var rangeFolderBtn = $('rangeFolderBtn');
    if (rangeFolderBtn) rangeFolderBtn.addEventListener('click', chooseRangeFolder);
    $('rangeSaveBtn').addEventListener('click', saveRangeToFolder);
    $('rangeExportBtn').addEventListener('click', function () {
      var log = loadRangeLog();
      if (!Object.keys(log).length) { setStatus('还没有音域记录可导出。'); return; }
      downloadRangeFiles(log);
    });
    $('rangeClearBtn').addEventListener('click', function () {
      if (!confirm('清空所有日期的音域记录？（只影响浏览器本地记录）')) return;
      saveRangeLog({});
      renderRangeLog();
      drawTrend();
      setStatus('已清空音域记录。');
    });
    /* ⑧ 换声区 & 音域趋势 */
    var passScanBtn = $('passScanBtn');
    if (passScanBtn) passScanBtn.addEventListener('click', startPassScan);
    var passUseRangeBtn = $('passUseRangeBtn');
    if (passUseRangeBtn) passUseRangeBtn.addEventListener('click', function () {
      var sel = $('passStartSel');
      var m = defaultScanStart();
      if (sel) sel.value = String(m);
      setStatus('起始音已设为 <b>' + PT.midiToName(m) + '</b>（从你的音域上限往下留一个八度），' +
                '这样最后一个音正好落在你的最高音上。点「🎙 开始换声区扫描」开始。');
    });
    var passManualSel = $('passManualSel');
    if (passManualSel) passManualSel.addEventListener('change', function () { onPassManual(this.value); });
    var passSaveBtn = $('passSaveBtn');
    if (passSaveBtn) passSaveBtn.addEventListener('click', savePassToFolder);
    var passExportBtn = $('passExportBtn');
    if (passExportBtn) passExportBtn.addEventListener('click', function () {
      if (!hasPassData()) { setStatus('还没有音域趋势或换声区扫描数据可以导出。'); return; }
      downloadPassFiles();
    });
    var passClearBtn = $('passClearBtn');
    if (passClearBtn) passClearBtn.addEventListener('click', function () {
      if (!confirm('清空所有换声区扫描记录？（不影响每日音域记录）')) return;
      var lg = loadPassLog();
      lg.scans = [];
      savePassLog(lg);
      renderPassaggio();
      setStatus('已清空换声区扫描记录。');
    });
    $('liveWin').addEventListener('change', function () { S.liveWin = parseInt(this.value, 10) || 10; saveSettings(); });
    $('scopeChk').addEventListener('change', function () {
      S.scopeOn = this.checked;
      $('scope').classList.toggle('hidden', !S.scopeOn);
      saveSettings();
    });
    $('playScaleBtn').addEventListener('click', playScale);
    $('recBtn').addEventListener('click', toggleRecord);
    $('clearBtn').addEventListener('click', function () {
      if (S.recording) { setStatus('先停止录音再清空。'); return; }
      S.track = [];
      clearLive();
      renderStats(null);
      setStatus('已清空本次录音数据。');
    });
    $('jsonBtn').addEventListener('click', function () { exportJSON(S.track, 'current'); });
    $('csvBtn').addEventListener('click', function () { exportCSV(S.track, 'current'); });
    $('pracBtn').addEventListener('click', startPractice);
    $('dlAllBtn').addEventListener('click', exportAllSessions);
    $('delAllBtn').addEventListener('click', function () {
      if (!S.sessions.length) return;
      if (!confirm('确定删除本地保存的全部录音记录吗？这个操作不可恢复。')) return;
      S.sessions = [];
      persistSessions();
      renderSessions();
    });
  }

  function setStatus(msg) { $('micStatus').textContent = msg; }

  /* ============================================================
   * 麦克风 & 分析循环
   * ============================================================ */
  function ensureCtx() {
    if (!S.audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      S.audioCtx = new AC();
    }
    return S.audioCtx;
  }

  function toggleMic() {
    if (S.running) { stopMic(); return; }
    startMic();
  }

  function startMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('浏览器不支持麦克风，或页面不是 https / localhost。');
      return;
    }
    if (!window.isSecureContext) {
      setStatus('当前页面不是安全环境（需要 https 或 localhost），浏览器不会允许使用麦克风。');
      return;
    }
    setStatus('正在请求麦克风权限…');
    navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      }
    }).then(function (stream) {
      S.stream = stream;
      var ctx = ensureCtx();
      var go = function () {
        S.audioCtx.resume && S.audioCtx.resume();
        S.micSource = ctx.createMediaStreamSource(stream);
        S.analyser = ctx.createAnalyser();
        S.analyser.fftSize = 4096;                       // 时域样本数
        S.buf = new Float32Array(S.analyser.fftSize);
        S.micSource.connect(S.analyser);                 // 不接扬声器，避免啸叫
        S.running = true;
        S.lastAnalysis = 0;
        S.pitchHist = [];
        $('micBtn').textContent = '停止收音';
        $('micBtn').classList.add('on');
        setStatus('正在收音。对着麦克风唱一个长音（先试试 la—），看下面显示的音名和指针。');
        requestAnimationFrame(loop);
      };
      if (ctx.state === 'suspended') { ctx.resume().then(go); } else { go(); }
    }).catch(function (e) {
      var name = e && e.name ? e.name : '';
      var msg = '无法使用麦克风：' + (e && e.message ? e.message : e);
      if (name === 'NotAllowedError') msg = '麦克风权限被拒绝了。请在地址栏左侧的锁形图标里允许麦克风，然后刷新页面。';
      if (name === 'NotFoundError') msg = '没有找到麦克风设备，请检查是否插好 / 系统里是否禁用。';
      setStatus(msg);
    });
  }

  function stopMic() {
    if (S.recording) toggleRecord();   // 顺序很重要：先结束录音
    if (S.scan && S.scan.active) abortPassScan();   // 换声区扫描没有声音就没意义了
    S.running = false;
    if (S.stream) {
      S.stream.getTracks().forEach(function (t) { t.stop(); });
    }
    if (S.micSource) { try { S.micSource.disconnect(); } catch (e) {} }
    S.stream = null; S.micSource = null; S.analyser = null;
    S.pitchHist = [];
    S.current = null;
    $('micBtn').textContent = '开始收音';
    $('micBtn').classList.remove('on');
    setStatus('已停止收音。');
    resetReadout();
  }

  function computeRms(buf) {
    var sum = 0;
    for (var i = 0; i < buf.length; i++) { sum += buf[i] * buf[i]; }
    return Math.sqrt(sum / buf.length);
  }

  function loop(ts) {
    if (!S.running) return;
    requestAnimationFrame(loop);
    if (!ts) ts = performance.now();
    if (ts - S.lastDraw < 33) return;                     // 画面约 30fps
    S.lastDraw = ts;
    if (ts - S.lastAnalysis >= S.analysisInterval) {      // 音高分析约 16fps
      S.lastAnalysis = ts;
      analyze(ts);
    }
    drawLive(ts);                                         // 实时曲线跟着时间滚动
    if (S.scopeOn) drawScope();
  }

  /* 一次音高分析：读缓冲区 -> 检测 -> 平滑 -> 更新界面 */
  function analyze(ts) {
    S.analyser.getFloatTimeDomainData(S.buf);
    var rms = computeRms(S.buf);
    S.level = rms;

    var detected = null;
    if (rms >= 0.003) {
      var res = PT.detectPitch(S.buf, S.audioCtx.sampleRate, {
        minFreq: MIN_FREQ, maxFreq: MAX_FREQ, threshold: 0.15
      });
      if (res.freq > 0 && res.confidence > 0.4) detected = res;
    }
    if (detected) {
      S.pitchHist.push({ f: detected.freq, conf: detected.confidence, t: ts });
    }
    /* 只保留最近 400ms 的有效检测，做中位数平滑 */
    var cutoff = ts - 400;
    S.pitchHist = S.pitchHist.filter(function (p) { return p.t >= cutoff; });

    var cur = null;
    if (S.pitchHist.length && rms >= 0.002) {
      var freqs = S.pitchHist.map(function (p) { return p.f; }).sort(function (a, b) { return a - b; });
      var med = freqs[Math.floor(freqs.length / 2)];
      /* 只保留中位数附近 ±60 音分的点，避免偶尔的八度跳变拉偏结果 */
      var near = S.pitchHist.filter(function (p) {
        return Math.abs(1200 * Math.log2(p.f / med)) < 60;
      });
      if (near.length) {
        var sf = 0, sc = 0;
        near.forEach(function (p) { sf += p.f; sc += p.conf; });
        var f = sf / near.length;
        cur = { freq: f, midi: PT.freqToMidi(f, S.a4), conf: sc / near.length, rms: rms };
      }
    }
    S.current = cur;
    pushLive(ts, cur);

    updateReadout(cur);
    if (S.scan && S.scan.active) scanFeed(ts, cur);
    if (S.recording) maybeRecord(cur, ts);
    if (S.recording && ts - S.lastStatsAt > 800) {
      S.lastStatsAt = ts;
      refreshRecordingUI();
    }
  }

  /* ============================================================
   * 实时音高曲线 + 声波
   * ============================================================ */
  function pushLive(ts, cur) {
    if (!cur) return;
    S.live.push({ t: ts, midi: PT.freqToMidi(cur.freq, S.a4) });
    var keepFrom = ts - (S.liveWin * 1000 + 2000);
    while (S.live.length && S.live[0].t < keepFrom) S.live.shift();
    if (S.live.length > 8000) S.live.splice(0, 2000);
  }

  function clearLive() {
    S.live = [];
    S.axis = { lo: 0, hi: 0 };
    drawLive(performance.now());
  }

  /** 滚动的实时音高曲线：横轴=时间，纵轴=音高（每条横线是一个半音） */
  function drawLive(now) {
    var cv = $('liveChart');
    if (!cv) return;
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth || 640, h = cv.clientHeight || 210;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var padL = 62, padR = 16, padT = 12, padB = 16;
    var plotW = Math.max(40, w - padL - padR), plotH = Math.max(40, h - padT - padB);
    var win = S.liveWin * 1000, t0 = now - win;

    if (!S.live.length) {
      ctx.fillStyle = '#4b5b7d';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('点「开始收音」对着麦克风唱，这里会有一条跟着你音高实时走的线', w / 2, h / 2);
      return;
    }

    /* 可见样本 */
    var vis = [];
    for (var i = 0; i < S.live.length; i++) if (S.live[i].t >= t0) vis.push(S.live[i]);

    /* 纵轴范围：跟随可见音高，向外取整到半音，并做平滑，避免画面抖 */
    var mn = Infinity, mx = -Infinity;
    vis.forEach(function (p) { if (p.midi < mn) mn = p.midi; if (p.midi > mx) mx = p.midi; });
    if (!isFinite(mn)) { mn = 60; mx = 60; }
    var lo = Math.floor(mn) - 1, hi = Math.ceil(mx) + 1;
    if (hi - lo < 7) { var mid = (lo + hi) / 2; lo = mid - 3.5; hi = mid + 3.5; }
    if (hi - lo > 26) { var mid2 = (lo + hi) / 2; lo = mid2 - 13; hi = mid2 + 13; }
    if (S.axis.lo === 0 && S.axis.hi === 0) { S.axis.lo = lo; S.axis.hi = hi; }
    S.axis.lo += (lo - S.axis.lo) * 0.10;
    S.axis.hi += (hi - S.axis.hi) * 0.10;
    var ay0 = S.axis.lo, ay1 = S.axis.hi;

    function X(t) { return padL + (t - t0) / win * plotW; }
    function Y(m) { return padT + (ay1 - m) / (ay1 - ay0) * plotH; }

    /* 半音线 + 唱名 + ±25 音分「准音带」 */
    var MAJ = [0, 2, 4, 5, 7, 9, 11];
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var m = Math.ceil(ay0); m <= Math.floor(ay1); m++) {
      var info = PT.describeMidi(m, S.a4, S.useFlat);
      var major = MAJ.indexOf(info.pc) >= 0;
      var out = isOutOfRange(m);
      if (major && !out) {
        ctx.fillStyle = 'rgba(74,222,128,.10)';
        ctx.fillRect(padL, Y(m + 0.25), plotW, Y(m - 0.25) - Y(m + 0.25));
      }
      ctx.strokeStyle = major ? 'rgba(148,163,184,.32)' : 'rgba(148,163,184,.11)';
      ctx.beginPath(); ctx.moveTo(padL, Y(m)); ctx.lineTo(padL + plotW, Y(m)); ctx.stroke();
      ctx.fillStyle = out ? '#5b6b8c' : (major ? '#9fb0d0' : '#4d5c7c');
      ctx.fillText(info.solfege + info.octave, padL - 6, Y(m));
    }

    /* 相邻半音的分界（±50 音分处），虚线 */
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(148,163,184,.15)';
    for (var m2 = Math.ceil(ay0 - 0.5); m2 <= Math.floor(ay1 + 0.5); m2++) {
      ctx.beginPath(); ctx.moveTo(padL, Y(m2 + 0.5)); ctx.lineTo(padL + plotW, Y(m2 + 0.5)); ctx.stroke();
    }
    ctx.setLineDash([]);

    /* 音高曲线：逐段上色 */
    ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    var prev = null;
    for (var k = 0; k < vis.length; k++) {
      var p = vis[k];
      var off = Math.abs(p.midi - Math.round(p.midi)) * 100;
      var color = off <= 25 ? '#4ade80' : (off <= 50 ? '#fbbf24' : '#f87171');
      if (prev && p.t - prev.t < 350) {
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(X(prev.t), Y(prev.midi));
        ctx.lineTo(X(p.t), Y(p.midi));
        ctx.stroke();
      }
      prev = p;
    }

    /* 当前点 */
    var last = vis[vis.length - 1];
    if (last && now - last.t < 500) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(X(last.t), Y(last.midi), 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(X(last.t), Y(last.midi), 7.5, 0, Math.PI * 2); ctx.stroke();
    }

    /* 右边界 = 现在 */
    ctx.strokeStyle = 'rgba(148,163,184,.35)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL + plotW, padT); ctx.lineTo(padL + plotW, padT + plotH); ctx.stroke();
    ctx.fillStyle = '#7b8aad';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('← 过去 ' + S.liveWin + ' 秒      现在', padL + 6, padT + 1);
  }

  /** 声波（时域波形），横向铺满最近约 85ms 的声音 */
  function drawScope() {
    var cv = $('scope');
    if (!cv || !S.buf) return;
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth || 640, h = cv.clientHeight || 56;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(148,163,184,.22)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();

    var n = S.buf.length;
    var mid = h / 2;
    var amp = (h / 2 - 3) * 2.4;                 // 放大，看得清
    ctx.strokeStyle = S.level > 0.35 ? '#f87171' : '#60a5fa';
    ctx.beginPath();
    for (var x = 0; x < w; x++) {
      var i0 = Math.floor(x * n / w), i1 = Math.floor((x + 1) * n / w);
      if (i1 <= i0) i1 = i0 + 1;
      var mnv = 1, mxv = -1;
      for (var i = i0; i < i1 && i < n; i++) {
        var v = S.buf[i];
        if (v < mnv) mnv = v;
        if (v > mxv) mxv = v;
      }
      if (mnv > mxv) { mnv = 0; mxv = 0; }
      var y0 = mid - mxv * amp, y1 = mid - mnv * amp;
      if (y0 < 0) y0 = 0; if (y1 > h) y1 = h;
      ctx.moveTo(x + 0.5, y0);
      ctx.lineTo(x + 0.5, y1);
    }
    ctx.stroke();
  }

  /* ============================================================
   * 界面：实时读数
   * ============================================================ */
  function resetReadout() {
    S.hold = { midi: null, n: 0, sum: 0, min: 0, max: 0, conf: 0, rms: 0 };
    $('noteSol').textContent = '--';
    $('noteOct').textContent = '';
    $('noteLetter').textContent = '等待开始…';
    $('noteHint').textContent = '一次只唱一个长音，唱稳 2~3 秒';
    $('freqVal').textContent = '--';
    $('centsVal').textContent = '--';
    $('centsVal').className = '';
    $('confVal').textContent = '--';
    $('levelFill').style.width = '0%';
    var nd = $('needle');
    nd.style.left = '50%';
    nd.className = 'needle';
    highlightLadder(null);
    highlightRef(null);
  }

  function updateReadout(cur) {
    /* 音量条 */
    var db = 20 * Math.log10(S.level + 1e-6);           // -120 ~ 0
    var lv = clamp((db + 60) / 55, 0, 1);
    var fill = $('levelFill');
    fill.style.width = (lv * 100).toFixed(0) + '%';
    fill.style.background = S.level > 0.35 ? '#f87171' : (S.level > 0.004 ? '#4ade80' : '#64748b');

    if (!cur) {
      $('freqVal').textContent = '--';
      $('centsVal').textContent = '--';
      $('centsVal').className = '';
      $('noteSol').textContent = '--';
      $('noteOct').textContent = '';
      $('noteLetter').textContent = S.running ? '没听到稳定的音高…' : '等待开始…';
      $('noteHint').textContent = S.running
        ? '把音唱长一点、稳一点；离麦克风 15~25 cm，太小声或太吵都测不到'
        : '一次只唱一个长音，唱稳 2~3 秒';
      $('confVal').textContent = '--';
      var nd = $('needle');
      nd.style.left = '50%';
      nd.className = 'needle';
      highlightLadder(null);
      highlightRef(null);
      return;
    }

    var note = PT.describeMidi(PT.freqToMidi(cur.freq, S.a4), S.a4, S.useFlat);
    cur.note = note;
    /* 每日音域记录：只在「稳定唱住的音」上记（防抖动/谐波假音）
       条件：① 同一个音连续 6 帧（约 0.4 秒）② 这 6 帧平均置信度 ≥ 0.8
             ③ 音量够（RMS ≥ 0.008）④ 期间音高抖动 < 60 音分 */
    var H = S.hold || (S.hold = { midi: null, n: 0, sum: 0, min: 0, max: 0, conf: 0, rms: 0 });
    if (H.midi === note.midi && cur.midi !== undefined) {
      H.n++; H.sum += cur.midi;
      if (cur.midi < H.min) H.min = cur.midi;
      if (cur.midi > H.max) H.max = cur.midi;
      H.conf += cur.conf; H.rms = Math.max(H.rms, cur.rms);
    } else {
      H.midi = note.midi; H.n = 1; H.sum = cur.midi; H.min = cur.midi; H.max = cur.midi;
      H.conf = cur.conf; H.rms = cur.rms;
    }
    if (H.n === 6) {
      var avgConf = H.conf / 6;
      var spread = (H.max - H.min) * 100;         // 抖动（音分）
      var okNote = avgConf >= 0.8 && H.rms >= 0.008 && spread <= 60;
      if (okNote) recordRangeNote(note.midi);
      else { S.lastReject = { midi: note.midi, conf: avgConf, spread: spread, rms: H.rms }; S.lastRejectAt = Date.now(); }
    }

    $('noteSol').textContent = note.solfege;
    $('noteOct').textContent = note.octave;
    $('noteLetter').textContent = note.letterName + '  ·  该音标准频率 ' + num(note.freq, 2) + ' Hz';
    $('freqVal').textContent = num(cur.freq, 1);

    var c = note.cents, abs = Math.abs(c), cls, tip;
    if (abs <= 25) { cls = 'ok'; tip = '很准 👍 保持住'; }
    else if (abs <= 50) {
      cls = 'warn';
      tip = (c > 0 ? '偏高 ' : '偏低 ') + abs.toFixed(0) + ' 音分，往' + (c > 0 ? '低' : '高') + '一点点';
    } else {
      cls = 'bad';
      tip = (c > 0 ? '偏高 ' : '偏低 ') + abs.toFixed(0) + ' 音分（' + (abs / 100).toFixed(1) + ' 个半音）';
    }
    $('centsVal').textContent = (c >= 0 ? '+' : '') + c.toFixed(0);
    $('centsVal').className = 'v-' + cls;
    if (isOutOfRange(note.midi)) {
      tip += '　⚠️ 超出你的音域（' + PT.midiToName(S.rangeLow) + '–' + PT.midiToName(S.rangeHigh) + '），别硬撑';
    }
    $('noteHint').textContent = tip;
    $('confVal').textContent = Math.round(clamp(cur.conf, 0, 1) * 100) + '%';

    var nd = $('needle');
    nd.style.left = (50 + clamp(c, -50, 50)) + '%';
    nd.className = 'needle ' + cls;

    /* 如果唱的音不在当前显示的八度里，自动切过去 */
    if (note.octave !== S.ladderOctave && abs <= 50) {
      S.ladderOctave = note.octave;
      $('octaveSel').value = note.octave;
      buildLadder(); buildRefTable(); buildPracticeSelect();
    }
    highlightLadder(note.midi);
    highlightRef(note.midi);
  }

  function highlightLadder(midi) {
    var nodes = $('ladder').querySelectorAll('.lad');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.toggle('on', midi !== null && +nodes[i].dataset.midi === midi);
    }
  }
  function highlightRef(midi) {
    var rows = $('refBody').querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('on', midi !== null && +rows[i].dataset.midi === midi);
    }
  }

  /* ============================================================
   * 标准音：格子 / 频率表 / 播放
   * ============================================================ */
  function buildOctaveSelect() {
    var sel = $('octaveSel');
    sel.innerHTML = '';
    for (var o = 2; o <= 6; o++) {
      var op = document.createElement('option');
      op.value = o; op.textContent = o;
      sel.appendChild(op);
    }
    sel.value = S.ladderOctave;
  }

  /* ============================================================
   * 我的音域
   * ============================================================ */
  function isOutOfRange(midi) {
    return midi < S.rangeLow || midi > S.rangeHigh;
  }

  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}');
      if (s.a4 >= 415 && s.a4 <= 466) { S.a4 = s.a4; $('a4Input').value = s.a4; }
      if (s.useFlat) { S.useFlat = true; $('flatChk').checked = true; }
      if (s.ladderOctave >= 1 && s.ladderOctave <= 6) S.ladderOctave = s.ladderOctave;
      if (s.rangeLow && s.rangeHigh && s.rangeHigh > s.rangeLow) {
        S.rangeLow = s.rangeLow; S.rangeHigh = s.rangeHigh;
      }
      if (s.rangePreset) S.rangePreset = s.rangePreset;
      if (s.liveWin) { S.liveWin = s.liveWin; $('liveWin').value = s.liveWin; }
      if (s.scopeOn === false) {
        S.scopeOn = false; $('scopeChk').checked = false;
        $('scope').classList.add('hidden');
      }
    } catch (e) {}
  }

  function saveSettings() {
    try {
      localStorage.setItem(LS_SETTINGS, JSON.stringify({
        a4: S.a4, useFlat: S.useFlat, ladderOctave: S.ladderOctave,
        rangeLow: S.rangeLow, rangeHigh: S.rangeHigh, rangePreset: S.rangePreset,
        liveWin: S.liveWin, scopeOn: S.scopeOn
      }));
    } catch (e) {}
  }

  function buildRangeSelect() {
    var sel = $('rangeSel');
    sel.innerHTML = '';
    RANGE_PRESETS.forEach(function (p) {
      var op = document.createElement('option');
      op.value = p.id;
      op.textContent = p.label;
      sel.appendChild(op);
    });
    var known = RANGE_PRESETS.some(function (p) { return p.id === S.rangePreset; });
    if (!known) S.rangePreset = 'baritenor';
    sel.value = S.rangePreset;
    buildRangeNoteSelects();
    toggleCustomRow();
  }

  function buildRangeNoteSelects() {
    [$('rangeLowSel'), $('rangeHighSel')].forEach(function (sel) {
      sel.innerHTML = '';
      for (var m = 36; m <= 84; m++) {                 // C2 ~ C6
        var n = PT.describeMidi(m, S.a4, S.useFlat);
        var op = document.createElement('option');
        op.value = m;
        op.textContent = n.letterName + ' · ' + n.solfege + n.octave + ' · ' + num(n.freq, 1) + ' Hz';
        sel.appendChild(op);
      }
    });
    $('rangeLowSel').value = S.rangeLow;
    $('rangeHighSel').value = S.rangeHigh;
  }

  function toggleCustomRow() {
    $('rangeCustomRow').hidden = (S.rangePreset !== 'custom');
  }

  function onRangePreset(id) {
    var p = null;
    RANGE_PRESETS.forEach(function (x) { if (x.id === id) p = x; });
    if (!p) return;
    if (p.id === 'custom') {
      S.rangePreset = 'custom';
      toggleCustomRow();
      saveSettings();
      return;
    }
    var lo = PT.midiFromName(p.low), hi = PT.midiFromName(p.high);
    if (p.oct) { S.ladderOctave = p.oct; $('octaveSel').value = p.oct; }
    applyRange(lo, hi, p.id);
    setStatus('音域已设为 ' + p.low + ' – ' + p.high + '（' + num(PT.midiToFreq(lo, S.a4), 1) + ' ~ ' +
              num(PT.midiToFreq(hi, S.a4), 1) + ' Hz）。下面音阶表里灰掉的音在你的音域外，先别硬唱。');
  }

  function onCustomRange(which, midi) {
    if (!isFinite(midi)) return;
    var lo = S.rangeLow, hi = S.rangeHigh;
    if (which === 'low') lo = midi; else hi = midi;
    if (hi <= lo) { setStatus('最高音要比最低音高才可以哦～'); return; }
    S.rangePreset = 'custom';
    $('rangeSel').value = 'custom';
    toggleCustomRow();
    applyRange(lo, hi, 'custom');
  }

  function applyRange(lo, hi, presetId) {
    S.rangeLow = lo; S.rangeHigh = hi;
    if (presetId) S.rangePreset = presetId;
    toggleCustomRow();
    $('rangeLowSel').value = lo;
    $('rangeHighSel').value = hi;
    saveSettings();
    buildLadder(); buildRefTable(); buildPracticeSelect();
    renderRangeInfo();
    updateShift();
    drawChart(currentChartTrack());
    if (S.current) updateReadout(S.current);
  }

  /* ============================================================
   * 变调助手
   * ============================================================ */
  function buildShiftSelects() {
    var hi = $('songHighSel'), lo = $('songLowSel');
    var prevHi = hi.value, prevLo = lo.value;
    hi.innerHTML = '';
    lo.innerHTML = '';
    var opN = document.createElement('option');
    opN.value = '';
    opN.textContent = '不确定 / 无所谓';
    lo.appendChild(opN);
    for (var m = 36; m <= 84; m++) {                  // C2 ~ C6
      var n = PT.describeMidi(m, S.a4, S.useFlat);
      var label = n.solfege + n.octave + ' · ' + n.letterName + ' · ' + num(n.freq, 1) + ' Hz';
      var o1 = document.createElement('option');
      o1.value = m; o1.textContent = label;
      hi.appendChild(o1);
      var o2 = document.createElement('option');
      o2.value = m; o2.textContent = label;
      lo.appendChild(o2);
    }
    hi.value = prevHi || 72;                          // 默认给个典型高音 do5 = C5
    lo.value = prevLo || '';
  }

  function updateShift() {
    var box = $('shiftOut');
    var high = parseInt($('songHighSel').value, 10);
    var lowRaw = $('songLowSel').value;
    var low = (lowRaw === '' || lowRaw === null || lowRaw === undefined) ? null : parseInt(lowRaw, 10);
    if (!isFinite(high)) { box.innerHTML = '先在上面选这首歌的最高音。'; S.shiftSuggest = 0; return; }

    var rangeHi = S.rangeHigh, rangeLo = S.rangeLow;
    var need = high - rangeHi;
    var shift, advice;
    if (high <= rangeHi - 2) {
      shift = 0;
      advice = '✅ <b>原调就能唱</b>：最高音 ' + PT.midiToName(high) + ' 距离你的上限 ' + PT.midiToName(rangeHi) + ' 还有余量。';
    } else if (high <= rangeHi) {
      shift = 1;
      advice = '🟡 <b>原调勉强能唱</b>：最高音 ' + PT.midiToName(high) + ' 一直贴着你的天花板 ' + PT.midiToName(rangeHi) +
               '，唱到副歌容易累、容易飘。建议<b>降 1~2 个半音</b>更稳。';
    } else {
      shift = need + 1;
      advice = '🔴 <b>原调唱不了</b>：最高音 ' + PT.midiToName(high) + ' 比你的上限 ' + PT.midiToName(rangeHi) +
               ' 高 <b>' + need + ' 个半音</b>。至少要降 <b>' + need + '</b> 个半音，想稳一点就降 <b>' + shift + '</b> 个半音。';
    }
    S.shiftSuggest = shift;

    var out = [advice];
    if (shift > 0) {
      var newHi = high - shift;
      var seg = '移调后最高音 → <b>' + PT.midiToName(newHi) + '</b>（' + num(PT.midiToFreq(newHi, S.a4), 1) + ' Hz）';
      if (low !== null) seg += '，最低音 → <b>' + PT.midiToName(low - shift) + '</b>（' + num(PT.midiToFreq(low - shift, S.a4), 1) + ' Hz）';
      out.push(seg + '。');
    }
    if (low !== null) {
      var newLow = low - shift;
      if (newLow < rangeLo) {
        out.push('⚠️ 降 ' + shift + ' 个半音后，最低音 ' + PT.midiToName(newLow) + ' 会掉出你的音域下限 ' + PT.midiToName(rangeLo) +
                 ' —— 这首歌<b>跨度比你的音域还大</b>。别硬唱整首：先只练副歌，低音部分轻轻带过。');
      } else if ((high - low) > (rangeHi - rangeLo)) {
        out.push('ℹ️ 这首歌跨度 ' + (high - low) + ' 个半音，比你的音域（' + (rangeHi - rangeLo) + ' 个半音）还宽，唱的时候高音低音别都用全力。');
      }
    }
    box.innerHTML = out.join('<br>');
  }

  function playShiftTone() {
    var high = parseInt($('songHighSel').value, 10);
    if (!isFinite(high)) { setStatus('先在⑦里选一下这首歌的最高音。'); return; }
    var shift = high > S.rangeHigh ? (high - S.rangeHigh + 1) : 0;
    var target = high - shift;
    playTone(PT.midiToFreq(target, S.a4), 1.3, 0.25);
    setStatus('正在播放移调后的最高音 ' + PT.midiToName(target) + '（' + num(PT.midiToFreq(target, S.a4), 1) +
              ' Hz）。等这个音你能稳稳落在实时曲线的绿色带里，这首歌降 ' + shift + ' 个半音就能拿下。');
  }

  /* ============================================================
   * 每日音域记录
   * ============================================================ */
  var RANGE_KEY = 'vpm.range.v1';
  var VOICE_TYPES = [
    { id: 'bass',    name: '男低音 Bass',      short: '男低音', lo: 40, hi: 64, hz: 'E2–E4' },
    { id: 'baritone',name: '男中音 Baritone',  short: '男中音', lo: 45, hi: 65, hz: 'A2–F4' },
    { id: 'tenor',   name: '男高音 Tenor',     short: '男高音', lo: 48, hi: 72, hz: 'C3–C5' },
    { id: 'alto',    name: '女低音 Alto',      short: '女低音', lo: 53, hi: 77, hz: 'F3–F5' },
    { id: 'mezzo',   name: '女中音 Mezzo',     short: '女中音', lo: 57, hi: 81, hz: 'A3–A5' },
    { id: 'soprano', name: '女高音 Soprano',   short: '女高音', lo: 60, hi: 84, hz: 'C4–C6' }
  ];
  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function loadRangeLog() {
    try { return JSON.parse(localStorage.getItem(RANGE_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveRangeLog(o) {
    try { localStorage.setItem(RANGE_KEY, JSON.stringify(o)); } catch (e) {}
  }
  var _rangeDirty = 0;
  function recordRangeNote(midi) {
    var log = loadRangeLog(), k = todayKey();
    var d = log[k] || { low: null, high: null, notes: {} };
    var changed = false;
    if (d.low === null || midi < d.low) { d.low = midi; changed = true; }
    if (d.high === null || midi > d.high) { d.high = midi; changed = true; }
    d.notes[midi] = (d.notes[midi] || 0) + 1;
    d.updatedAt = new Date().toISOString();
    log[k] = d;
    saveRangeLog(log);
    if (changed || Date.now() - _rangeDirty > 1500) {
      _rangeDirty = Date.now();
      renderRangeLog();
      drawTrend();
      updatePassStatus();
    }
  }
  function voiceByLow(m) {
    var best = null;
    VOICE_TYPES.forEach(function (t) { if (!best || Math.abs(m - t.lo) < Math.abs(m - best.lo)) best = t; });
    return best;
  }
  function voiceByHigh(m) {
    var best = null;
    VOICE_TYPES.forEach(function (t) { if (!best || Math.abs(m - t.hi) < Math.abs(m - best.hi)) best = t; });
    return best;
  }
  function voiceText(low, high) {
    var a = voiceByLow(low), b = voiceByHigh(high);
    if (a.id === b.id) return a.name + '（' + a.hz + '）';
    return '下限像' + a.short + '，上限像' + b.short;
  }
  function rangeRow(k, d) {
    if (d.low === null || d.high === null) return '';
    var lo = PT.describeMidi(d.low, S.a4, false), hi = PT.describeMidi(d.high, S.a4, false);
    var semi = d.high - d.low;
    var isToday = (k === todayKey());
    return '<tr' + (isToday ? ' class="on"' : '') + '>' +
      '<td>' + k + (isToday ? ' <span class="muted small">(今天)</span>' : '') + '</td>' +
      '<td><b>' + lo.solfege + lo.octave + '</b> <span class="muted small">' + num(lo.freq, 1) + ' Hz</span></td>' +
      '<td><b>' + hi.solfege + hi.octave + '</b> <span class="muted small">' + num(hi.freq, 1) + ' Hz</span></td>' +
      '<td>' + semi + ' 半音 <span class="muted small">(' + (semi / 12).toFixed(1) + ' 个八度)</span></td>' +
      '<td>' + voiceText(d.low, d.high) + '</td>' +
      '<td><button class="btn btn-ghost btn-sm danger" data-del="' + k + '">删</button></td>' +
      '</tr>';
  }
  /* 导出/保存音域记录 */
  function rangeCSV(log) {
    var rows = ['date,low_note,low_hz,high_note,high_hz,semitones,octaves,voice'];
    Object.keys(log).sort().reverse().forEach(function (k) {
      var d = log[k];
      if (d.low === null || d.high === null) return;
      var lo = PT.describeMidi(d.low, S.a4, false), hi = PT.describeMidi(d.high, S.a4, false);
      rows.push([k, lo.letterName, num(lo.freq, 2), hi.letterName, num(hi.freq, 2),
                 d.high - d.low, ((d.high - d.low) / 12).toFixed(2), voiceText(d.low, d.high)].join(','));
    });
    return '\ufeff' + rows.join('\n');
  }
  function rangeJSON(log) {
    return JSON.stringify({
      app: 'vocal-pitch-monitor-range-log', version: 1,
      exportedAt: new Date().toISOString(), a4: S.a4,
      note: '每天唱到的最低/最高音（只统计稳定 ≥0.4 秒、置信度 ≥0.8、抖动 <60 音分的音）',
      days: Object.keys(log).sort().reverse().map(function (k) {
        var d = log[k];
        var lo = PT.describeMidi(d.low, S.a4, false), hi = PT.describeMidi(d.high, S.a4, false);
        return { date: k, low: lo.letterName, lowHz: +num(lo.freq, 2), high: hi.letterName, highHz: +num(hi.freq, 2),
                 semitones: d.high - d.low, voice: voiceText(d.low, d.high), noteCounts: d.notes };
      })
    }, null, 1);
  }
  function rangeStamp() {
    var d = new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
  }
  function renderRangeFolder() {
    var el = $('rangeFolderName');
    if (!el) return;
    var RF = window.RecordFolder;
    var b = $('rangeFolderBtn');
    if (!RF || !RF.supported()) {
      el.textContent = '记录文件夹：当前浏览器不能直接写文件夹，可用「⬇ 导出 JSON / CSV」下载';
      if (b) b.disabled = true;
      return;
    }
    if (b) b.disabled = false;
    var n = RF.name();
    el.textContent = n
      ? ('记录文件夹：' + n + '（音域 + K歌记录共用）')
      : '记录文件夹：未设置（点「📁 选择记录文件夹」授权一次，两个页面共用）';
    if (b) b.textContent = n ? '📁 更换记录文件夹' : '📁 选择记录文件夹';
  }
  function chooseRangeFolder() {
    var RF = window.RecordFolder;
    if (!RF || !RF.supported()) {
      setStatus('这个浏览器不能直接写文件夹，请用 Chrome / Edge；也可以继续用「⬇ 导出 JSON / CSV」。');
      return;
    }
    RF.pick().then(function (h) {
      renderRangeFolder();
      setStatus('✅ 记录文件夹已设为 <b>' + h.name + '</b>：音域记录和 K 歌练习记录都会写到这里。');
    }).catch(function (e) {
      if (e && e.name !== 'AbortError') setStatus('设置记录文件夹失败：' + (e.message || e));
    });
  }
  function saveRangeToFolder() {
    var log = loadRangeLog();
    var RF = window.RecordFolder;
    if (!RF || !RF.supported()) {
      if (!Object.keys(log).length) { setStatus('还没有音域记录可保存，当前浏览器也不能直接写文件夹。'); return; }
      downloadRangeFiles(log);
      return;
    }
    var doWrite = function () {
      if (!Object.keys(log).length) {
        renderRangeFolder();
        setStatus('✅ 记录文件夹已设为 <b>' + RF.name() + '</b>；等有音域记录后再点「💾 保存音域记录」即可。');
        return Promise.resolve();
      }
      return writeRangeFiles(log);
    };
    if (!RF.get()) {
      RF.pick().then(doWrite).catch(function (e) {
        if (e && e.name !== 'AbortError') setStatus('保存失败：' + (e.message || e));
      });
      return;
    }
    doWrite().catch(function (e) {
      if (e && (e.code === 'NO_PERM' || e.code === 'NO_FOLDER')) {
        return RF.pick().then(doWrite).catch(function (e2) {
          if (e2 && e2.name !== 'AbortError') setStatus('保存失败：' + (e2.message || e2));
        });
      }
      if (e && e.name !== 'AbortError') setStatus('保存失败：' + (e.message || e));
    });
  }
  function writeRangeFiles(log) {
    var RF = window.RecordFolder;
    var base = 'range-log-' + rangeStamp();
    return RF.writeFiles([
      { name: base + '.json', data: rangeJSON(log) },
      { name: base + '.csv', data: rangeCSV(log) }
    ]).then(function () {
      renderRangeFolder();
      setStatus('✅ 已存到记录文件夹：' + base + '.json / ' + base + '.csv');
    });
  }
  function downloadRangeFiles(log) {
    var base = 'range-log-' + rangeStamp();
    var files = [[base + '.json', rangeJSON(log), 'application/json'], [base + '.csv', rangeCSV(log), 'text/csv']];
    files.forEach(function (f) {
      var blob = new Blob([f[1]], { type: f[2] + ';charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = f[0];
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    });
    setStatus('已下载：' + base + '.json / .csv');
  }

  function renderRangeLog() {
    var body = $('rangeBody'), today = $('rangeToday');
    if (!body) return;
    var log = loadRangeLog();
    var keys = Object.keys(log).sort().reverse();
    var t = log[todayKey()];
    if (t && t.low !== null && t.high !== null) {
      var lo = PT.describeMidi(t.low, S.a4, false), hi = PT.describeMidi(t.high, S.a4, false);
      var semi = t.high - t.low;
      today.innerHTML = '📅 <b>今天（' + todayKey() + '）</b>：最低 <b>' + lo.solfege + lo.octave + '</b>（' + num(lo.freq, 1) +
        ' Hz） · 最高 <b>' + hi.solfege + hi.octave + '</b>（' + num(hi.freq, 1) + ' Hz） · 跨度 <b>' + semi +
        ' 半音</b>（' + (semi / 12).toFixed(1) + ' 个八度）<br>声部判断：<b>' + voiceText(t.low, t.high) + '</b>' +
        '　<button class="btn btn-ghost btn-sm" id="rangeUseBtn2">用这个更新「我的音域」</button>';
      var b2 = $('rangeUseBtn2');
      if (b2) b2.addEventListener('click', function () { $('rangeUseBtn').click(); });
    } else {
      today.textContent = '今天还没有记录 —— 点「开始收音」，从最低能唱的音一路往上唱到最高，每个音停 0.4 秒左右（稳定唱住才会被记下）。';
    }
    var rj = $('rangeReject');
    if (rj) {
      if (S.lastReject && Date.now() - (S.lastRejectAt || 0) < 30000) {
        var rn = PT.describeMidi(S.lastReject.midi, S.a4, false);
        rj.innerHTML = '🧹 刚过滤掉一个不靠谱的音：<b>' + rn.letterName + '</b>（' + num(rn.freq, 0) + ' Hz）—— ' +
          '置信度 ' + Math.round(S.lastReject.conf * 100) + '% · 抖动 ' + Math.round(S.lastReject.spread) + ' 音分 · 音量 ' +
          S.lastReject.rms.toFixed(3) + '（未记入音域）';
        rj.style.display = '';
      } else rj.style.display = 'none';
    }
    body.innerHTML = keys.length
      ? keys.map(function (k) { return rangeRow(k, log[k]); }).join('')
      : '<tr><td colspan="6" class="muted center">还没有记录</td></tr>';
    body.querySelectorAll('button[data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.dataset.del;
        var lg = loadRangeLog(); delete lg[k]; saveRangeLog(lg); renderRangeLog(); drawTrend(); updatePassStatus();
      });
    });
  }

  /* ============================================================
   * 换声区（passaggio）扫描 + 音域趋势
   *   ① 趋势图：把 vpm.range.v1 的每日最低/最高音画成时间轴
   *   ② 换声区扫描：从起始音往上逐半音，每音「先听参考音、再跟着唱」，
   *      记录每个音的抖动 / 唱住比例 / 音量，用来找换声点（换声区）
   *   数据仍然只存在浏览器本地 + 用户自己授权的记录文件夹。
   * ============================================================ */
  var PASS_KEY = 'vpm.passaggio.v1';
  var SCAN_LISTEN_MS = 1200;   // 每个音先听 1.2 秒参考音
  var SCAN_SING_MS = 2200;     // 再跟着唱 2.2 秒
  var SCAN_STEPS = 12;         // 一次扫一个八度（12 个半音）
  /* 男声第一换声区的常见位置：仅作参考，个体差异很大 */
  var PASS_REF = [
    { id: 'bass',     name: '男低音', lo: 'A3', hi: 'C4' },
    { id: 'baritone', name: '男中音', lo: 'C4', hi: 'E♭4' },
    { id: 'tenor',    name: '男高音', lo: 'E4', hi: 'A4' }
  ];

  function median(a) {
    var b = (a || []).filter(function (x) { return typeof x === 'number' && isFinite(x); })
      .sort(function (x, y) { return x - y; });
    if (!b.length) return 0;
    var i = Math.floor(b.length / 2);
    return b.length % 2 ? b[i] : (b[i - 1] + b[i]) / 2;
  }
  function loadPassLog() {
    try { return JSON.parse(localStorage.getItem(PASS_KEY) || '{}'); } catch (e) { return {}; }
  }
  function savePassLog(o) {
    try { localStorage.setItem(PASS_KEY, JSON.stringify(o)); } catch (e) {}
  }
  function hasPassData() {
    return !!((loadPassLog().scans || []).length || trendSeries(loadRangeLog()).length);
  }
  function refBands() {
    return PASS_REF.map(function (r) {
      return { id: r.id, name: r.name, lo: r.lo, hi: r.hi,
               loMidi: PT.midiFromName(r.lo), hiMidi: PT.midiFromName(r.hi) };
    });
  }

  /** 每日音域记录 -> 按日期升序的趋势序列 */
  function trendSeries(log) {
    log = log || {};
    return Object.keys(log).sort().map(function (k) {
      var d = log[k];
      if (!d || d.low === null || d.high === null || d.low === undefined || d.high === undefined) return null;
      return { date: k, low: d.low, high: d.high, semis: d.high - d.low };
    }).filter(function (x) { return !!x; });
  }

  /** 汇总所有日期里，每个音被「稳定唱住」过多少次 */
  function noteHistogram(log) {
    var h = {}, l = log || {};
    Object.keys(l).forEach(function (k) {
      var n = l[k] && l[k].notes ? l[k].notes : {};
      Object.keys(n).forEach(function (m) { h[m] = (h[m] || 0) + n[m]; });
    });
    return h;
  }

  /**
   * 在你「唱到过的最低~最高」之间，找出从来没被稳定唱到过的音（音域里的洞）。
   * 只把「不贴着上下两端、且跨度 2~7 个半音」的洞算作换声区候选。
   */
  function rangeHoles(log) {
    var hist = noteHistogram(log);
    var ms = Object.keys(hist).map(Number).filter(function (m) { return isFinite(m); });
    if (ms.length < 2) return { ok: false, low: null, high: null, holes: [], runs: [], hist: hist };
    var lo = Math.min.apply(null, ms), hi = Math.max.apply(null, ms);
    var holes = [], m;
    for (m = lo; m <= hi; m++) { if (!hist[m]) holes.push(m); }
    var runs = [], cur = null;
    holes.forEach(function (x) {
      if (cur && x === cur.hi + 1) cur.hi = x;
      else { cur = { lo: x, hi: x }; runs.push(cur); }
    });
    var inner = runs.filter(function (r) {
      var len = r.hi - r.lo + 1;
      /* 换声区总在音域的上半部分，所以只认「在上半段、不贴两端、宽 2~7 个半音」的洞 */
      return r.lo > lo + 1 && r.hi < hi - 1 && len >= 2 && len <= 7 && r.lo >= lo + (hi - lo) * 0.45;
    });
    inner.sort(function (a, b) { return (b.hi - b.lo) - (a.hi - a.lo); });
    return { ok: true, low: lo, high: hi, holes: holes, runs: inner, allRuns: runs, hist: hist };
  }

  /**
   * 纯函数：从一次「半音阶上行扫描」的结果里推测换声点。
   * notes: [{ midi, frames, steadyFrames, steadyRatio, centsSd, rmsMed, volRatio }]，midi 升序
   * 判断线索（任意两条同时出现才算，避免偶发抖动误判）：
   *   pitch    抖动突然明显变大（往上硬顶）
   *   unsteady 唱住的比例骤降
   *   push     音量突然要加大（>1.8 倍）
   *   drop     音量突然掉一半（换到假声 / 漏气）
   */
  function analyzePassaggio(notes) {
    var all = (notes || []).filter(function (n) { return n && isFinite(n.midi); })
      .slice().sort(function (a, b) { return a.midi - b.midi; });
    if (!all.length) return { ok: false, breakMidi: null, zone: null, reason: '还没有扫描数据。', list: [] };
    var list = all.filter(function (n) { return n.frames >= 5; });
    var thin = all.filter(function (n) { return n.frames > 0 && n.frames < 5; });
    if (list.length < 4) {
      return { ok: false, breakMidi: null, zone: null, list: list,
               reason: '有效数据太少：一次至少要有 4 个音各唱住 5 帧以上（每个音大约 2.2 秒）。' };
    }
    /* 连续的「几乎唱不出来」段，且在全段最上面 -> 那是天花板，不是换声点 */
    var top = list[list.length - 1];
    var above = thin.filter(function (n) { return n.midi > top.midi; });
    if (above.length >= 2) {
      return { ok: false, breakMidi: null, zone: null, list: list, ceilingMidi: above[0].midi,
               reason: '从 ' + PT.midiToName(above[0].midi) + ' 往上基本唱不出来了（' + above.length +
                       ' 个音都没唱住），这更像是当前的高音上限，不是换声点。等能稳定唱到 ' +
                       PT.midiToName(top.midi) + ' 之后再扫一次。' };
    }

    var baseN = Math.max(2, Math.ceil(list.length / 3));
    var baseList = list.slice(0, baseN);   // 基线只用最下面那 1/3 的音：它们一定还在胸声里
    var baseSd = Math.max(25, median(baseList.map(function (n) { return n.centsSd; })));
    var baseSteady = Math.max(0.5, median(baseList.map(function (n) { return n.steadyRatio; })));
    var baseRms = median(baseList.map(function (n) { return n.rmsMed; }).filter(function (v) { return v > 1e-5; }));

    list.forEach(function (n, i) {
      var prev = list[i - 1];
      n.volRatio = (prev && prev.rmsMed > 1e-5) ? n.rmsMed / prev.rmsMed : 1;
      n.flags = [];
      if (n.centsSd > Math.max(35, baseSd * 2.2)) n.flags.push('pitch');
      if (n.steadyRatio < baseSteady * 0.5) n.flags.push('unsteady');
      if (i > 0 && n.volRatio > 1.8) n.flags.push('push');
      if (i > 0 && n.volRatio < 0.55) n.flags.push('drop');
    });

    var idx = -1, i;
    for (i = 1; i < list.length; i++) {
      if (list[i].flags.length && (i + 1 >= list.length || list[i + 1].flags.length)) { idx = i; break; }
    }
    if (idx < 0) {
      for (i = 1; i < list.length; i++) { if (list[i].flags.length) { idx = i; break; } }
    }
    if (idx < 0) {
      return { ok: false, breakMidi: null, zone: null, list: list, baseSd: baseSd, baseSteady: baseSteady,
               reason: '这一段唱得很平顺：' + PT.midiToName(list[0].midi) + ' 到 ' +
                       PT.midiToName(list[list.length - 1].midi) + ' 都没出现明显的换声痕迹。' +
                       '可以把起始音调低 2~3 个半音，或者再往上多扫几个音试试。' };
    }
    var bm = list[idx].midi;
    var zone = { lo: bm, hi: Math.min(list[list.length - 1].midi, bm + 2) };
    return { ok: true, breakMidi: bm, zone: zone, list: list, baseSd: baseSd, baseSteady: baseSteady,
             baseRms: baseRms, at: idx, reason: passReasonText(list[idx]) };
  }

  var PASS_FLAG_TEXT = {
    pitch: '音高开始飘', unsteady: '唱住的比例掉下来了',
    push: '音量突然要加大', drop: '音量突然掉下来'
  };
  function passReasonText(n) {
    var why = (n.flags || []).map(function (f) {
      if (f === 'pitch') return '音高抖动 ' + Math.round(n.centsSd) + ' 音分，明显比下面的音大';
      if (f === 'unsteady') return '只有 ' + Math.round(n.steadyRatio * 100) + '% 的时间在 ±50 音分内';
      if (f === 'push') return '音量突然要加大到上一个音的 ' + n.volRatio.toFixed(1) + ' 倍（往上硬顶的典型信号）';
      if (f === 'drop') return '音量突然掉到上一个音的 ' + n.volRatio.toFixed(1) + '（换到假声 / 漏气的典型信号）';
      return f;
    });
    return '在 ' + PT.midiToName(n.midi) + ' 附近检测到换声痕迹：' + why.join('；') + '。';
  }

  /** 当前生效的换声点：手动 > 最近一次扫描 > 音域空洞推测 */
  function currentPassaggio() {
    var log = loadPassLog();
    if (log.manual !== null && log.manual !== undefined) {
      return { midi: log.manual, zone: { lo: log.manual, hi: log.manual + 2 }, source: 'manual',
               reason: '你在下面手动指定的换声点。' };
    }
    var scans = log.scans || [];
    for (var i = scans.length - 1; i >= 0; i--) {
      var s = scans[i];
      if (s && s.breakMidi !== null && s.breakMidi !== undefined) {
        return { midi: s.breakMidi, zone: s.zone || { lo: s.breakMidi, hi: s.breakMidi + 2 }, source: 'scan',
                 at: s.at, reason: s.reason || '' };
      }
    }
    var holes = rangeHoles(loadRangeLog());
    if (holes.runs && holes.runs.length) {
      var run = holes.runs[0];
      return { midi: run.lo, zone: { lo: run.lo, hi: run.hi }, source: 'hole',
               reason: '音域记录里 ' + PT.midiToName(run.lo) + '–' + PT.midiToName(run.hi) +
                       ' 从来没被稳定唱到过，像是音域中间的一段空洞（只是推测）。' };
    }
    return { midi: null, zone: null, source: null, reason: '' };
  }
  function passSourceName(src) {
    return src === 'manual' ? '手动指定' : (src === 'scan' ? '扫描得出' : '音域空洞推测');
  }
  /** 和三个男声换声区的常见位置比一比 */
  function passCompare(midi) {
    var bands = refBands(), hits = [], near = null;
    bands.forEach(function (b) {
      b._d = midi < b.loMidi ? (b.loMidi - midi) : (midi > b.hiMidi ? (midi - b.hiMidi) : 0);
      if (b._d === 0) hits.push(b);
      if (!near || b._d < near._d) near = b;
    });
    var parts = [];
    if (hits.length > 1) {
      /* 边界音（比如 C4）同时属于两个声部的换声区，两个都报出来 */
      parts.push('正好在' + hits.map(function (b) {
        return b.name + '换声区（' + b.lo + '–' + b.hi + '）';
      }).join('和') + '的交界处（' + PT.midiToName(midi) + '）');
    } else if (hits.length === 1) {
      parts.push('正好落在' + hits[0].name + '换声区（' + hits[0].lo + '–' + hits[0].hi + '）里');
    } else {
      parts.push('最接近' + near.name + '换声区（' + near.lo + '–' + near.hi + '）');
    }
    var t = bands[2];
    if (midi < t.loMidi) parts.push('离男高音换声区下限 ' + t.lo + ' 还差 ' + (t.loMidi - midi) + ' 个半音');
    else if (midi > t.hiMidi) parts.push('比男高音换声区上限 ' + t.hi + ' 还高 ' + (midi - t.hiMidi) + ' 个半音');
    else parts.push('已经在男高音换声区（' + t.lo + '–' + t.hi + '）里面了');
    return parts.join('；');
  }

  /* ---------- 扫描流程 ---------- */

  function defaultScanStart() {
    return clamp((S.rangeHigh || 69) - (SCAN_STEPS - 1), 40, 79);
  }
  function buildPassStartSelect() {
    var sel = $('passStartSel');
    if (!sel) return;
    var keep = parseInt(sel.value, 10);
    sel.innerHTML = '';
    for (var m = 40; m <= 79; m++) {
      var n = PT.describeMidi(m, S.a4, S.useFlat);
      var op = document.createElement('option');
      op.value = String(m);
      op.textContent = n.letterName + ' · ' + n.solfege + n.octave + ' · ' + num(n.freq, 1) + ' Hz';
      sel.appendChild(op);
    }
    sel.value = String(isFinite(keep) ? keep : defaultScanStart());
  }
  function buildPassManualSelect() {
    var sel = $('passManualSel');
    if (!sel) return;
    var log = loadPassLog();
    var keep = (log.manual === null || log.manual === undefined) ? '' : String(log.manual);
    sel.innerHTML = '';
    var opA = document.createElement('option');
    opA.value = '';
    opA.textContent = '自动（用扫描结果 / 音域空洞推测）';
    sel.appendChild(opA);
    for (var m = 40; m <= 84; m++) {
      var n = PT.describeMidi(m, S.a4, S.useFlat);
      var op = document.createElement('option');
      op.value = String(m);
      op.textContent = n.letterName + ' · ' + n.solfege + n.octave;
      sel.appendChild(op);
    }
    sel.value = keep;
  }
  function onPassManual(v) {
    var log = loadPassLog();
    log.manual = (v === '' || v === null || v === undefined) ? null : parseInt(v, 10);
    if (log.manual !== null && !isFinite(log.manual)) log.manual = null;
    log.updatedAt = new Date().toISOString();
    savePassLog(log);
    renderPassaggio();
    setStatus(log.manual === null
      ? '换声点改回「自动」—— 会用最近一次扫描的结果，没有扫描就用音域空洞推测。'
      : '已把换声点手动设为 <b>' + PT.midiToName(log.manual) + '</b>（趋势图上的橙色虚线会跟着走）。');
  }

  function startPassScan() {
    if (S.scan && S.scan.active) { abortPassScan(); setStatus('已手动结束换声区扫描。'); return; }
    if (!S.running) { setStatus('先点①里的「开始收音」并允许麦克风，再回来点「🎙 开始换声区扫描」。'); return; }
    var sel = $('passStartSel');
    var start = parseInt(sel && sel.value, 10);
    if (!isFinite(start)) start = defaultScanStart();
    var notes = [];
    for (var i = 0; i < SCAN_STEPS; i++) {
      notes.push({ midi: start + i, frames: 0, steadyFrames: 0, cents: [], rms: [],
                   centsSd: 0, centsAbs: 0, avgCents: 0, rmsMed: 0, steadyRatio: 0, coverRatio: 0, flags: [] });
    }
    S.scan = { active: true, notes: notes, idx: 0, t0: 0, phase: 'listen', played: -1, lastUi: 0 };
    var b = $('passScanBtn');
    if (b) { b.textContent = '⏹ 结束扫描'; b.classList.add('on'); }
    var total = Math.round(SCAN_STEPS * (SCAN_LISTEN_MS + SCAN_SING_MS) / 1000);
    setStatus('🎙 换声区扫描开始：<b>' + PT.midiToName(start) + ' → ' + PT.midiToName(start + SCAN_STEPS - 1) +
              '</b>，约 ' + total + ' 秒。每个音先听 1.2 秒参考音、再跟着唱 2.2 秒。' +
              '<b>请戴耳机</b>，唱的时候音量保持和平时一样 —— 不要为了唱上去刻意加大，那正是要检测的东西。');
    renderScanProgress();
  }

  /** 中途放弃（不保存） */
  function abortPassScan() {
    if (S.scan) S.scan.active = false;
    var b = $('passScanBtn');
    if (b) { b.textContent = '🎙 开始换声区扫描'; b.classList.remove('on'); }
  }

  /** 由主分析循环按帧驱动：analyze() -> scanFeed() */
  function scanFeed(ts, cur) {
    var sc = S.scan;
    if (!sc || !sc.active) return;
    if (!sc.t0) sc.t0 = ts;
    var noteMs = SCAN_LISTEN_MS + SCAN_SING_MS;
    var el = ts - sc.t0;
    var idx = Math.floor(el / noteMs);
    if (idx >= sc.notes.length) { finishPassScan(); return; }
    if (idx < 0) idx = 0;
    var n = sc.notes[idx];
    var inNote = el - idx * noteMs;
    sc.idx = idx;
    if (sc.played !== idx) {
      sc.played = idx;
      sc.phase = 'listen';
      playTone(PT.midiToFreq(n.midi, S.a4), SCAN_LISTEN_MS / 1000 - 0.15, 0.22);
    }
    if (inNote < SCAN_LISTEN_MS) { sc.phase = 'listen'; return; }
    sc.phase = 'sing';
    if (cur) {
      var cents = (cur.midi - n.midi) * 100;
      n.cents.push(cents);
      n.rms.push(cur.rms);
      n.frames++;
      if (Math.abs(cents) <= 50 && cur.conf >= 0.6) n.steadyFrames++;
    }
    if (ts - sc.lastUi > 250) { sc.lastUi = ts; renderScanProgress(); }
  }

  function renderScanProgress() {
    var sc = S.scan, el = $('passResult');
    if (!sc || !el) return;
    var n = sc.notes[sc.idx];
    if (!n) return;
    el.innerHTML = '🎙 正在扫描：第 <b>' + (sc.idx + 1) + ' / ' + sc.notes.length + '</b> 个音 <b>' +
      PT.midiToName(n.midi) + '</b>（' + num(PT.midiToFreq(n.midi, S.a4), 1) + ' Hz）—— ' +
      (sc.phase === 'listen' ? '<b>先听参考音</b>，这几秒别出声' : '<b>跟着唱</b>，音量保持和平时一样');
  }

  function finishPassScan() {
    var sc = S.scan;
    if (!sc) return;
    var expect = Math.max(6, Math.round(SCAN_SING_MS / (S.analysisInterval || 60)));
    sc.notes.forEach(function (n) {
      n.frames = n.cents.length;
      n.expectFrames = expect;
      n.centsSd = std(n.cents);
      n.avgCents = mean(n.cents);
      n.centsAbs = mean(n.cents.map(function (c) { return Math.abs(c); }));
      n.rmsMed = median(n.rms);
      n.steadyRatio = Math.min(1, n.steadyFrames / expect);
      n.coverRatio = Math.min(1, n.frames / expect);
      delete n.cents; delete n.rms;
    });
    var res = analyzePassaggio(sc.notes);
    var log = loadPassLog();
    log.scans = (log.scans || []).concat([{
      at: new Date().toISOString(), a4: S.a4,
      startMidi: sc.notes[0].midi, endMidi: sc.notes[sc.notes.length - 1].midi,
      breakMidi: res.breakMidi, zone: res.zone, reason: res.reason, notes: sc.notes
    }]);
    log.scans = log.scans.slice(-20);
    log.updatedAt = new Date().toISOString();
    savePassLog(log);
    S.lastScanResult = res;
    abortPassScan();
    renderPassaggio();
    setStatus('✅ 换声区扫描完成。' + (res.ok
      ? ('检测到换声点候选 <b>' + PT.midiToName(res.breakMidi) + '</b>（' + passCompare(res.breakMidi) + '）。')
      : ('没有检测到明显的换声点 —— ' + res.reason)));
  }

  /* ---------- 渲染 ---------- */

  function updatePassStatus() {
    var st = $('passStatus');
    if (!st) return;
    var log = loadPassLog();
    var series = trendSeries(loadRangeLog());
    var msg = '每日音域记录 <b>' + series.length + '</b> 天 · 换声区扫描 <b>' + ((log.scans || []).length) + '</b> 次';
    msg += series.length < 2
      ? '。趋势图至少要有 <b>2 天</b>记录才看得出来 —— 每天开着麦克风唱 1 分钟就够。'
      : '。';
    st.innerHTML = msg;
  }

  function passResultHtml() {
    var pass = currentPassaggio();
    if (pass.midi === null) {
      return '还没有换声点。三个办法：<br>' +
        '① <b>最准</b>：点「🎙 开始换声区扫描」，从你唱得最舒服的中声区开始，逐半音往上扫一个八度；<br>' +
        '② 多唱几天，让每日音域记录里的「空洞」自己暴露出来；<br>' +
        '③ 已经知道自己换声点的话，直接在下面「我的换声点」里手动指定。';
    }
    var n = PT.describeMidi(pass.midi, S.a4, S.useFlat);
    var zone = pass.zone ? (PT.midiToName(pass.zone.lo) + '–' + PT.midiToName(pass.zone.hi)) : PT.midiToName(pass.midi);
    return '🎯 换声点候选：<b>' + n.letterName + '</b>（' + n.solfege + n.octave + ' · ' + num(n.freq, 1) + ' Hz）' +
      ' · 换声区 <b>' + zone + '</b> · 来源：' + passSourceName(pass.source) +
      '<br>对照：' + passCompare(pass.midi) +
      (pass.reason ? '<br>' + pass.reason : '') +
      '<br><span class="muted small">换声点是「唱到这里发声方式要换挡」的位置，不是缺陷；' +
      '找到它才好针对性地练混声，而不是硬顶。</span>';
  }

  function renderPassTable() {
    var body = $('passBody');
    if (!body) return;
    var log = loadPassLog();
    var scans = log.scans || [];
    var last = scans.length ? scans[scans.length - 1] : null;
    var list = (last && last.notes) ? last.notes.filter(function (n) { return n.frames > 0; }) : [];
    if (!list.length) {
      body.innerHTML = '<tr><td colspan="6" class="muted center">还没有扫描记录 —— 点「🎙 开始换声区扫描」做第一次</td></tr>';
      return;
    }
    var breakMidi = (S.lastScanResult && S.lastScanResult.ok) ? S.lastScanResult.breakMidi : last.breakMidi;
    body.innerHTML = list.map(function (n) {
      var info = PT.describeMidi(n.midi, S.a4, S.useFlat);
      var tags = (n.flags || []).map(function (f) {
        var cls = (f === 'pitch' || f === 'unsteady') ? 'bad' : 'warn';
        return '<span class="pass-tag ' + cls + '">' + (PASS_FLAG_TEXT[f] || f) + '</span>';
      }).join('');
      if (!tags) tags = '<span class="pass-tag ok">平顺</span>';
      return '<tr' + (n.midi === breakMidi ? ' class="pass-break"' : '') + '>' +
        '<td>' + info.letterName + ' <span class="muted small">' + info.solfege + info.octave + '</span></td>' +
        '<td>' + Math.round((n.coverRatio || 0) * 100) + '%</td>' +
        '<td>' + Math.round((n.steadyRatio || 0) * 100) + '%</td>' +
        '<td>' + Math.round(n.centsSd || 0) + ' 音分</td>' +
        '<td>' + num((n.rmsMed || 0) * 100, 1) + '</td>' +
        '<td>' + tags + '</td>' +
        '</tr>';
    }).join('');
  }

  function renderPassaggio() {
    updatePassStatus();
    buildPassManualSelect();
    var out = $('passResult');
    if (out) out.innerHTML = passResultHtml();
    renderPassTable();
    drawTrend();
  }

  /** 音域趋势图：横轴=日期，纵轴=音高，竖线=当天最低~最高音 */
  function drawTrend() {
    var cv = $('trendChart');
    if (!cv) return;
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth || 640, h = cv.clientHeight || 300;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    var ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var padL = 54, padR = 66, padT = 14, padB = 26;
    var plotW = Math.max(40, w - padL - padR), plotH = Math.max(40, h - padT - padB);

    var rlog = loadRangeLog();
    var series = trendSeries(rlog);
    var holes = rangeHoles(rlog);
    var pass = currentPassaggio();

    /* 纵轴范围：音域设置 + 记录 + 换声点，都装进去 */
    var lo = (S.rangeLow || 45) - 2, hi = (S.rangeHigh || 69) + 2;
    series.forEach(function (d) { lo = Math.min(lo, d.low - 1); hi = Math.max(hi, d.high + 1); });
    if (pass.zone) { lo = Math.min(lo, pass.zone.lo - 1); hi = Math.max(hi, pass.zone.hi + 1); }
    lo = Math.floor(lo); hi = Math.ceil(hi);
    if (hi - lo < 14) hi = lo + 14;

    function Y(m) { return padT + (hi - m) / (hi - lo) * plotH; }
    function X(i) { return series.length <= 1 ? padL + plotW / 2 : padL + i / (series.length - 1) * plotW; }

    /* 背景：三个男声换声区的常见位置 */
    refBands().forEach(function (b) {
      var y0 = Y(b.hiMidi + 0.5), y1 = Y(b.loMidi - 0.5);
      ctx.fillStyle = b.id === 'tenor' ? 'rgba(167,139,250,.12)' : 'rgba(96,165,250,.07)';
      ctx.fillRect(padL, y0, plotW, Math.max(1, y1 - y0));
      ctx.fillStyle = 'rgba(147,161,192,.75)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(b.name + '换声区 ' + b.lo + '–' + b.hi, padL + 4, y0 + 11);
    });

    /* 每八度的 C 画一条横线当刻度 */
    ctx.font = '10px system-ui, sans-serif';
    for (var m = lo; m <= hi; m++) {
      if (((m % 12) + 12) % 12 !== 0) continue;
      ctx.strokeStyle = 'rgba(43,55,87,.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, Y(m));
      ctx.lineTo(padL + plotW, Y(m));
      ctx.stroke();
      ctx.fillStyle = 'rgba(147,161,192,.9)';
      ctx.textAlign = 'right';
      ctx.fillText(PT.midiToName(m), padL - 6, Y(m) + 3);
    }

    /* 右侧：从来没稳定唱到过的音 */
    if (holes.ok && holes.holes.length) {
      holes.holes.forEach(function (mm) {
        ctx.fillStyle = 'rgba(248,113,113,.5)';
        ctx.fillRect(padL + plotW + 3, Y(mm + 0.5), 9, Math.max(1.5, Y(mm - 0.5) - Y(mm + 0.5)));
      });
      ctx.fillStyle = 'rgba(248,113,113,.85)';
      ctx.textAlign = 'left';
      ctx.fillText('没唱到过', padL + plotW + 15, padT + 10);
    }

    if (!series.length) {
      ctx.fillStyle = 'rgba(147,161,192,.95)';
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('还没有每日音域记录 —— 先去上面②开着麦克风唱几个音（最低、最高各唱 1 秒）', padL + plotW / 2, padT + plotH / 2);
      return;
    }

    var barW = Math.max(2, Math.min(9, plotW / Math.max(6, series.length) * 0.6));
    series.forEach(function (d, i) {
      var x = X(i);
      ctx.strokeStyle = 'rgba(96,165,250,.38)';
      ctx.lineWidth = barW;
      ctx.beginPath();
      ctx.moveTo(x, Y(d.high));
      ctx.lineTo(x, Y(d.low));
      ctx.stroke();
      ctx.fillStyle = '#a78bfa';
      ctx.beginPath(); ctx.arc(x, Y(d.high), 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#60a5fa';
      ctx.beginPath(); ctx.arc(x, Y(d.low), 3, 0, Math.PI * 2); ctx.fill();
    });
    if (series.length > 1) {
      [[ 'high', 'rgba(167,139,250,.5)' ], [ 'low', 'rgba(96,165,250,.5)' ]].forEach(function (pair) {
        ctx.strokeStyle = pair[1];
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        series.forEach(function (d, i) {
          var x = X(i), y = Y(d[pair[0]]);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
      });
    }

    /* 换声点：橙色带 + 虚线 */
    if (pass.zone) {
      var zy0 = Y(pass.zone.hi + 0.5), zy1 = Y(pass.zone.lo - 0.5);
      ctx.fillStyle = 'rgba(251,191,36,.16)';
      ctx.fillRect(padL, zy0, plotW, Math.max(2, zy1 - zy0));
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, Y(pass.midi));
      ctx.lineTo(padL + plotW, Y(pass.midi));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fbbf24';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('换声点 ' + PT.midiToName(pass.midi) + '（' + passSourceName(pass.source) + '）',
        padL + plotW - 4, Y(pass.midi) - 5);
    }

    /* 横轴日期：只标首 / 中 / 末 */
    ctx.fillStyle = 'rgba(147,161,192,.9)';
    ctx.font = '10px system-ui, sans-serif';
    var marks = series.length <= 3 ? series.map(function (d, i) { return i; }) : [0, Math.floor((series.length - 1) / 2), series.length - 1];
    marks.forEach(function (i) {
      var d = series[i];
      ctx.textAlign = i === 0 ? 'left' : (i === series.length - 1 ? 'right' : 'center');
      ctx.fillText(d.date.slice(5), X(i), padT + plotH + 15);
    });
  }

  /* ---------- 导出 / 保存 ---------- */
  function passaggioJSON() {
    var log = loadPassLog(), rlog = loadRangeLog();
    var pass = currentPassaggio(), holes = rangeHoles(rlog);
    return JSON.stringify({
      app: 'vocal-pitch-monitor-passaggio', version: 1,
      exportedAt: new Date().toISOString(), a4: S.a4,
      note: '换声点是从「半音阶上行扫描」推测的：音高抖动突然变大 / 唱住比例骤降 / 音量突然要加大或掉一半。' +
            '这只是练习线索，不是医学或声乐诊断。neverSungNotes 是每日音域记录里从没稳定唱到过的音。',
      passaggio: pass.midi === null ? null : {
        note: PT.midiToName(pass.midi), midi: pass.midi, source: pass.source,
        zoneLow: pass.zone ? PT.midiToName(pass.zone.lo) : null,
        zoneHigh: pass.zone ? PT.midiToName(pass.zone.hi) : null,
        reference: passCompare(pass.midi)
      },
      rangeTrend: trendSeries(rlog).map(function (d) {
        return { date: d.date, low: PT.midiToName(d.low), high: PT.midiToName(d.high), semitones: d.semis };
      }),
      neverSungNotes: holes.ok ? holes.holes.map(function (mm) { return PT.midiToName(mm); }) : [],
      scans: (log.scans || []).map(function (s) {
        return {
          at: s.at, startNote: PT.midiToName(s.startMidi), endNote: PT.midiToName(s.endMidi),
          breakMidi: s.breakMidi, breakNote: s.breakMidi === null || s.breakMidi === undefined ? null : PT.midiToName(s.breakMidi),
          zoneLow: s.zone ? PT.midiToName(s.zone.lo) : null, zoneHigh: s.zone ? PT.midiToName(s.zone.hi) : null,
          reason: s.reason,
          notes: (s.notes || []).map(function (n) {
            return { note: PT.midiToName(n.midi), midi: n.midi, frames: n.frames,
                     coverPercent: Math.round((n.coverRatio || 0) * 100),
                     steadyPercent: Math.round((n.steadyRatio || 0) * 100),
                     sdCents: +num(n.centsSd || 0, 1), avgCents: +num(n.avgCents || 0, 1),
                     rmsMed: +num(n.rmsMed || 0, 4), flags: n.flags || [] };
          })
        };
      })
    }, null, 1);
  }
  function trendCSV() {
    var rows = ['date,low_note,high_note,semitones,octaves'];
    trendSeries(loadRangeLog()).forEach(function (d) {
      rows.push([d.date, PT.midiToName(d.low), PT.midiToName(d.high), d.semis, (d.semis / 12).toFixed(2)].join(','));
    });
    return '\ufeff' + rows.join('\n');
  }
  function scanCSV() {
    var rows = ['note,midi,cover_percent,steady_percent,sd_cents,avg_cents,rms_med,flags'];
    var scans = loadPassLog().scans || [];
    var last = scans.length ? scans[scans.length - 1] : null;
    if (last) {
      (last.notes || []).forEach(function (n) {
        rows.push([PT.midiToName(n.midi), n.midi, Math.round((n.coverRatio || 0) * 100),
                   Math.round((n.steadyRatio || 0) * 100), num(n.centsSd || 0, 1), num(n.avgCents || 0, 1),
                   num(n.rmsMed || 0, 4), (n.flags || []).join('|')].join(','));
      });
    }
    return '\ufeff' + rows.join('\n');
  }
  function passFiles() {
    var base = 'passaggio-' + rangeStamp();
    return [
      { name: base + '.json', data: passaggioJSON() },
      { name: base + '-trend.csv', data: trendCSV() },
      { name: base + '-scan.csv', data: scanCSV() }
    ];
  }
  function downloadPassFiles() {
    var base = 'passaggio-' + rangeStamp();
    var files = [
      [base + '.json', passaggioJSON(), 'application/json'],
      [base + '-trend.csv', trendCSV(), 'text/csv'],
      [base + '-scan.csv', scanCSV(), 'text/csv']
    ];
    files.forEach(function (f) {
      var blob = new Blob([f[1]], { type: f[2] + ';charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = f[0];
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    });
    setStatus('已下载：' + base + '.json / -trend.csv / -scan.csv');
  }
  function savePassToFolder() {
    var RF = window.RecordFolder;
    if (!hasPassData()) {
      if (!RF || !RF.supported()) { setStatus('还没有音域趋势或换声区扫描数据可以保存。'); return; }
      renderRangeFolder();
      setStatus('还没有音域趋势或换声区扫描数据 —— 先唱几个音，或做一次换声区扫描。');
      return;
    }
    if (!RF || !RF.supported()) { downloadPassFiles(); return; }
    var doWrite = function () {
      return RF.writeFiles(passFiles()).then(function () {
        renderRangeFolder();
        setStatus('✅ 已存到记录文件夹：passaggio-*.json / -trend.csv / -scan.csv');
      });
    };
    if (!RF.get()) {
      RF.pick().then(doWrite).catch(function (e) {
        if (e && e.name !== 'AbortError') setStatus('保存失败：' + (e.message || e));
      });
      return;
    }
    doWrite().catch(function (e) {
      if (e && (e.code === 'NO_PERM' || e.code === 'NO_FOLDER')) {
        return RF.pick().then(doWrite).catch(function (e2) {
          if (e2 && e2.name !== 'AbortError') setStatus('保存失败：' + (e2.message || e2));
        });
      }
      if (e && e.name !== 'AbortError') setStatus('保存失败：' + (e.message || e));
    });
  }

  function renderRangeInfo() {
    var lo = PT.describeMidi(S.rangeLow, S.a4, S.useFlat);
    var hi = PT.describeMidi(S.rangeHigh, S.a4, S.useFlat);
    var semis = S.rangeHigh - S.rangeLow;
    var doFreq = num(PT.midiToFreq((S.ladderOctave + 1) * 12, S.a4), 1);
    $('rangeInfo').innerHTML =
      '你的音域：<b>' + lo.solfege + lo.octave + '</b> ' + num(lo.freq, 1) + ' Hz ~ <b>' + hi.solfege + hi.octave + '</b> ' +
      num(hi.freq, 1) + ' Hz · 共 ' + semis + ' 个半音（' + (semis / 12).toFixed(1) + ' 个八度）· ' +
      '音域内的音是正常颜色，<b>灰掉</b>的在音域外。<br>' +
      '建议练声音阶：从 <b>do' + S.ladderOctave + '（' + doFreq + ' Hz）</b> 起，一级一级往上练，' +
      '先别一上来就冲 <b>' + hi.solfege + hi.octave + '</b>（那是你的天花板，练久了容易累）。';
  }

  function buildLadder() {
    var notes = PT.scaleNotes(S.ladderOctave, S.a4, S.useFlat);
    var box = $('ladder');
    box.innerHTML = '';
    notes.forEach(function (n) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'lad';
      b.dataset.midi = n.midi;
      var out = isOutOfRange(n.midi);
      if (out) b.classList.add('out');
      b.title = (out ? '⚠️ 超出你的音域：' : '播放 ') + n.solfege + ' 的标准音（' + num(n.freq, 2) + ' Hz）';
      b.innerHTML = '<b>' + n.solfege + '</b><span>' + n.letter + n.octave + '</span><em>' + num(n.freq, 1) + ' Hz</em>' +
                    (out ? '<i class="out-tag">音域外</i>' : '');
      b.addEventListener('click', function () {
        playTone(n.freq, 1.2);
        b.classList.add('flash');
        setTimeout(function () { b.classList.remove('flash'); }, 500);
      });
      box.appendChild(b);
    });
    if (S.current) highlightLadder(S.current.note ? S.current.note.midi : null);
  }

  function buildRefTable() {
    var notes = PT.scaleNotes(S.ladderOctave, S.a4, S.useFlat);
    var body = $('refBody');
    body.innerHTML = '';
    notes.forEach(function (n) {
      var tr = document.createElement('tr');
      tr.dataset.midi = n.midi;
      if (isOutOfRange(n.midi)) tr.classList.add('out');
      var td1 = document.createElement('td');
      td1.innerHTML = '<b>' + n.solfege + '</b>';
      var td2 = document.createElement('td');
      td2.textContent = n.letterName;
      var td3 = document.createElement('td');
      td3.textContent = num(n.freq, 2) + ' Hz';
      var td4 = document.createElement('td');
      var btn = document.createElement('button');
      btn.className = 'btn btn-ghost btn-sm';
      btn.textContent = '▶ 听';
      btn.addEventListener('click', function () { playTone(n.freq, 1.4); });
      td4.appendChild(btn);
      tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3); tr.appendChild(td4);
      body.appendChild(tr);
    });
    $('a4Label').textContent = S.a4;
    if (S.current) highlightRef(S.current.note ? S.current.note.midi : null);
  }

  function buildPracticeSelect() {
    var sel = $('pracSel');
    var keep = sel.value;
    sel.innerHTML = '';
    PT.scaleNotes(S.ladderOctave, S.a4, S.useFlat).forEach(function (n) {
      var op = document.createElement('option');
      op.value = n.midi;
      op.textContent = n.solfege + n.octave + '  (' + num(n.freq, 2) + ' Hz)' + (isOutOfRange(n.midi) ? '  ⚠️音域外' : '');
      sel.appendChild(op);
    });
    if (keep && sel.querySelector('option[value="' + keep + '"]')) sel.value = keep;
  }

  function onA4Change() {
    var v = parseFloat(this.value);
    if (!isFinite(v) || v < 415 || v > 466) { v = 440; this.value = 440; }
    S.a4 = v;
    buildLadder(); buildRefTable(); buildPracticeSelect();
    if (S.current) updateReadout(S.current);
    renderRangeInfo();
    renderStats(S.track.length ? computeStats(S.track) : null);
    drawChart(currentChartTrack());
  }

  /* ---------- 发声：正弦参考音 ---------- */
  function playTone(freq, dur, vol) {
    var ctx = ensureCtx();
    if (ctx.state === 'suspended') ctx.resume();
    dur = dur || 1;
    vol = vol === undefined ? 0.25 : vol;
    var t = ctx.currentTime;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.04);
    gain.gain.setValueAtTime(vol, t + Math.max(0.06, dur - 0.12));
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  function playScale() {
    var notes = PT.scaleNotes(S.ladderOctave, S.a4, S.useFlat);
    var i = 0;
    (function next() {
      if (i >= notes.length) return;
      var n = notes[i++];
      playTone(n.freq, 0.62, 0.22);
      highlightRef(n.midi);
      setTimeout(function () { highlightRef(null); }, 620);
      setTimeout(next, 720);
    })();
  }
  /* ============================================================
   * 录音
   * ============================================================ */
  function toggleRecord() {
    if (!S.recording) {
      if (!S.running) { setStatus('请先点「开始收音」，拿到麦克风之后再录音。'); return; }
      S.recording = true;
      S.recStart = performance.now();
      S.lastPush = 0;
      S.lastStatsAt = 0;
      S.track = [];
      $('recBtn').textContent = '⏹ 停止录音';
      $('recBtn').classList.add('recording');
      $('recDot').classList.add('live');
      setStatus('正在录音（只记录音高，不保存声音文件）。按要求唱完整条音阶后点「停止录音」。');
      refreshRecordingUI();
    } else {
      S.recording = false;
      $('recBtn').textContent = '⏺ 开始录音';
      $('recBtn').classList.remove('recording');
      $('recDot').classList.remove('live');
      refreshRecordingUI();
      if (S.track.length >= 20) {
        var ok = addSession(S.track.slice());
        if (ok) setStatus('录音结束，已保存到下面的「存在这台电脑上的录音」，可以导出 JSON 发给我分析。');
        else setStatus('录音结束。本地存储空间不足，请点「导出 JSON」保存到文件。');
      } else {
        setStatus('录音结束，但有效数据太少（没听到足够的长音），这次不保存。');
      }
    }
  }

  function maybeRecord(cur, ts) {
    if (!cur) return;
    if (ts - S.lastPush < REC_INTERVAL) return;
    S.lastPush = ts;
    S.track.push({
      t: Math.round(ts - S.recStart),
      f: +cur.freq.toFixed(2),
      rms: +cur.rms.toFixed(4),
      conf: +cur.conf.toFixed(3)
    });
  }

  function refreshRecordingUI() {
    var n = S.track.length;
    var secs = 0;
    if (n > 1) secs = (S.track[n - 1].t - S.track[0].t) / 1000;
    $('recCount').textContent = n ? ('已记录 ' + n + ' 个音高点 · 约 ' + secs.toFixed(1) + ' 秒歌声') : '';
    $('recText').textContent = S.recording ? '录音中…' : (n ? '录音结束' : '未录音');
    renderStats(n ? computeStats(S.track) : null);
    drawChart(S.track);
  }

  /* ============================================================
   * 统计
   * ============================================================ */
  function computeStats(track) {
    var a4 = S.a4;
    var byNote = {};
    var centsAll = [], absAll = [];
    var t0 = track[0] ? track[0].t : 0;
    var t1 = track.length ? track[track.length - 1].t : 0;
    var span = Math.max(1, t1 - t0);
    var step = track.length > 1 ? span / (track.length - 1) : REC_INTERVAL;   // 平均采样间隔 ms

    track.forEach(function (p) {
      var midiExact = PT.freqToMidi(p.f, a4);
      var info = PT.describeMidi(midiExact, a4, S.useFlat);
      var key = info.letterName;
      if (!byNote[key]) {
        byNote[key] = { key: key, sol: info.solfege, letter: info.letterName, midi: info.midi, cents: [], count: 0 };
      }
      byNote[key].cents.push(info.cents);
      byNote[key].count++;
      centsAll.push(info.cents);
      absAll.push(Math.abs(info.cents));
    });

    var list = Object.keys(byNote).map(function (k) {
      var g = byNote[k];
      var abs = g.cents.map(Math.abs);
      var in50 = abs.filter(function (x) { return x <= 50; }).length / abs.length * 100;
      var in25 = abs.filter(function (x) { return x <= 25; }).length / abs.length * 100;
      return {
        key: g.key, sol: g.sol, letter: g.letter, midi: g.midi,
        count: g.count,
        seconds: g.count * step / 1000,
        avg: mean(g.cents),
        avgAbs: mean(abs),
        sd: std(g.cents),
        in50: in50, in25: in25
      };
    }).sort(function (a, b) { return a.midi - b.midi; });

    var worst = null, best = null;
    list.forEach(function (r) {
      if (r.count < 8) return;
      if (!worst || r.avgAbs > worst.avgAbs) worst = r;
      if (!best || r.avgAbs < best.avgAbs) best = r;
    });

    /* 本段实际音高范围（取 5%~95% 分位，去掉个别离群点） */
    var midis = track.map(function (p) { return PT.freqToMidi(p.f, a4); }).sort(function (x, y) { return x - y; });
    var pLo = midis.length ? midis[Math.floor(midis.length * 0.05)] : 60;
    var pHi = midis.length ? midis[Math.floor(midis.length * 0.95)] : 60;

    return {
      list: list,
      summary: {
        total: track.length,
        rangeLowMidi: pLo,
        rangeHighMidi: pHi,
        voicedSeconds: track.length * step / 1000,
        avgBias: mean(centsAll),
        avgAbs: mean(absAll),
        sd: std(centsAll),
        in50: absAll.length ? absAll.filter(function (x) { return x <= 50; }).length / absAll.length * 100 : 0,
        nearEdge: absAll.length ? absAll.filter(function (x) { return x >= 45; }).length / absAll.length * 100 : 0,
        in25: absAll.length ? absAll.filter(function (x) { return x <= 25; }).length / absAll.length * 100 : 0,
        noteCount: list.length,
        worst: worst, best: best
      }
    };
  }

  function qualityClass(v) { return v <= 25 ? 'good' : (v <= 50 ? 'warn' : 'bad'); }

  function renderStats(stats) {
    var body = $('statBody');
    if (!stats || !stats.list.length) {
      body.innerHTML = '<tr><td colspan="5" class="muted center">还没有录音数据</td></tr>';
      $('summary').innerHTML = '';
      $('statHint').textContent = '';
      return;
    }
    var s = stats.summary;

    /* 概览卡片 */
    var cards = [
      { k: '有效歌声', v: s.voicedSeconds.toFixed(1) + ' 秒', cls: '' },
      { k: '整体平均|偏差|', v: '±' + s.avgAbs.toFixed(1) + ' 音分', cls: qualityClass(s.avgAbs) },
      { k: '整体平均偏差', v: (s.avgBias >= 0 ? '+' : '') + s.avgBias.toFixed(1) + ' 音分', cls: Math.abs(s.avgBias) <= 15 ? 'good' : (Math.abs(s.avgBias) <= 30 ? 'warn' : 'bad') },
      { k: '±25 音分内', v: s.in25.toFixed(0) + '%', cls: qualityClass(100 - s.in25) },
      { k: '±50 音分内', v: s.in50.toFixed(0) + '%', cls: qualityClass(100 - s.in50) },
      { k: '最偏的音', v: s.worst ? (s.worst.sol + ' (' + (s.worst.avg >= 0 ? '+' : '') + s.worst.avg.toFixed(0) + ')') : '—', cls: 'bad' },
      { k: '本段音高范围', v: (s.rangeLowMidi !== undefined ? PT.midiToName(s.rangeLowMidi) + '~' + PT.midiToName(s.rangeHighMidi) : '—'), cls: '' },
      { k: '最准的音', v: s.best ? (s.best.sol + ' (±' + s.best.avgAbs.toFixed(0) + ')') : '—', cls: 'good' }
    ];
    $('summary').innerHTML = cards.map(function (c) {
      return '<div class="sum-item"><span class="k">' + c.k + '</span><span class="v ' + c.cls + '">' + c.v + '</span></div>';
    }).join('');

    /* 逐音表格 */
    body.innerHTML = stats.list.map(function (r) {
      var biasTxt = (r.avg >= 0 ? '+' : '') + r.avg.toFixed(0);
      var biasCls = Math.abs(r.avg) <= 15 ? 'v-ok' : (Math.abs(r.avg) <= 30 ? 'v-warn' : 'v-bad');
      var cls = qualityClass(r.avgAbs);
      var w = Math.min(100, r.in50);
      var barColor = cls === 'good' ? '#4ade80' : (cls === 'warn' ? '#fbbf24' : '#f87171');
      return '<tr>' +
        '<td>' + r.sol + '<span class="muted small"> / ' + r.letter + '</span></td>' +
        '<td>' + r.seconds.toFixed(1) + 's</td>' +
        '<td class="' + biasCls + '">' + biasTxt + '</td>' +
        '<td>' + r.avgAbs.toFixed(0) + ' ± ' + r.sd.toFixed(0) + '</td>' +
        '<td><span class="bar"><i style="left:0;width:' + w.toFixed(0) + '%;background:' + barColor + '"></i></span> ' + r.in50.toFixed(0) + '%</td>' +
      '</tr>';
    }).join('');

    /* ±50 音分边界 / 黑键读表提示 */
    $('statHint').innerHTML =
      '读表提示：<b>do♯ / re♯ / fa♯ / sol♯ / la♯</b> 是黑键（升半音），本来不在 do re mi 音阶里。' +
      '如果你明明想唱 sol，表里却出现 <b>sol♯</b>、而且平均偏差接近 −50，说明你比 sol 高了快半个音；' +
      '出现 <b>fa♯</b> 则说明这个音只唱到了 fa 和 sol 的正中间。' +
      '本次有 <b>' + (s.nearEdge || 0).toFixed(0) + '%</b> 的音高落在两个半音中间（|偏差| ≥ 45 音分），基本就是滑音或没找准位置，先想办法把它降下来。';
  }

  /* ============================================================
   * 轨迹图
   * ============================================================ */
  function currentChartTrack() {
    return S.chartTrack || S.track;
  }

  function drawChart(track) {
    S.chartTrack = track;
    var canvas = $('chart');
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || 640;
    var h = canvas.clientHeight || 240;
    canvas.width = Math.max(300, Math.round(w * dpr));
    canvas.height = Math.max(160, Math.round(h * dpr));
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var padL = 66, padR = 12, padT = 12, padB = 26;
    var plotW = w - padL - padR, plotH = h - padT - padB;

    if (!track || track.length < 2) {
      ctx.fillStyle = '#4b5b7d';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('点「开始录音」并唱一段，这里会画出你的音高轨迹', w / 2, h / 2);
      $('chartInfo').textContent = '';
      return;
    }

    var a4 = S.a4;
    var pts = track.map(function (p) {
      return { t: p.t, midi: PT.freqToMidi(p.f, a4), f: p.f };
    });
    var tMax = Math.max(1000, pts[pts.length - 1].t);
    var mids = pts.map(function (p) { return p.midi; });
    var lo = Math.floor(Math.min.apply(null, mids)) - 1;
    var hi = Math.ceil(Math.max.apply(null, mids)) + 1;
    /* 把「我的音域」也纳入纵轴，方便对照有没有唱出界 */
    if (isFinite(S.rangeLow) && S.rangeLow - 1 < lo) lo = S.rangeLow - 1;
    if (isFinite(S.rangeHigh) && S.rangeHigh + 1 > hi) hi = S.rangeHigh + 1;
    if (hi - lo > 32) { hi = lo + 32; }

    function X(t) { return padL + (t / tMax) * plotW; }
    function Y(m) { return padT + (hi - m) / (hi - lo) * plotH; }

    /* 横向半音线 + 唱名 */
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var m = lo; m <= hi; m++) {
      var info = PT.describeMidi(m, a4, S.useFlat);
      var y = Y(m);
      var major = info.pc === 0 || info.pc === 2 || info.pc === 4 || info.pc === 5 || info.pc === 7 || info.pc === 9 || info.pc === 11;
      ctx.strokeStyle = major ? 'rgba(148,163,184,.26)' : 'rgba(148,163,184,.10)';
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
      ctx.fillStyle = major ? '#93a1c0' : '#4d5c7c';
      ctx.fillText(info.solfege + info.octave, padL - 6, y);
    }

    /* 音域带（浅蓝底 + 上下限虚线） */
    if (isFinite(S.rangeLow) && isFinite(S.rangeHigh)) {
      var bandHi = Y(Math.min(hi, S.rangeHigh + 0.5));
      var bandLo = Y(Math.max(lo, S.rangeLow - 0.5));
      if (bandLo > bandHi) {
        ctx.fillStyle = 'rgba(96,165,250,.10)';
        ctx.fillRect(padL, bandHi, plotW, bandLo - bandHi);
      }
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(96,165,250,.6)';
      ctx.beginPath(); ctx.moveTo(padL, Y(S.rangeHigh)); ctx.lineTo(padL + plotW, Y(S.rangeHigh)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(padL, Y(S.rangeLow)); ctx.lineTo(padL + plotW, Y(S.rangeLow)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(147,197,253,.9)';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText('音域上限 ' + PT.midiToName(S.rangeHigh), padL + 5, Y(S.rangeHigh) - 2);
      ctx.textBaseline = 'top';
      ctx.fillText('音域下限 ' + PT.midiToName(S.rangeLow), padL + 5, Y(S.rangeLow) + 2);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
    }

    /* 纵向时间线 */
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var secStep = tMax > 60000 ? 10 : (tMax > 30000 ? 5 : 2);
    for (var s = 0; s <= tMax / 1000; s += secStep) {
      var x = X(s * 1000);
      ctx.strokeStyle = 'rgba(148,163,184,.13)';
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      ctx.fillStyle = '#7b8aad';
      ctx.fillText(s + 's', x, padT + plotH + 6);
    }

    /* 轨迹（抽稀） */
    var maxPts = Math.max(200, Math.round(plotW * 2));
    var stride = Math.max(1, Math.ceil(pts.length / maxPts));
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    var prev = null;
    for (var i = 0; i < pts.length; i += stride) {
      var p = pts[i];
      var abs = Math.abs(p.midi - Math.round(p.midi)) * 100;
      var color = abs <= 25 ? '#4ade80' : (abs <= 50 ? '#fbbf24' : '#f87171');
      if (prev) {
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(X(prev.t), Y(prev.midi));
        ctx.lineTo(X(p.t), Y(p.midi));
        ctx.stroke();
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(X(p.t), Y(p.midi), 1.8, 0, Math.PI * 2);
      ctx.fill();
      prev = p;
    }

    var secs = tMax / 1000;
    $('chartInfo').textContent = '共 ' + track.length + ' 个音高点 · 约 ' + secs.toFixed(1) + ' 秒';
  }

  /* ============================================================
   * 单音跟唱测试
   * ============================================================ */
  function startPractice() {
    if (S.pracBusy) return;
    if (!S.running) { setStatus('请先点「开始收音」，再做单音测试。'); return; }
    var midi = parseInt($('pracSel').value, 10);
    if (!isFinite(midi)) return;
    var target = PT.midiToFreq(midi, S.a4);
    var info = PT.describeMidi(midi, S.a4, S.useFlat);
    var btn = $('pracBtn');
    var box = $('pracResult');

    S.pracBusy = true;
    btn.disabled = true;
    box.innerHTML = '🔊 参考音：<b>' + info.solfege + info.octave + '</b> = ' + num(target, 2) +
                    ' Hz，先听清楚，可以小声跟着哼。';

    playTone(target, 1.6, 0.24);

    setTimeout(function () {
      var cents = [];
      var t0 = performance.now();
      var total = 5000;
      box.innerHTML = '🎤 现在唱 <b>' + info.solfege + info.octave + '</b>，保持 5 秒…';

      var timer = setInterval(function () {
        var el = performance.now() - t0;
        if (S.current && S.current.freq > 0) {
          var c = 1200 * Math.log2(S.current.freq / target);
          if (Math.abs(c) < 400) cents.push(c);
        }
        var left = Math.max(0, (total - el) / 1000);
        box.innerHTML = '🎤 正在唱 <b>' + info.solfege + info.octave + '</b> · 还剩 ' + left.toFixed(1) +
                        ' 秒（已采集 ' + cents.length + ' 帧）';
        if (el >= total) {
          clearInterval(timer);
          finishPractice(info, cents, box, btn);
        }
      }, 60);
    }, 1750);
  }

  function finishPractice(info, cents, box, btn) {
    S.pracBusy = false;
    btn.disabled = false;
    if (cents.length < 8) {
      box.innerHTML = '❓ 没采集到足够的歌声（' + cents.length + ' 帧）。请靠近麦克风、唱长一点再来一次。';
      return;
    }
    var avg = mean(cents);
    var absArr = cents.map(Math.abs);
    var avgAbs = mean(absArr);
    var sd = std(cents);
    var in50 = cents.filter(function (c) { return Math.abs(c) <= 50; }).length / cents.length * 100;
    var in25 = cents.filter(function (c) { return Math.abs(c) <= 25; }).length / cents.length * 100;
    var score = Math.max(0, Math.round(100 - avgAbs * 1.4));
    var stars = score >= 88 ? '★★★★★' : score >= 74 ? '★★★★☆' : score >= 58 ? '★★★☆☆' : score >= 40 ? '★★☆☆☆' : '★☆☆☆☆';
    var dir = Math.abs(avg) <= 12 ? '基本落在音上' : (avg > 0 ? '整体偏<b>高</b>' : '整体偏<b>低</b>');

    box.innerHTML =
      '<div>目标音：<b>' + info.solfege + info.octave + '</b>（' + num(info.freq, 2) + ' Hz） · ' + stars +
      ' <span class="score">' + score + '</span> 分</div>' +
      '<div>平均偏差 ' + (avg >= 0 ? '+' : '') + avg.toFixed(0) + ' 音分（' + dir + '）；' +
      '平均|偏差| ' + avgAbs.toFixed(0) + ' 音分；抖动 ±' + sd.toFixed(0) + ' 音分</div>' +
      '<div>±25 音分内 ' + in25.toFixed(0) + '% · ±50 音分内 ' + in50.toFixed(0) + '% · 采样 ' + cents.length + ' 帧</div>';
  }

  /* ============================================================
   * 本地存储 & 导出
   * ============================================================ */
  function loadSessions() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      S.sessions = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(S.sessions)) S.sessions = [];
    } catch (e) { S.sessions = []; }
  }

  function persistSessions() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(S.sessions));
      return true;
    } catch (e) {
      return false;
    }
  }

  function addSession(track) {
    var stats = computeStats(track);
    var item = {
      id: 'rec-' + stamp(),
      createdAt: new Date().toISOString(),
      a4: S.a4,
      useFlat: S.useFlat,
      points: track.map(function (p) { return { t: p.t, f: p.f }; }),
      summary: {
        voicedSeconds: +stats.summary.voicedSeconds.toFixed(1),
        avgBias: +stats.summary.avgBias.toFixed(1),
        avgAbs: +stats.summary.avgAbs.toFixed(1),
        in50: +stats.summary.in50.toFixed(1),
        noteCount: stats.summary.noteCount
      }
    };
    S.sessions.unshift(item);
    if (S.sessions.length > 40) S.sessions = S.sessions.slice(0, 40);
    return persistSessions();
  }

  function renderSessions() {
    var box = $('sessions');
    if (!S.sessions.length) {
      box.innerHTML = '<p class="muted small">还没有保存过录音。</p>';
      return;
    }
    box.innerHTML = '';
    S.sessions.forEach(function (it) {
      var d = new Date(it.createdAt);
      var title = d.toLocaleString('zh-CN', { hour12: false });
      var sm = it.summary || {};
      var div = document.createElement('div');
      div.className = 'session-item';
      div.innerHTML =
        '<div><b>' + title + '</b><div class="meta">' +
        (it.points ? it.points.length : 0) + ' 个音高点 · 约 ' + (sm.voicedSeconds || 0) + ' 秒 · 平均|偏差| ' +
        (sm.avgAbs === undefined ? '—' : sm.avgAbs) + ' 音分 · ±50 内 ' + (sm.in50 === undefined ? '—' : sm.in50) + '%' +
        '</div></div>';

      var actions = document.createElement('div');
      actions.className = 'row';

      var bView = document.createElement('button');
      bView.className = 'btn btn-ghost btn-sm';
      bView.textContent = '看轨迹';
      bView.addEventListener('click', function () {
        drawChart(it.points);
        renderStats(computeStats(it.points));
        setStatus('正在显示 ' + title + ' 的轨迹（在⑤）。');
        document.querySelector('.card--wide .chart').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });

      var bJson = document.createElement('button');
      bJson.className = 'btn btn-ghost btn-sm';
      bJson.textContent = 'JSON';
      bJson.addEventListener('click', function () {
        downloadFile('pitch-' + it.id + '.json', JSON.stringify(buildExport(it.points, it), null, 2), 'application/json');
      });

      var bDel = document.createElement('button');
      bDel.className = 'btn btn-ghost btn-sm danger';
      bDel.textContent = '删除';
      bDel.addEventListener('click', function () {
        S.sessions = S.sessions.filter(function (x) { return x.id !== it.id; });
        persistSessions();
        renderSessions();
      });

      actions.appendChild(bView); actions.appendChild(bJson); actions.appendChild(bDel);
      div.appendChild(actions);
      box.appendChild(div);
    });
  }

  function buildExport(track, meta) {
    var a4 = (meta && meta.a4) || S.a4;
    var useFlat = meta && meta.useFlat !== undefined ? meta.useFlat : S.useFlat;
    var points = track.map(function (p) {
      var midiExact = PT.freqToMidi(p.f, a4);
      var info = PT.describeMidi(midiExact, a4, useFlat);
      return {
        t: p.t,
        f: p.f,
        midi: +midiExact.toFixed(3),
        cents: +info.cents.toFixed(1),
        note: info.letterName,
        solfege: info.solfege + info.octave
      };
    });
    var stats = computeStats(track);
    return {
      app: 'vocal-pitch-monitor',
      version: 1,
      createdAt: (meta && meta.createdAt) || new Date().toISOString(),
      a4: a4,
      useFlat: useFlat,
      durationMs: track.length ? track[track.length - 1].t : 0,
      sampleCount: track.length,
      fields: {
        t: '相对开始的毫秒数',
        f: '检测到的频率 Hz',
        midi: 'MIDI 音号（小数，69=la4=440Hz）',
        cents: '相对最近半音的偏差音分（+偏高 / -偏低）',
        note: '音名',
        solfege: '唱名'
      },
      summary: stats.summary,
      perNote: stats.list.map(function (r) {
        return {
          solfege: r.sol, note: r.letter, midi: r.midi,
          seconds: +r.seconds.toFixed(2), frames: r.count,
          avgCents: +r.avg.toFixed(1), avgAbsCents: +r.avgAbs.toFixed(1),
          sdCents: +r.sd.toFixed(1), in50Percent: +r.in50.toFixed(1), in25Percent: +r.in25.toFixed(1)
        };
      }),
      points: points
    };
  }

  function exportJSON(track, tag) {
    if (!track || track.length < 2) { setStatus('还没有可导出的录音数据。'); return; }
    var data = buildExport(track, null);
    downloadFile('pitch-' + (tag || 'session') + '-' + stamp() + '.json', JSON.stringify(data, null, 2), 'application/json');
    setStatus('已导出 JSON 文件，直接把它发给我就行。');
  }

  function exportCSV(track, tag) {
    if (!track || track.length < 2) { setStatus('还没有可导出的录音数据。'); return; }
    var a4 = S.a4;
    var rows = ['time_s,freq_hz,midi,note,solfege,cents'];
    track.forEach(function (p) {
      var midiExact = PT.freqToMidi(p.f, a4);
      var info = PT.describeMidi(midiExact, a4, S.useFlat);
      rows.push([
        (p.t / 1000).toFixed(2), p.f.toFixed(2), midiExact.toFixed(3),
        info.letterName, info.solfege + info.octave, info.cents.toFixed(1)
      ].join(','));
    });
    downloadFile('pitch-' + (tag || 'session') + '-' + stamp() + '.csv', '\ufeff' + rows.join('\n'), 'text/csv');
    setStatus('已导出 CSV 文件（可以用 Excel 打开）。');
  }

  function exportAllSessions() {
    if (!S.sessions.length) { setStatus('本地还没有保存的录音。'); return; }
    var all = S.sessions.map(function (it) { return buildExport(it.points, it); });
    downloadFile('pitch-all-' + stamp() + '.json', JSON.stringify({ app: 'vocal-pitch-monitor', version: 1, sessions: all }, null, 2), 'application/json');
    setStatus('已导出全部 ' + all.length + ' 段录音。');
  }

  function downloadFile(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'application/json') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  /* 页面启动 */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
