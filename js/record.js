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
    return put(rec).then(function () { render(); return rec; });
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
    return window.showDirectoryPicker({ id: 'vpm-rec', mode: 'readwrite' }).then(function (h) {
      kvPut('recDir', h);
      return h;
    });
  }
  function saveToFolder(rec) {
    var base = 'karaoke-' + safe(rec.song) + '-' + stamp();
    var json = JSON.stringify(exportObj(rec), null, 1);
    var write = function (dir) {
      return writeFile(dir, base + '.json', json).then(function () {
        if (rec.audio) return writeFile(dir, base + '.webm', rec.audio);
      }).then(function () {
        onStatus('✅ 已存到文件夹：' + base + '.json' + (rec.audio ? ' + ' + base + '.webm（你的录音）' : '') +
                 ' —— 把这个 json 发我就能逐音分析。');
      });
    };
    if (!window.showDirectoryPicker) {
      download(base + '.json', json, 'application/json');
      if (rec.audio) downloadBlob(base + '.webm', rec.audio);
      onStatus('这个浏览器不能直接写文件夹，已改为下载两个文件：' + base + '.json / .webm');
      return;
    }
    kvGet('recDir').then(function (h) {
      if (!h) return pickDir();
      if (h.queryPermission) {
        return h.queryPermission({ mode: 'readwrite' }).then(function (st) {
          if (st === 'granted') return h;
          return h.requestPermission({ mode: 'readwrite' }).then(function (st2) {
            return st2 === 'granted' ? h : pickDir();
          });
        });
      }
      return h;
    }).then(write).catch(function (e) {
      if (e && e.name !== 'AbortError') onStatus('保存失败：' + (e.message || e));
    });
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
          '<span class="muted small">' + fmtTime(r.createdAt) + ' · 唱到 ' + r.sungCount + '/' + r.totalNotes +
          ' 段 · 平均|偏差| ' + (r.avgAbs === null ? '—' : r.avgAbs) + ' 音分</span></div>' +
          '<div class="rec-score ' + cls + '">' + sc + '<i>分</i></div>' +
          '<div class="row">' +
            (r.audio ? '<button class="btn btn-ghost btn-sm" data-act="play" data-id="' + r.id + '">🎧 回听</button>' : '') +
            '<button class="btn btn-ghost btn-sm" data-act="save" data-id="' + r.id + '">💾 存文件夹</button>' +
            '<button class="btn btn-ghost btn-sm" data-act="json" data-id="' + r.id + '">JSON</button>' +
            '<button class="btn btn-ghost btn-sm danger" data-act="del" data-id="' + r.id + '">删</button>' +
          '</div></div>';
      }).join('');
      box._cache = list;
    }).catch(function () {
      box.innerHTML = '<p class="muted small">（浏览器不支持本地记录存储）</p>';
    });
  }

  function byId(id) { return all().then(function (l) { return l.filter(function (r) { return r.id === id; })[0]; }); }

  function play(id) {
    byId(id).then(function (r) {
      if (!r || !r.audio) return;
      var box = $('recPlayer') || (function () {
        var d = document.createElement('audio');
        d.id = 'recPlayer'; d.controls = true; d.className = 'audio-player';
        var host = $('recList'); if (host) host.parentNode.insertBefore(d, host);
        return d;
      })();
      if (box._url) URL.revokeObjectURL(box._url);
      box._url = URL.createObjectURL(r.audio);
      box.src = box._url;
      box.play();
      onStatus('🎧 正在回放：' + (r.song || '') + '（' + fmtTime(r.createdAt) + '）');
    });
  }

  function wire() {
    var box = $('recList');
    if (box) {
      box.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('button[data-act]') : null;
        if (!b) return;
        var id = b.dataset.id, act = b.dataset.act;
        if (act === 'play') play(id);
        else if (act === 'save') byId(id).then(function (r) { if (r) saveToFolder(r); });
        else if (act === 'json') byId(id).then(function (r) { if (r) download('karaoke-' + safe(r.song) + '-' + stamp() + '.json', JSON.stringify(exportObj(r), null, 1), 'application/json'); });
        else if (act === 'del') del(id).then(render);
      });
    }
    var pb = $('playRecBtn');
    if (pb) pb.addEventListener('click', function () {
      all().then(function (l) {
        l.sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); });
        var withAudio = l.filter(function (r) { return r.audio; });
        if (!withAudio.length) { onStatus('还没有带录音的记录（这一版才开始录音，之前唱的没有音频）。'); return; }
        play(withAudio[0].id);
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
    hasAudio: function () { return !!lastBlob; },
    setStatus: function (fn) { onStatus = fn; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();