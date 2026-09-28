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
  function getRecordAudio(r) {
    if (r.audio) return Promise.resolve(r.audio);
    if (!r.savedTo || !S.dir) return Promise.resolve(null);
    return hasPermission().then(function (ok) {
      if (!ok) return null;
      return S.dir.getFileHandle(r.savedTo + '.webm').then(function (fh) {
        return fh.getFile();
      }).catch(function () { return null; });
    }).catch(function () { return null; });
  }

  /* ---------- 混合回放：录音 + 伴奏 / 原唱 ---------- */
  var mixPlayers = [], mixTimer = null, playingId = null, playingMode = null;

  function setPlayStatus(msg) {
    var el = $('recPlayInfo');
    if (el) el.innerHTML = msg || '';
    onStatus(msg || '');
  }
  function stopMix() {
    if (mixTimer) { clearTimeout(mixTimer); mixTimer = null; }
    mixPlayers.forEach(function (a) {
      try { a.pause(); } catch (e) {}
      try { if (a._url) URL.revokeObjectURL(a._url); } catch (e) {}
      try { a.removeAttribute('src'); a.load(); } catch (e) {}
    });
    mixPlayers = [];
    playingId = null; playingMode = null;
  }
  function makeMixTrack(file, volume) {
    var url = URL.createObjectURL(file);
    var a = document.createElement('audio');
    a.preload = 'auto';
    a.src = url;
    a.volume = volume;
    a.style.display = 'none';
    a._url = url;
    document.body.appendChild(a);
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
    var p = box.play();
    if (p && p.catch) p.catch(function () {});
    setPlayStatus(msg || ('🎧 正在回放：' + (r.song || '') + '（' + fmtTime(r.createdAt) + '）'));
  }
  function playMixed(r, audio, song, files, mode) {
    var hasAccomp = !!files.accomp;
    var hasOriginalStem = !!(hasAccomp && files.vocals);
    var useFullForOriginal = (mode === 'original') && !hasOriginalStem && !!files.audio;
    if (mode === 'original' && !hasOriginalStem && !useFullForOriginal) mode = 'voice';
    var backing = useFullForOriginal ? files.audio : (files.accomp || files.audio);
    if (!backing) { playDry(r, audio, '这首没有找到伴奏/完整版，先只回放你的录音。'); return; }
    var recVol, backVol;
    if (mode === 'original') {
      if (useFullForOriginal) { recVol = 0.35; backVol = 1; }
      else { recVol = 0.45; backVol = 0.35; }
    } else {
      recVol = 1;
      backVol = hasAccomp ? 0.85 : 0.45;
    }
    pauseDryPlayer();
    var players = [];
    players.push(makeMixTrack(audio, recVol));
    players.push(makeMixTrack(backing, backVol));
    if (mode === 'original' && hasOriginalStem) players.push(makeMixTrack(files.vocals, 1));
    playingId = r.id; playingMode = mode;
    var label = mode === 'original'
      ? (hasOriginalStem ? '伴奏 + 原唱（原唱声音更大）' : '完整版（原唱 + 伴奏）')
      : (hasAccomp ? '我的录音 + 伴奏' : '我的录音 + 完整版（可能带原唱）');
    setPlayStatus('🎧 正在回放：' + (r.song || '') + ' · ' + label + '（再点一次停止）');
    Promise.all(players.map(whenReady)).then(function () {
      return Promise.all(players.map(function (a) {
        var p = a.play();
        return p && p.catch ? p.catch(function () {}) : Promise.resolve();
      }));
    }).then(function () {
      players[0].addEventListener('ended', function () {
        if (playingId === r.id) { stopMix(); setPlayStatus('回放结束。'); }
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
        var SL = window.SongLibrary;
        if (!SL || !SL.findSong) { playDry(r, audio, '曲库模块还没准备好，先只回放你的录音。'); return; }
        var ready = SL.ensureReady ? SL.ensureReady() : Promise.resolve(!!SL.findSong(r));
        ready.then(function (ok) {
          if (!ok) { playDry(r, audio, '曲库还没载入：先在①授权/扫描音乐文件夹，再回来；现在先只回放你的录音。'); return; }
          var song = SL.findSong(r);
          if (!song) { playDry(r, audio, '曲库里找不到这条记录对应的歌，先只回放你的录音。'); return; }
          SL.getTracks(song).then(function (files) {
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
    loadPrefs();
    var box = $('recList');
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
    hasAudio: function () { return !!lastBlob; },
    setStatus: function (fn) { onStatus = fn; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
