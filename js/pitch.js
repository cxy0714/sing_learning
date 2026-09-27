/* ============================================================
 * pitch.js —— 音高检测 + 音名/唱名换算（纯原生 JS，无依赖）
 *  1) detectPitch : YIN 算法（40~1300Hz，适合人声），返回频率与置信度
 *  2) 音名换算    : 频率 <-> MIDI <-> 唱名(do re mi) / 音名(C D E)
 * ============================================================ */
(function (global) {
  'use strict';

  /* 音名（十二平均律，默认用升号） */
  var LETTERS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  /* 唱名：C=do D=re E=mi F=fa G=sol A=la B=xi （与你唱的顺序一致） */
  var SOLFEGE_SHARP = ['do', 'do♯', 're', 're♯', 'mi', 'fa', 'fa♯', 'sol', 'sol♯', 'la', 'la♯', 'xi'];
  var SOLFEGE_FLAT = ['do', 're♭', 're', 'mi♭', 'mi', 'fa', 'sol♭', 'sol', 'la♭', 'la', 'xi♭', 'xi'];
  var SOLFEGE_SHARP_CN = ['1', '#1', '2', '#2', '3', '4', '#4', '5', '#5', '6', '#6', '7'];

  /* ---------- YIN 基频检测 ---------- */
  function detectPitch(buf, sampleRate, options) {
    options = options || {};
    var fmin = options.minFreq || 65;
    var fmax = options.maxFreq || 1300;
    var threshold = options.threshold || 0.15;
    var n = buf.length;

    var tauMin = Math.max(2, Math.floor(sampleRate / fmax));
    var tauMax = Math.min(n - 2, Math.ceil(sampleRate / fmin));
    if (tauMax <= tauMin + 1) return { freq: -1, confidence: 0 };

    var w = n - tauMax;          // 参与比较的窗口长度（保证下标不越界）
    if (w < 32) return { freq: -1, confidence: 0 };

    /* 1) 差值函数 d(tau) */
    var d = new Float32Array(tauMax + 1);
    for (var tau = 1; tau <= tauMax; tau++) {
      var sum = 0;
      for (var i = 0; i < w; i++) {
        var delta = buf[i] - buf[i + tau];
        sum += delta * delta;
      }
      d[tau] = sum;
    }

    /* 2) 累积均值归一化差值 cmnd(tau) */
    var cmnd = new Float32Array(tauMax + 1);
    cmnd[0] = 1;
    var running = 0;
    for (var t = 1; t <= tauMax; t++) {
      running += d[t];
      cmnd[t] = running > 0 ? (d[t] * t / running) : 1;
    }

    /* 3) 绝对阈值挑选第一个谷底 */
    var tauEst = -1;
    for (var t2 = tauMin; t2 <= tauMax; t2++) {
      if (cmnd[t2] < threshold) {
        while (t2 + 1 <= tauMax && cmnd[t2 + 1] < cmnd[t2]) t2++;
        tauEst = t2;
        break;
      }
    }

    var conf;
    if (tauEst < 0) {
      /* 放宽一次：取全局最低谷，但置信度打折 */
      var best = Infinity, bestTau = -1;
      for (var t3 = tauMin; t3 <= tauMax; t3++) {
        if (cmnd[t3] < best) { best = cmnd[t3]; bestTau = t3; }
      }
      if (bestTau < 0 || best > 0.55) return { freq: -1, confidence: 0 };
      tauEst = bestTau;
      conf = (1 - best) * 0.6;
    } else {
      conf = 1 - cmnd[tauEst];
    }

    /* 4) 抛物线插值，得到亚采样精度 */
    var x0 = tauEst > 1 ? cmnd[tauEst - 1] : cmnd[tauEst];
    var x1 = cmnd[tauEst];
    var x2 = (tauEst + 1 <= tauMax) ? cmnd[tauEst + 1] : cmnd[tauEst];
    var denom = 2 * (2 * x1 - x2 - x0);
    var better = tauEst;
    if (denom !== 0) {
      var shift = (x2 - x0) / denom;
      if (Math.abs(shift) < 1) better = tauEst + shift;
    }
    var freq = sampleRate / better;
    if (!isFinite(freq) || freq < fmin * 0.8 || freq > fmax * 1.2) {
      return { freq: -1, confidence: 0 };
    }
    return { freq: freq, confidence: Math.max(0, Math.min(1, conf)) };
  }

  /* ---------- 频率 / MIDI / 音名 ---------- */
  function midiToFreq(midi, a4) {
    return (a4 || 440) * Math.pow(2, (midi - 69) / 12);
  }
  function freqToMidi(freq, a4) {
    return 69 + 12 * Math.log2(freq / (a4 || 440));
  }
  function noteIndex(midi) { return ((midi % 12) + 12) % 12; }
  function octaveOf(midi) { return Math.floor(midi / 12) - 1; }

  /**
   * 把（可以是小数的）MIDI 音高描述出来
   * @return {midi, cents, pc, octave, solfege, letter, letterName, freq, freqOf}
   */
  function describeMidi(midiExact, a4, useFlat) {
    var midi = Math.round(midiExact);
    var cents = (midiExact - midi) * 100;
    var pc = noteIndex(midi);
    var oct = octaveOf(midi);
    var sol = (useFlat ? SOLFEGE_FLAT : SOLFEGE_SHARP)[pc];
    return {
      midi: midi,
      midiExact: midiExact,
      cents: cents,
      pc: pc,
      octave: oct,
      solfege: sol,
      degree: SOLFEGE_SHARP_CN[pc],
      letter: LETTERS[pc],
      letterName: LETTERS[pc] + oct,
      name: sol + oct,
      freq: midiToFreq(midi, a4)
    };
  }

  /**
   * 一个八度的大调音阶：do re mi fa sol la xi do(高八度)
   * @param {number} startOctave 起始 do 的八度（C4 = 中央C）
   */
  function scaleNotes(startOctave, a4, useFlat) {
    var pcs = [0, 2, 4, 5, 7, 9, 11, 12];  // 大调音级
    var out = [];
    for (var i = 0; i < pcs.length; i++) {
      var midi = (startOctave + 1) * 12 + pcs[i];
      out.push(describeMidi(midi, a4, useFlat));
    }
    return out;
  }

  /** 半音阶列表（用于完整频率对照表） */
  function chromaticNotes(lowMidi, highMidi, a4, useFlat) {
    var out = [];
    for (var m = lowMidi; m <= highMidi; m++) {
      out.push(describeMidi(m, a4, useFlat));
    }
    return out;
  }

  /* ---------- 音名 <-> MIDI（用于「我的音域」设置） ---------- */
  var SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  /** 'A2' / 'Bb3' / 'F#4' -> MIDI 音号，失败返回 null */
  function midiFromName(name) {
    var m = /^\s*([A-Ga-g])\s*([#b♯♭]?)\s*(-?\d+)\s*$/.exec(String(name));
    if (!m) return null;
    var base = SEMI[m[1].toUpperCase()];
    var acc = m[2];
    if (acc === '#' || acc === '♯') base += 1;
    if (acc === 'b' || acc === '♭') base -= 1;
    return (parseInt(m[3], 10) + 1) * 12 + base;
  }

  /** MIDI 音号 -> 'A4' */
  function midiToName(midi) {
    return LETTERS[noteIndex(midi)] + octaveOf(midi);
  }

  global.PitchTool = {
    midiFromName: midiFromName,
    midiToName: midiToName,
    detectPitch: detectPitch,
    midiToFreq: midiToFreq,
    freqToMidi: freqToMidi,
    describeMidi: describeMidi,
    scaleNotes: scaleNotes,
    chromaticNotes: chromaticNotes,
    LETTERS: LETTERS,
    SOLFEGE_SHARP: SOLFEGE_SHARP,
    SOLFEGE_FLAT: SOLFEGE_FLAT
  };
})(window);