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

  /* ---------- 全局状态 ---------- */
  var S = {
    /* 音频 */
    running: false, audioCtx: null, stream: null, analyser: null, micSource: null,
    buf: null, lastAnalysis: 0, analysisInterval: 60,
    pitchHist: [],          // 最近检测到的频率，用于中位数平滑
    level: 0,
    current: null,          // { freq, conf, rms, note }
    /* 设置 */
    a4: 440, useFlat: false, ladderOctave: 4,
    /* 录音 */
    recording: false, recStart: 0, lastPush: 0, track: [], lastStatsAt: 0,
    /* 本地记录 */
    sessions: [],
    /* 测试 */
    pracBusy: false
  };

  /* ============================================================
   * 启动
   * ============================================================ */
  function init() {
    buildOctaveSelect();
    bindEvents();
    buildLadder();
    buildRefTable();
    buildPracticeSelect();
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
      buildLadder(); buildRefTable(); buildPracticeSelect();
    });
    $('playScaleBtn').addEventListener('click', playScale);
    $('recBtn').addEventListener('click', toggleRecord);
    $('clearBtn').addEventListener('click', function () {
      if (S.recording) { setStatus('先停止录音再清空。'); return; }
      S.track = [];
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
    if (ts - S.lastAnalysis < S.analysisInterval) return;
    S.lastAnalysis = ts;

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
        cur = { freq: f, conf: sc / near.length, rms: rms };
      }
    }
    S.current = cur;

    updateReadout(cur);
    if (S.recording) maybeRecord(cur, ts);
    if (S.recording && ts - S.lastStatsAt > 800) {
      S.lastStatsAt = ts;
      refreshRecordingUI();
    }
  }

  /* ============================================================
   * 界面：实时读数
   * ============================================================ */
  function resetReadout() {
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

  function buildLadder() {
    var notes = PT.scaleNotes(S.ladderOctave, S.a4, S.useFlat);
    var box = $('ladder');
    box.innerHTML = '';
    notes.forEach(function (n) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'lad';
      b.dataset.midi = n.midi;
      b.title = '播放 ' + n.solfege + ' 的标准音（' + num(n.freq, 2) + ' Hz）';
      b.innerHTML = '<b>' + n.solfege + '</b><span>' + n.letter + n.octave + '</span><em>' + num(n.freq, 1) + ' Hz</em>';
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
      op.textContent = n.solfege + n.octave + '  (' + num(n.freq, 2) + ' Hz)';
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

    return {
      list: list,
      summary: {
        total: track.length,
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
    if (hi - lo > 30) { hi = lo + 30; }

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