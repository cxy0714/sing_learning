/* ============================================================
 * record.js —— 练习记录：录音 + 存本地 + 回听 + 保存到文件夹
 *
 *   · 唱歌时用 MediaRecorder 录下你的声音（存成 webm/opus，很小）
 *   · 停止后把「音高数据 + 成绩 + 录音」一起存进浏览器 IndexedDB（本机，不上传）
 *   · 可以回听、导出 JSON/CSV、或一键写进你自己选的文件夹（给作者分析用）
 *
 *   ⚠️ 所有数据都在你本机：仓库里不可能有（.gitignore 也挡了 karaoke-*.json / *.webm）
 * ============================================================ */
(function () {
  'use strict';

  var DB = 'vpm-kara-rec';
  var STORE = 'sessions';
  var KVS = 'kv';

  function $(id) { return document.getElementById(id); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function stamp() {
    var d = new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
           pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function safe(s) { return String(s || 'song').replace(/\.(mp3|flac|m4a|wav|webm)$/i, '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60); }

  /* ---------- IndexedDB ---------- */
  function db() {
    return new Promise(function (res, rej) {
      if (typeof indexedDB === 'undefined') return rej(new Error('no idb'));
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(KVS)) d.createObjectStore(KVS);
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function tx(mode, store, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(store, mode), s = t.objectStore(store), q = fn(s);
        t.oncomplete = function () { res(q && q.result); };
        t.onerror = function () { rej(t.error); };
      });
    });
  }
  var put = function (o) { return tx('readwrite', STORE, function (s) { return s.put(o); }); };
  var all = function () { return tx('readonly', STORE, function (s) { return s.getAll(); }); };
  var del = function (id) { return tx('readwrite', STORE, function (s) { return s.delete(id); }); };
  var kvPut = function (k, v) { return tx('readwrite', KVS, function (s) { return s.put(v, k); }); };
  var kvGet = function (k) { return tx('readonly', KVS, function (s) { return s.get(k); }); };

  /* ---------- 录音 ---------- */
  var stream = null, mr = null, chunks = [], lastBlob = null;
  var onStatus = function () {};
  var prefsReady = null;
  var playBarEl = null, recSeekEl = null, recTimeEl = null, playDurMs = 0, seeking = false;
  var S = { dir: null, auto: true };        // 保存文件夹 + 是否自动保存

  function loadPrefs() {
    try { S.auto = localStorage.getItem('vpm.recAuto') !== '0'; } catch (e) { S.auto = true; }
    var read = (window.RecordFolder && window.RecordFolder.load)
      ? window.RecordFolder.load().then(function (h) { S.dir = h || null; return h; })
      : kvGet('recDir').then(function (h) { if (h) S.dir = h; return h; });
    return read.then(function () { renderFolder(); updateUsage(); })
      .catch(function () { renderFolder(); updateUsage(); });
  }
  function renderFolder() {
    var el = $('recFolderName');
    if (el) el.textContent = S.dir ? ('记录文件夹：' + S.dir.name + '（音域记录也写这里）') : '还没设记录文件夹 —— 设一个，音域和 K 歌记录一起写进硬盘，两个页面共用';
    var chk = $('recAutoChk'); if (chk) chk.checked = S.auto;
    var b = $('recFolderBtn');
    if (b) b.textContent = S.dir ? '📁 更换记录文件夹' : '📁 选择记录文件夹';
  }
  function setFolder() {
    if (!window.showDirectoryPicker) { onStatus('这个浏览器不能直接写文件夹（用 Chrome/Edge），可以先用「JSON」按钮下载。'); return; }
    var p = (window.RecordFolder && window.RecordFolder.pick)
      ? window.RecordFolder.pick()
      : window.showDirectoryPicker({ id: 'vpm-rec', mode: 'readwrite' }).then(function (h) {
          return kvPut('recDir', h).then(function () { return h; });
        });
    p.then(function (h) {
      S.dir = h;
      renderFolder(); updateUsage();
      onStatus('✅ 记录文件夹已设为 <b>' + h.name + '</b>：以后唱完自动写 <code>karaoke-*.json</code> + 录音 <code>.webm</code>；音准页的音域记录也写这里。');
    }).catch(function (e) { if (e && e.name !== 'AbortError') onStatus('设置记录文件夹失败：' + (e.message || e)); });
  }
  function hasPermission() {
    if (!S.dir) return Promise.resolve(false);
    if (!S.dir.queryPermission) return Promise.resolve(true);
    return S.dir.queryPermission({ mode: 'readwrite' }).then(function (st) {
      if (st === 'granted') return true;
      return S.dir.requestPermission({ mode: 'readwrite' }).then(function (st2) { return st2 === 'granted'; });
    }).catch(function () { return false; });
  }
  function writeRecToDir(rec) {
    var base = 'karaoke-' + safe(rec.song) + '-' + stamp();
    return writeFile(S.dir, base + '.json', JSON.stringify(exportObj(rec), null, 1)).then(function () {
      if (rec.audio) return writeFile(S.dir, base + '.webm', rec.audio);
    }).then(function () { return base; });
  }
  /* 浏览器里只留"最近一条"录音（够回听），已存盘的早就不留了 */
  function pruneAudio() {
    return all().then(function (list) {
      list.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
      var kept = 0, tasks = [];
      list.forEach(function (r) {
        if (!r.audio) return;
        if (r.savedTo || kept >= 1) { delete r.audio; tasks.push(put(r)); return; }
        kept++;
      });
      return Promise.all(tasks);
    });
  }
  function updateUsage() {
    var el = $('recUsage'); if (!el) return;
    all().then(function (list) {
      var bytes = 0;
      list.forEach(function (r) {
        if (r.audio) bytes += r.audio.size || 0;
        bytes += JSON.stringify(r.points || []).length;
      });
      var msg = '浏览器里 ' + list.length + ' 条记录 · 数据占用 ≈ ' + (bytes / 1048576).toFixed(1) + ' MB';
      if (navigator.storage && navigator.storage.estimate) {
        navigator.storage.estimate().then(function (e) {
          el.innerHTML = msg + '（浏览器总配额已用 ' + ((e.usage || 0) / 1048576).toFixed(1) + ' MB）';
        }).catch(function () { el.textContent = msg; });
      } else el.textContent = msg;
    }).catch(function () {});
  }
  function purgeAudio() {
    all().then(function (list) {
      var tasks = list.map(function (r) { if (r.audio) { delete r.audio; return put(r); } });
      return Promise.all(tasks).then(function () {
        render(); updateUsage();
        onStatus('🧹 已清掉浏览器里的录音（硬盘文件夹里的文件没动）。');
      });
    }).catch(function () {});
  }

  function attach(s) { stream = s; }

  function supported() { return typeof MediaRecorder !== 'undefined' && !!stream; }

  function start() {
    chunks = []; lastBlob = null;
    if (!supported()) return false;
    try {
      var mime = '';
      if (MediaRecorder.isTypeSupported) {
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mime = 'audio/webm;codecs=opus';
        else if (MediaRecorder.isTypeSupported('audio/webm')) mime = 'audio/webm';
      }
      mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      mr.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      mr.start(1000);
      return true;
    } catch (e) { mr = null; return false; }
  }

  function stop(cb) {
    if (!mr) { cb(null); return; }
    var m = mr; mr = null;
    m.onstop = function () {
      var b = chunks.length ? new Blob(chunks, { type: m.mimeType || 'audio/webm' }) : null;
      chunks = []; lastBlob = b;
      cb(b);
    };
    try { m.stop(); } catch (e) { cb(null); }
  }

  /* ---------- 保存一条记录 ---------- */
  function save(data) {
    var rec = {
      id: 'k' + Date.now(),
      createdAt: new Date().toISOString(),
      song: data.song || '',
      refSource: data.refSource || '',
      songKey: data.songMeta ? data.songMeta.key : '',
      artist: data.songMeta ? data.songMeta.artist : '',
      title: data.songMeta ? data.songMeta.title : '',
      audioName: data.songMeta ? data.songMeta.audioName : '',
      vocalsName: data.songMeta ? data.songMeta.vocalsName : '',
      accompName: data.songMeta ? data.songMeta.accompName : '',
      folder: data.songMeta ? data.songMeta.folder : '',
      a4: data.a4,
      range: data.range,
      durationMs: data.durationMs || 0,
      total: data.result ? data.result.total : null,
      coverage: data.result ? +data.result.coverage.toFixed(1) : null,
      avgAbs: data.result ? +data.result.avgAbs.toFixed(1) : null,
      sungCount: data.result ? data.result.sungCount : 0,
      totalNotes: data.result ? data.result.rows.length : 0,
      perNote: data.result ? data.result.rows.map(function (r) {
        return { i: r.index, sol: r.targetSol, target: +r.targetMidi.toFixed(2),
                 you: r.medMidi === null ? null : +r.medMidi.toFixed(2),
                 cents: r.cents === null ? null : +r.cents.toFixed(1), score: r.score };
      }) : [],
      points: data.points || [],
      audio: data.audio || null
    };
    if (S.dir && S.auto) {
      return hasPermission().then(function (ok) {
        if (!ok) {
          return put(rec).then(function () {
            render(); pruneAudio().then(updateUsage);
            onStatus('⚠️ 文件夹权限失效，这条先存在浏览器里（点「📁 更换文件夹」重新授权）。');
            return rec;
          });
        }
        return writeRecToDir(rec).then(function (base) {
          rec.savedTo = base;   // 已写进你硬盘；浏览器里由 pruneAudio 只保留最近一条的音频
          return put(rec).then(function () {
            render(); pruneAudio().then(updateUsage);
            onStatus('💾 已自动存到文件夹：<code>' + base + '.json</code>' + (data.audio ? ' + <code>' + base + '.webm</code>（你的录音）' : '') +
                     '。浏览器里只留音高数据，不占空间。');
            return rec;
          });
        });
      }).catch(function () { return put(rec).then(function () { render(); updateUsage(); return rec; }); });
    }
    return put(rec).then(function () { render(); pruneAudio().then(updateUsage); return rec; });
  }

  function exportObj(rec) {
    return {
      app: 'vocal-pitch-monitor-karaoke', version: 3,
      createdAt: rec.createdAt, song: rec.song, refSource: rec.refSource, a4: rec.a4,
      myRange: rec.range, durationMs: rec.durationMs,
      summary: { total: rec.total, coverage: rec.coverage, avgAbsCents: rec.avgAbs,
                 sungNotes: rec.sungCount, totalNotes: rec.totalNotes },
      perNote: rec.perNote,
      fields: { points: '[t(ms), f(Hz), midi(小数,69=la4=440), centsVsTarget(相对目标旋律偏差音分)]' },
      points: rec.points
    };
  }
  function csvOf(rec) {
    var rows = ['time_s,freq_hz,midi,cents_vs_target'];
    rec.points.forEach(function (p) {
      rows.push([(p[0] / 1000).toFixed(2), p[1], p[2], p[3] === null || p[3] === undefined ? '' : p[3]].join(','));
    });
    return '\ufeff' + rows.join('\n');
  }
  function download(name, text, mime) {
    var b = new Blob([text], { type: (mime || 'application/json') + ';charset=utf-8' });
    downloadBlob(name, b);
  }
  function downloadBlob(name, blob) {
    var u = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = u; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(u); }, 2000);
  }

  /* ---------- 保存到文件夹（File System Access API） ---------- */
  function writeFile(dir, name, data) {
    return dir.getFileHandle(name, { create: true })
      .then(function (fh) { return fh.createWritable(); })
      .then(function (w) { return w.write(data).then(function () { return w.close(); }); });
  }
  function pickDir() {
    var p = (window.RecordFolder && window.RecordFolder.pick)
      ? window.RecordFolder.pick()
      : window.showDirectoryPicker({ id: 'vpm-rec', mode: 'readwrite' }).then(function (h) {
          return kvPut('recDir', h).then(function () { return h; });
        });
    return p.then(function (h) {
      S.dir = h;
      renderFolder();
      return h;
    });
  }
  /** 手动把某条记录写进文件夹（优先用已设好的文件夹，没设就让你选一次） */
  function saveToFolder(rec) {
    var base = 'karaoke-' + safe(rec.song) + '-' + stamp();
    var json = JSON.stringify(exportObj(rec), null, 1);
    var doWrite = function () {
      return writeRecToDir(rec).then(function (b) {
        rec.savedTo = b;
        return put(rec).then(function () {
          render(); pruneAudio().then(updateUsage);
          onStatus('✅ 已存到文件夹：<code>' + b + '.json</code>（录音 .webm 一起写了）。');
        });
      });
    };
    if (!window.showDirectoryPicker) {
      download(base + '.json', json, 'application/json');
      if (rec.audio) downloadBlob(base + '.webm', rec.audio);
      onStatus('这个浏览器不能直接写文件夹，已改成下载：' + base + '.json' + (rec.audio ? ' / .webm' : ''));
      return;
    }
    var ready = hasPermission().then(function (ok) {
      if (ok) return true;
      return pickDir().then(function () { return hasPermission(); });
    });
    ready.then(function (ok) { if (ok) return doWrite(); else onStatus('没拿到文件夹权限，保存取消。'); })
      .catch(function (e) { if (e && e.name !== 'AbortError') onStatus('保存失败：' + (e.message || e)); });
  }

  /* ---------- 列表渲染 ---------- */
  function render() {
    var box = $('recList'); if (!box) return;
    all().then(function (list) {
      list.sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); });
      if (!list.length) { box.innerHTML = '<p class="muted small">还没有练习记录。唱一段并停下，这里会自动留下你的录音和成绩。</p>'; return; }
      box.innerHTML = list.slice(0, 30).map(function (r) {
        var sc = r.total === null ? '—' : r.total;
        var cls = r.total === null ? '' : (r.total >= 85 ? 'good' : r.total >= 60 ? 'warn' : 'bad');
        return '<div class="rec-item">' +
          '<div class="rec-main"><b>' + (r.song || '(无名)') + '</b>' +
          '<span class="muted small">' + fmtTime(r.createdAt) + (r.savedTo ? ' · 💾已存盘' : '') + ' · 唱到 ' + r.sungCount + '/' + r.totalNotes +
          ' 段 · 平均|偏差| ' + (r.avgAbs === null ? '—' : r.avgAbs) + ' 音分</span></div>' +
          '<div class="rec-score ' + cls + '">' + sc + '<i>分</i></div>' +
          '<div class="row wrap rec-actions">' +
            ((r.audio || r.savedTo) ? '<button class="btn btn-ghost btn-sm" data-act="play" data-id="' + r.id + '">🎧 录音+伴奏</button>' +
              '<button class="btn btn-ghost btn-sm" data-act="orig" data-id="' + r.id + '">🎤 原唱版</button>' : '') +
            '<button class="btn btn-ghost btn-sm" data-act="save" data-id="' + r.id + '">💾 存文件夹</button>' +
            '<button class="btn btn-ghost btn-sm" data-act="json" data-id="' + r.id + '">JSON</button>' +
            '<button class="btn btn-ghost btn-sm danger" data-act="del" data-id="' + r.id + '">删</button>' +
          '</div></div>';
      }).join('');
      box._cache = list;
      updateUsage();
    }).catch(function () {
      box.innerHTML = '<p class="muted small">（浏览器不支持本地记录存储）</p>';
    });
  }

  function byId(id) { return all().then(function (l) { return l.filter(function (r) { return r.id === id; })[0]; }); }
  function findSavedWebm(r) {
    if (!S.dir || !S.dir.entries) return Promise.resolve(null);
    var prefix = 'karaoke-' + safe(r.song) + '-';
    return new Promise(function (resolve) {
      var it = S.dir.entries(), best = null, bestName = '';
      function step() {
        it.next().then(function (res) {
          if (res.done) return resolve(best);
          var name = res.value[0], entry = res.value[1];
          if (entry.kind === 'file' && name.indexOf(prefix) === 0 && /\.webm$/i.test(name) && (!bestName || name > bestName)) {
            best = entry; bestName = name;
          }
          step();
        }, function () { resolve(best); });
      }
      step();
    }).then(function (entry) {
      return entry ? entry.getFile().catch(function () { return null; }) : null;
    }).catch(function () { return null; });
  }
  function getRecordAudio(r) {
    if (r.audio) return Promise.resolve(r.audio);
    return (prefsReady || Promise.resolve()).then(function () {
      if (!S.dir) return null;
      return hasPermission().then(function (ok) {
        if (!ok) return null;
        var first = r.savedTo ? S.dir.getFileHandle(r.savedTo + '.webm').then(function (fh) {
          return fh.getFile();
        }).catch(function () { return null; }) : Promise.resolve(null);
        return first.then(function (file) {
          if (file) return file;
          return findSavedWebm(r);
        });
      }).catch(function () { return null; });
    });
  }

  /* ---------- 混合回放：录音 + 伴奏 / 原唱 ---------- */
  /**
   * 决定「录音 + ?」回放时混哪一路（纯函数，可单测）
   *   · 「🎤 原唱版」：有伴奏版 → 伴奏(.no_vocals) + 原唱(.vocals) 两轨；
   *                    没有伴奏版 → 直接放完整版（原唱本身就在里面）
   *   · 「🎧 录音+伴奏」：只认伴奏版 .no_vocals。没有伴奏版时 backing = null，
   *                    调用方只回放录音 —— 绝不拿带原唱的完整版来凑数
   *                    （完整版会盖住人声，用户反馈过"录音里原唱很大"）
   */
  function pickBacking(files, mode) {
    var f = files || {};
    var hasOriginalStem = !!(f.accomp && f.vocals);
    if (mode === 'original') {
      if (hasOriginalStem) return { mode: 'original', backing: f.accomp, vocals: f.vocals };
      if (f.audio) return { mode: 'original', backing: f.audio, vocals: null };
      return { mode: 'voice', backing: null, vocals: null };
    }
    return { mode: 'voice', backing: f.accomp || null, vocals: null };
  }

  /* ---------- 响度对齐：混音时让「人声 / 原唱 / 伴奏」分贝相当 ----------
     为什么需要：录音是麦克风近距离的干声，商业伴奏是压过限的母带，
     两者响度能差十几 dB（实测某次录音 −22.7 dBFS vs 伴奏 −14.3 dBFS）——
     固定音量下人声会被伴奏整个盖住。这里按"量出来的响度"给每路算增益，
     人声那一路允许放大（>1），并且先估峰值总和、必要时整体等量压低，保证不削顶。
     目标：人声比伴奏高 2dB —— 听感相当，人声又不被压住。 */
  var VOICE_TARGET_DB = -17;   // 人声（你的录音、或原唱轨）目标响度 dBFS
  var BACK_TARGET_DB = -19;    // 伴奏目标响度 dBFS
  var MAX_BOOST_DB = 18;       // 人声最多补 18dB，再多就把底噪也一起放大
  var MIN_GAIN_DB = -24;       // 最多压 24dB
  var HEADROOM = 0.95;         // 没有限幅时的估计总峰值上限（绝不削顶）
  var LIMITED_HEADROOM = 1.5;  // 有限幅总线时允许更热，响度不至于比原来小
  var loudCache = {};          // 响度缓存：同一份文件不必每次回放都重算

  function dbToGain(db) { return Math.pow(10, db / 20); }
  function gainDb(g) { return g > 0 ? 20 * Math.log10(g) : -120; }

  /** 每 50ms 一帧功率 → 以最响帧 −10dB 为门限，门限内平均功率 = 响度；顺带取真实峰值 */
  function bufferLoudness(buf) {
    var d = buf.getChannelData(0), sr = buf.sampleRate || 8000;
    var win = Math.max(64, Math.round(sr * 0.05));
    var frames = [], db, i, k, s, v, peak = 0;
    for (i = 0; i + win <= d.length; i += win) {
      s = 0;
      for (k = 0; k < win; k++) { v = d[i + k]; s += v * v; }
      frames.push(s / win);
    }
    if (!frames.length) return null;
    for (i = 0; i < d.length; i++) { v = d[i] < 0 ? -d[i] : d[i]; if (v > peak) peak = v; }
    var mx = 0;
    for (i = 0; i < frames.length; i++) if (frames[i] > mx) mx = frames[i];
    if (!(mx > 0)) return null;
    var gate = mx * 0.1, acc = 0, n = 0;                 // −10dB 门限：只统计"真的在响"的帧
    for (i = 0; i < frames.length; i++) if (frames[i] >= gate) { acc += frames[i]; n++; }
    if (!n) { acc = mx; n = 1; }
    return { db: 10 * Math.log10(acc / n), peak: peak };
  }

  /** 用 8kHz 的离线上下文解码 —— 4 分钟的歌只要 ~18MB，只为算响度，不进播放链路 */
  function decodeLoudness(file) {
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC || !file || !file.arrayBuffer) return Promise.resolve(null);
    return file.arrayBuffer().then(function (ab) {
      var ctx;
      try { ctx = new OAC(1, 1, 8000); } catch (e) { return null; }
      return new Promise(function (res) {
        var done = false;
        function ok(b) { if (!done) { done = true; res(b ? bufferLoudness(b) : null); } }
        function no() { if (!done) { done = true; res(null); } }
        var p = null;
        try { p = ctx.decodeAudioData(ab, ok, no); } catch (e) { return no(); }
        if (p && p.then) p.then(ok, no);
      });
    }).catch(function () { return null; });
  }
  function measureLoudness(file, key) {
    key = key || (((file && file.name) || 'blob') + '|' + ((file && file.size) || 0));
    if (loudCache[key] !== undefined) return Promise.resolve(loudCache[key]);
    return decodeLoudness(file).then(function (r) { loudCache[key] = r; return r; });
  }

  /**
   * 按测量到的响度算每路增益（纯函数，可单测）
   *   tracks: [{role:'voice'|'accomp'}]，louds: [{db,peak}|null] 一一对应
   *   headroom: 估计总峰值上限（有限幅总线时可以给得比 1 大）
   *   返回 [{gain, db, peak, target}]，gain 是线性增益（>1 = 放大）
   */
  function planMixLevels(tracks, louds, headroom) {
    var limit = isFinite(headroom) ? headroom : HEADROOM;
    var plan = tracks.map(function (t, i) {
      var L = (louds && louds[i]) || null;
      var target = (t.role === 'voice') ? VOICE_TARGET_DB : BACK_TARGET_DB;
      if (!L) {
        /* 量不出来（解码失败/浏览器不支持）→ 退回老比例：人声 1.0、伴奏 0.6 */
        return { gain: (t.role === 'voice') ? 1 : 0.6, db: null, peak: 0.4, target: target };
      }
      var want = Math.max(MIN_GAIN_DB, Math.min(MAX_BOOST_DB, target - L.db));
      return { gain: dbToGain(want), db: L.db, peak: L.peak, target: target };
    });
    /* 估计总峰值，超了就整体等比例压低：人声与伴奏的 dB 差保持不变，只是整体小一点 */
    var sum = 0, i;
    for (i = 0; i < plan.length; i++) sum += plan[i].gain * (plan[i].peak || 0);
    var k = sum > limit ? limit / sum : 1;
    for (i = 0; i < plan.length; i++) plan[i].gain *= k;
    return plan;
  }

  /** 没有 Web Audio（不能放大）时的兜底：整体等量压低，保住人声/伴奏的相对比例 */
  function fallbackVolumes(plan) {
    var mx = 0;
    plan.forEach(function (p) { if (p.gain > mx) mx = p.gain; });
    var k = mx > 1 ? 1 / mx : 1;
    return plan.map(function (p) { return Math.max(0, Math.min(1, p.gain * k)); });
  }

  var audioCtx = null, master = null;
  function ensureAudioCtx() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (audioCtx === null) {
      try { audioCtx = new AC(); } catch (e) { audioCtx = false; }
    }
    return audioCtx || null;
  }
  /** 总线：各路 → master gain →（有限幅器就串上）→ destination */
  function masterBus(ctx) {
    if (master && master.ctx === ctx) return master;
    var input = ctx.createGain(), limiter = null;
    if (ctx.createDynamicsCompressor) {
      try {
        limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -3;      // 只压峰，不动平均音量
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.25;
        input.connect(limiter);
        limiter.connect(ctx.destination);
      } catch (e) {
        limiter = null;
        try { input.disconnect(); } catch (e2) {}
      }
    }
    if (!limiter) input.connect(ctx.destination);
    master = { ctx: ctx, input: input, limiter: limiter };
    return master;
  }

  var mixPlayers = [], mixTimer = null, playingId = null, playingMode = null;

  function setPlayStatus(msg) {
    var el = $('recPlayInfo');
    if (el) el.innerHTML = msg || '';
    onStatus(msg || '');
  }
  function fmtClock(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function showPlayBar(durMs) {
    if (!playBarEl) return;
    playDurMs = isFinite(durMs) && durMs > 0 ? durMs : 0;
    playBarEl.hidden = false;
    if (recSeekEl) recSeekEl.value = 0;
    updatePlayBar(0);
  }
  function hidePlayBar() {
    if (playBarEl) playBarEl.hidden = true;
    playDurMs = 0;
    seeking = false;
    if (recSeekEl) recSeekEl.value = 0;
    if (recTimeEl) recTimeEl.textContent = '0:00 / 0:00';
  }
  function setPlayDuration(durMs) {
    if (isFinite(durMs) && durMs > 0) playDurMs = durMs;
  }
  function updatePlayBar(ms) {
    if (!playBarEl || playBarEl.hidden) return;
    if (playDurMs > 0 && isFinite(ms)) {
      var pct = Math.max(0, Math.min(1, ms / playDurMs));
      if (!seeking && recSeekEl) recSeekEl.value = Math.round(pct * 1000);
    }
    if (recTimeEl) recTimeEl.textContent = fmtClock(ms) + ' / ' + fmtClock(playDurMs);
  }
  function seekPlayback(ms) {
    if (!playDurMs) return;
    ms = Math.max(0, Math.min(playDurMs, ms));
    mixPlayers.forEach(function (a) {
      try { a.currentTime = ms / 1000; } catch (e) {}
    });
    var dry = $('recPlayer');
    if (dry && dry.src) { try { dry.currentTime = ms / 1000; } catch (e) {} }
    updatePlayBar(ms);
    if (window.KaraokeAPI && KaraokeAPI.syncPlayback) KaraokeAPI.syncPlayback(ms);
  }
  function stopMix() {
    if (mixTimer) { clearInterval(mixTimer); mixTimer = null; }
    mixPlayers.forEach(function (a) {
      try { a.pause(); } catch (e) {}
      try { if (a._src) a._src.disconnect(); } catch (e) {}
      try { if (a._gainNode) a._gainNode.disconnect(); } catch (e) {}
      try { if (a._url) URL.revokeObjectURL(a._url); } catch (e) {}
      try { a.removeAttribute('src'); a.load(); } catch (e) {}
      try { if (a.parentNode) a.parentNode.removeChild(a); } catch (e) {}
    });
    mixPlayers = [];
    playingId = null; playingMode = null;
    hidePlayBar();
  }
  /** gain 用 Web Audio 的 GainNode 落地（可以 >1 放大）；没有音频图时退回 volume（≤1） */
  function makeMixTrack(file, gain, useGraph) {
    var url = URL.createObjectURL(file);
    var a = document.createElement('audio');
    a.preload = 'auto';
    a.src = url;
    a.style.display = 'none';
    a._url = url;
    a.volume = 1;
    document.body.appendChild(a);
    if (useGraph) {
      var ctx = ensureAudioCtx();
      if (ctx) {
        try {
          var src = ctx.createMediaElementSource(a);
          var node = ctx.createGain();
          node.gain.value = gain;
          src.connect(node);
          node.connect(masterBus(ctx).input);
          a._src = src; a._gainNode = node;
        } catch (e) { a.volume = Math.max(0, Math.min(1, gain)); }
      }
    } else {
      a.volume = Math.max(0, Math.min(1, gain));
    }
    mixPlayers.push(a);
    return a;
  }
  function whenReady(a) {
    return new Promise(function (resolve) {
      if (a.readyState >= 3) return resolve();
      var timer = setTimeout(finish, 2500);
      function finish() {
        clearTimeout(timer);
        a.removeEventListener('canplaythrough', finish);
        a.removeEventListener('loadeddata', finish);
        a.removeEventListener('error', finish);
        resolve();
      }
      a.addEventListener('canplaythrough', finish);
      a.addEventListener('loadeddata', finish);
      a.addEventListener('error', finish);
      a.load();
    });
  }
  function pauseDryPlayer() {
    var d = $('recPlayer');
    if (d) { try { d.pause(); } catch (e) {} }
  }
  function playDry(r, audio, msg) {
    var box = $('recPlayer') || (function () {
      var d = document.createElement('audio');
      d.id = 'recPlayer'; d.controls = true; d.className = 'audio-player';
      var host = $('recList'); if (host) host.parentNode.insertBefore(d, host);
      return d;
    })();
    if (box._url) URL.revokeObjectURL(box._url);
    box._url = URL.createObjectURL(audio);
    box.src = box._url;
    var dryDur = r.durationMs || 0;
    if (box.duration && isFinite(box.duration)) dryDur = box.duration * 1000;
    showPlayBar(dryDur);
    box.ontimeupdate = function () {
      var ms = box.currentTime * 1000;
      if (box.duration && isFinite(box.duration)) setPlayDuration(box.duration * 1000);
      updatePlayBar(ms);
      if (window.KaraokeAPI && KaraokeAPI.syncPlayback) KaraokeAPI.syncPlayback(ms);
    };
    var p = box.play();
    if (p && p.catch) p.catch(function () {});
    setPlayStatus(msg || ('🎧 正在回放：' + (r.song || '') + '（' + fmtTime(r.createdAt) + '）'));
  }
  function playMixed(r, audio, song, files, mode) {
    var pick = pickBacking(files, mode);
    mode = pick.mode;
    var backing = pick.backing, hasOriginalStem = !!pick.vocals;
    if (!backing) {
      if (mode === 'original') { playDry(r, audio, '这首没有找到伴奏/完整版，先只回放你的录音。'); return; }
      /* 没有 .no_vocals（伴奏版）时，绝不能拿完整版来凑「录音+伴奏」——
         完整版里有原唱，混进来会出现「我的录音里原唱声音很大」的错觉
         （成龙 - 拯救 (2013再生抒情版) 当时就没有伴奏版，用户实际反馈过这条）。
         想听完整版请点「🎤 原唱版」。 */
      playDry(r, audio, '🎧 正在回放：' + (r.song || '') + ' · <b>只有你的录音</b>'
        + '（这首没找到伴奏版 <code>.no_vocals</code>；完整版带原唱，混进来会盖住你的声音。'
        + '想听「伴奏 + 原唱」请点「🎤 原唱版」）');
      return;
    }
    /* ① 排出这次要混的每一路：录音永远放第一路（进度条/时长都按它算） */
    var tracks = [{ file: audio, role: 'voice', key: 'rec|' + r.id }];
    if (mode === 'original' && hasOriginalStem) {
      tracks.push({ file: backing, role: 'accomp' });
      tracks.push({ file: pick.vocals, role: 'voice' });
    } else {
      tracks.push({ file: backing, role: 'accomp' });
    }
    var label = mode === 'original'
      ? (hasOriginalStem ? '伴奏 + 原唱 + 你的录音' : '完整版（原唱 + 伴奏）+ 你的录音')
      : '我的录音 + 伴奏';

    pauseDryPlayer();
    playingId = r.id; playingMode = mode;
    showPlayBar(r.durationMs || 0);
    setPlayStatus('🎧 正在准备回放：' + (r.song || '') + ' · ' + label + '（正在量响度…）');

    /* ② 先把 AudioContext 唤醒（必须借着这次点击），再量各路响度 */
    var ctx = ensureAudioCtx();
    var kick = (ctx && ctx.state === 'suspended' && ctx.resume) ? ctx.resume().catch(function () {}) : Promise.resolve();
    Promise.all([
      kick,
      Promise.all(tracks.map(function (t) { return measureLoudness(t.file, t.key); }))
    ]).then(function (res) {
      /* ③ 按响度算增益 → 人声可以放大；有限幅总线就允许整体更热一点 */
      var useGraph = !!(ctx && ctx.state === 'running');
      var bus = useGraph ? masterBus(ctx) : null;
      var limited = !!(bus && bus.limiter);
      var plan = planMixLevels(tracks, res[1] || [], limited ? LIMITED_HEADROOM : HEADROOM);
      var vols = fallbackVolumes(plan);
      var players = tracks.map(function (t, i) {
        return makeMixTrack(t.file, useGraph ? plan[i].gain : vols[i], useGraph);
      });
      var detail = plan.map(function (p, i) {
        return (tracks[i].role === 'voice' ? '人声 ' : '伴奏 ') +
          (p.gain >= 1 ? '+' : '') + gainDb(p.gain).toFixed(1) + 'dB';
      }).join(' / ');
      setPlayStatus('🎧 正在回放：' + (r.song || '') + ' · ' + label +
        ' · <span class="muted small">响度对齐：' + detail + (limited ? '（带限幅）' : '') +
        (useGraph ? '' : '（浏览器没给音频图，只能整体衰减）') +
        '</span>（再点一次停止）');

      if (mixTimer) clearInterval(mixTimer);
      mixTimer = setInterval(function () {
        if (!players[0]) return;
        var ms = players[0].currentTime * 1000;
        if (players[0].duration && isFinite(players[0].duration)) setPlayDuration(players[0].duration * 1000);
        updatePlayBar(ms);
        if (window.KaraokeAPI && KaraokeAPI.syncPlayback) KaraokeAPI.syncPlayback(ms);
      }, 100);
      return Promise.all(players.map(whenReady)).then(function () {
        return Promise.all(players.map(function (a) {
          var p = a.play();
          return p && p.catch ? p.catch(function () {}) : Promise.resolve();
        }));
      }).then(function () {
        if (players[0].duration && isFinite(players[0].duration)) setPlayDuration(players[0].duration * 1000);
        updatePlayBar(players[0].currentTime * 1000);
        players[0].addEventListener('ended', function () {
          if (playingId === r.id) { stopMix(); setPlayStatus('回放结束。'); }
        });
      });
    }).catch(function (e) {
      stopMix();
      playDry(r, audio, '播放失败，先只回放你的录音：' + (e && e.message ? e.message : e));
    });
  }
  function play(id, mode) {
    mode = mode || 'voice';
    byId(id).then(function (r) {
      if (!r) { setPlayStatus('找不到这条练习记录。'); return; }
      getRecordAudio(r).then(function (audio) {
        if (!audio) { setPlayStatus('这条记录没有可播放的录音（如果已存盘，请先在③设置记录文件夹并授权）。'); return; }
        if (playingId === id && playingMode === mode) {
          pauseDryPlayer(); stopMix(); setPlayStatus('已停止回放。'); return;
        }
        stopMix();
        if (window.KaraokeAPI && KaraokeAPI.showRecord) KaraokeAPI.showRecord(r, null);
        var SL = window.SongLibrary;
        if (!SL || !SL.findSong) { playDry(r, audio, '曲库模块还没准备好，先只回放你的录音。'); return; }
        var ready = SL.ensureReady ? SL.ensureReady() : Promise.resolve(!!SL.findSong(r));
        ready.then(function (ok) {
          if (!ok) { playDry(r, audio, '曲库还没载入：先在①授权/扫描音乐文件夹，再回来；现在先只回放你的录音。'); return; }
          var song = SL.findSong(r);
          if (!song) { playDry(r, audio, '曲库里找不到这条记录对应的歌，先只回放你的录音。'); return; }
          SL.getTracks(song).then(function (files) {
            if (window.KaraokeAPI && KaraokeAPI.showRecord) KaraokeAPI.showRecord(r, files.lrc);
            playMixed(r, audio, song, files, mode);
          }).catch(function (e) {
            playDry(r, audio, '伴奏读取失败，先只回放你的录音：' + (e && e.message ? e.message : e));
          });
        }).catch(function (e) {
          playDry(r, audio, '曲库准备失败，先只回放你的录音：' + (e && e.message ? e.message : e));
        });
      }).catch(function (e) {
        setPlayStatus('读取录音失败：' + (e && e.message ? e.message : e));
      });
    });
  }

  function wire() {
    prefsReady = loadPrefs();
    var box = $('recList');
    playBarEl = $('recPlayBar'); recSeekEl = $('recSeek'); recTimeEl = $('recTime');
    if (recSeekEl) {
      recSeekEl.addEventListener('input', function () {
        seeking = true;
        seekPlayback((+this.value / 1000) * playDurMs);
      });
      recSeekEl.addEventListener('change', function () { seeking = false; });
    }
    var stopBtn = $('recStopBtn');
    if (stopBtn) stopBtn.addEventListener('click', function () {
      pauseDryPlayer();
      stopMix();
      setPlayStatus('已停止回放。');
    });
    if (box) {
      box.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('button[data-act]') : null;
        if (!b) return;
        var id = b.dataset.id, act = b.dataset.act;
        if (act === 'play') play(id, 'voice');
        else if (act === 'orig') play(id, 'original');
        else if (act === 'save') byId(id).then(function (r) { if (r) saveToFolder(r); });
        else if (act === 'json') byId(id).then(function (r) { if (r) download('karaoke-' + safe(r.song) + '-' + stamp() + '.json', JSON.stringify(exportObj(r), null, 1), 'application/json'); });
        else if (act === 'del') del(id).then(render);
      });
    }
    var fb = $('recFolderBtn');
    if (fb) fb.addEventListener('click', setFolder);
    var ac = $('recAutoChk');
    if (ac) ac.addEventListener('change', function () {
      S.auto = this.checked;
      try { localStorage.setItem('vpm.recAuto', S.auto ? '1' : '0'); } catch (e) {}
      onStatus(S.auto && S.dir ? ('以后唱完会自动写进 ' + S.dir.name) : '已关闭自动保存（录音会留在浏览器里，可用「🧹 清理」删掉）');
    });
    var pg = $('recPurgeBtn');
    if (pg) pg.addEventListener('click', purgeAudio);
    updateUsage();
    var pb = $('playRecBtn');
    if (pb) pb.addEventListener('click', function () {
      all().then(function (l) {
        l.sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); });
        var withAudio = l.filter(function (r) { return r.audio || r.savedTo; });
        if (!withAudio.length) { onStatus('还没有带录音的记录（这一版才开始录音，之前唱的没有音频）。'); return; }
        play(withAudio[0].id, 'voice');
      });
    });
    var sb = $('saveRecBtn');
    if (sb) sb.addEventListener('click', function () {
      all().then(function (l) {
        l.sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); });
        if (!l.length) { onStatus('还没有练习记录可保存。'); return; }
        saveToFolder(l[0]);
      });
    });
    render();
  }

  window.KaraokeRec = {
    attach: attach,
    start: start,
    stop: stop,
    save: save,
    render: render,
    supported: supported,
    pickBacking: pickBacking,
    bufferLoudness: bufferLoudness,
    planMixLevels: planMixLevels,
    fallbackVolumes: fallbackVolumes,
    hasAudio: function () { return !!lastBlob; },
    setStatus: function (fn) { onStatus = fn; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
