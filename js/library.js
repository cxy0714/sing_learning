/* ============================================================
 * library.js —— 本地曲库：扫描音乐文件夹 → 按歌手/歌名搜索 → 点击即唱
 *
 *   ⚠️ 浏览器不允许网页自己扫硬盘，所以必须由「你」授权一次：
 *      · Chrome / Edge：File System Access API —— 授权文件夹后可以枚举文件，
 *        授权句柄存进 IndexedDB，下次进来点一下「继续使用」即可（不用重新选）
 *      · 其它浏览器：用 webkitdirectory 选一次文件夹（本次会话有效）
 *
 *   文件始终只在你的浏览器内存里被读取，不会上传任何地方。
 * ============================================================ */
(function () {
  'use strict';

  var AUDIO_RE = /\.(mp3|flac|m4a|wav|aac|ogg|opus)$/i;
  var LRC_RE = /\.lrc$/i;
  var NCM_RE = /\.ncm$/i;
  var SUF_RE = /\.(vocals|no_vocals)$/i;
  var EXT_RANK = { '.mp3': 1, '.flac': 2, '.m4a': 3, '.wav': 4, '.aac': 5, '.ogg': 6, '.opus': 7 };

  /* ---------- 纯函数（可单测） ---------- */

  /** 「周华健 - 难念的经」→ {artist:'周华健', title:'难念的经'} */
  function parseSongName(base) {
    var s = String(base || '').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/\.(vocals|no_vocals)$/i, '');
    var i = s.indexOf(' - ');
    if (i < 0) return { artist: '未知歌手', title: s.trim() || '(无名)' };
    return { artist: s.slice(0, i).trim() || '未知歌手', title: s.slice(i + 3).trim() || '(无名)' };
  }

  /** 去掉网易云重复下载产生的 " (1)" 尾巴（保留 (Live版) 这类有意义的后缀） */
  function stripCopySuffix(title) { return String(title).replace(/\s*\(\d+\)\s*$/, ''); }

  /**
   * 把扫描到的文件列表整理成曲库条目
   * @param items [{name, rel, getFile}]（rel 是相对路径，带子目录）
   */
  function buildCatalog(items) {
    var groups = {}, lrcMap = {}, lrcGlobal = {}, vocGlobal = {}, ncmCount = 0;
    items.forEach(function (it) {
      var name = it.name || '';
      var mExt = name.match(/\.[^.]+$/);
      var ext = mExt ? mExt[0].toLowerCase() : '';
      var folder = (it.rel || name).replace(/[^\/\\]*$/, '').replace(/\\/g, '/');
      var base = name.replace(/\.[^.]+$/, '');
      if (LRC_RE.test(name)) {
        lrcMap[folder + '|' + base] = it;
        if (!lrcGlobal[base]) lrcGlobal[base] = it;      // 跨目录兜底：歌词放在别的子目录也能配上
        return;
      }
      if (NCM_RE.test(name)) { ncmCount++; return; }
      if (!AUDIO_RE.test(name)) return;
      var suf = (base.match(SUF_RE) || [''])[0].toLowerCase();
      var songBase = base.replace(SUF_RE, '');
      var key = folder + '|' + songBase;
      var g = groups[key];
      if (!g) { g = groups[key] = { key: key, folder: folder, songBase: songBase }; }
      if (suf === '.vocals') { g.vocals = it; if (!vocGlobal[songBase]) vocGlobal[songBase] = it; }
      else if (suf === '.no_vocals') g.accomp = it;
      else {
        var r = EXT_RANK[ext] || 9;
        if (!g.audio || r < (g.audioRank || 9)) { g.audio = it; g.audioRank = r; g.audioExt = ext; }
      }
    });
    var out = [];
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      if (!g.audio && !g.vocals) return;                     // 只有伴奏的忽略
      var p = parseSongName(g.songBase);
      out.push({
        key: k,
        artist: p.artist,
        title: stripCopySuffix(p.title),
        titleRaw: p.title,
        folder: g.folder.replace(/\/$/, ''),
        audio: g.audio || null,
        vocals: g.vocals || vocGlobal[g.songBase] || null,
        accomp: g.accomp || null,
        lrc: lrcMap[k] || lrcGlobal[g.songBase] || null,
        lrcLocal: !!lrcMap[k],
        ext: g.audioExt || '.mp3'
      });
    });
    /* 合并同一首歌的多个副本（网易云重复下载、转换目录、人声目录各一份）
       —— 资产取并集，主音频挑"最像正版"的那份 */
    function audioScore(s) {
      var sc = 0;
      if (EXT_RANK[s.audioExt] === 1) sc += 4;                  // 优先 mp3
      if (/converted\/?$|vod\//i.test(s.folder)) sc -= 2;        // 转换出来的次优先
      if (s.lrcLocal) sc += 3;                                   // 歌词就在旁边
      if (s.vocals) sc += 1;                                     // 有配套人声版
      return sc;
    }
    var byName = {}, merged = [];
    out.forEach(function (s) {
      var k = s.artist + '|' + s.title;
      var g = byName[k];
      if (!g) { byName[k] = s; s.sources = [s.folder]; merged.push(s); return; }
      if (!g.vocals && s.vocals) g.vocals = s.vocals;
      if (!g.accomp && s.accomp) g.accomp = s.accomp;
      if (!g.lrc && s.lrc) { g.lrc = s.lrc; g.lrcLocal = s.lrcLocal; }
      /* 主音频：只要对方有音频就必须补上（否则"只有人声版"的那条会把整首歌的音频丢掉） */
      if (s.audio) {
        if (!g.audio) {
          g.audio = s.audio; g.audioExt = s.audioExt; g.folder = s.folder; g.ext = s.ext;
        } else if (audioScore(s) > audioScore(g)) {
          var keepLrc = g.lrc, keepLrcLocal = g.lrcLocal;
          g.audio = s.audio; g.audioExt = s.audioExt; g.folder = s.folder; g.ext = s.ext;
          g.lrc = keepLrc; g.lrcLocal = keepLrcLocal;
        }
      }
      if (s.folder && g.sources.indexOf(s.folder) < 0) g.sources.push(s.folder);
    });
    merged.sort(function (a, b) {
      var c = a.artist.localeCompare(b.artist, 'zh');
      return c !== 0 ? c : a.title.localeCompare(b.title, 'zh');
    });
    return { songs: merged, ncmCount: ncmCount, lrcCount: Object.keys(lrcMap).length, rawCount: out.length };
  }

  /** 搜索：空格分词，每个词都要命中（歌手或歌名，忽略大小写） */
  function filterCatalog(songs, query, artist, vocalsOnly) {
    var kws = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    return songs.filter(function (s) {
      if (artist && artist !== '__all__' && s.artist !== artist) return false;
      if (vocalsOnly && !s.vocals) return false;
      if (!kws.length) return true;
      var hay = (s.artist + ' ' + s.title + ' ' + s.titleRaw + ' ' + s.folder).toLowerCase();
      return kws.every(function (k) { return hay.indexOf(k) >= 0; });
    });
  }

  window.SongLibrary = { parseSongName: parseSongName, buildCatalog: buildCatalog, filterCatalog: filterCatalog, stripCopySuffix: stripCopySuffix };

  /* ---------- IndexedDB（存文件夹授权句柄） ---------- */
  function idb() {
    return new Promise(function (res, rej) {
      if (typeof indexedDB === 'undefined') return rej(new Error('no idb'));
      var r = indexedDB.open('vpm-karaoke', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function idbSet(k, v) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(v, k);
        tx.oncomplete = res; tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function idbGet(k) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var q = db.transaction('kv', 'readonly').objectStore('kv').get(k);
        q.onsuccess = function () { res(q.result); };
        q.onerror = function () { rej(q.error); };
      });
    });
  }

  /* ---------- 页面逻辑 ---------- */
  function $(id) { return document.getElementById(id); }
  function info(msg) { var el = $('libInfo'); if (el) el.innerHTML = msg; }
  function makeGetter(entry, file) {
    return function () { return file ? Promise.resolve(file) : entry.getFile(); };
  }

  var S = { songs: [], all: [], stats: null, dirName: '', mode: '', lastKey: null, restorable: null, vocalsOnly: false };

  function wire() {
    var pick = $('libPickDir'), files = $('libFiles'), rescan = $('libRescan'), search = $('libSearch'), artistSel = $('libArtist'), voc = $('libVocals'), vocOnly = $('libVocalsOnly'), list = $('libList');
    if (!pick || !list) return;

    pick.addEventListener('click', function () { pickDir(); });
    var pf = $('libPickFiles');
    if (pf) pf.addEventListener('click', function () { if (files) files.click(); });
    if (files) files.addEventListener('change', function () {
      var arr = Array.prototype.slice.call(this.files || []);
      if (!arr.length) return;
      var items = arr.map(function (f) { return { name: f.name, rel: f.webkitRelativePath || f.name, getFile: makeGetter(null, f) }; });
      S.mode = 'files';
      S.dirName = (arr[0].webkitRelativePath || '').split('/')[0] || '本地文件夹';
      apply(items);
    });
    if (rescan) rescan.addEventListener('click', function () { if (S.mode === 'dir') rescanDir(); });
    if (search) search.addEventListener('input', render);
    if (artistSel) artistSel.addEventListener('change', render);
    if (voc) voc.addEventListener('change', render);
    if (vocOnly) vocOnly.addEventListener('click', function () {
      S.vocalsOnly = !S.vocalsOnly;
      updateVocalsOnlyBtn();
      render();
    });
    list.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('.lib-item') : null;
      if (!el) return;
      var s = S.songs[+el.dataset.i];
      if (s) loadSong(s);
    });

    tryRestore();
  }

  function pickDir() {
    if (!window.showDirectoryPicker) { info('这个浏览器不支持文件夹授权（Chrome/Edge 支持），请用右边「兼容模式」选文件夹。'); return; }
    window.showDirectoryPicker({ id: 'vpm-music', mode: 'read' }).then(function (h) {
      return idbSet('musicDir', h).catch(function () {}).then(function () { return h; });
    }).then(function (h) {
      S.mode = 'dir'; S.dirName = h.name; S.handle = h; S.restorable = null;
      return scanAndApply(h);
    }).catch(function (e) { if (e && e.name !== 'AbortError') info('授权失败：' + (e.message || e)); });
  }

  function rescanDir() { if (S.handle) scanAndApply(S.handle); }

  function tryRestore() {
    if (typeof indexedDB === 'undefined' || !window.showDirectoryPicker) return;
    idbGet('musicDir').then(function (h) {
      if (!h) return;
      if (!h.queryPermission) return;
      return h.queryPermission({ mode: 'read' }).then(function (st) {
        if (st === 'granted') { S.mode = 'dir'; S.dirName = h.name; S.handle = h; scanAndApply(h); }
        else {
          S.restorable = h;
          info('上次的文件夹：<b>' + h.name + '</b> <button id="libRestore" class="btn btn-ghost btn-sm">继续使用（点一下授权）</button>');
          var b = $('libRestore');
          if (b) b.addEventListener('click', function () {
            h.requestPermission({ mode: 'read' }).then(function (st2) {
              if (st2 === 'granted') { S.mode = 'dir'; S.dirName = h.name; S.handle = h; scanAndApply(h); }
              else info('没拿到授权，请重新选择文件夹。');
            });
          });
        }
      });
    }).catch(function () {});
  }

  function scanAndApply(handle) {
    info('正在扫描 <b>' + handle.name + '</b> …（只读你的文件，不上传）');
    var items = [];
    walk(handle, '', items).then(function () {
      apply(items);
    }).catch(function (e) { info('扫描失败：' + (e && e.message ? e.message : e)); });
  }

  function walk(dir, rel, out) {
    var it = dir.entries(), chain = Promise.resolve();
    return new Promise(function (res, rej) {
      function step() {
        it.next().then(function (r) {
          if (r.done) return res();
          var name = r.value[0], entry = r.value[1];
          var p;
          if (entry.kind === 'file') {
            out.push({ name: name, rel: rel + name, getFile: makeGetter(entry, null) });
            p = Promise.resolve();
          } else {
            p = walk(entry, rel + name + '/', out);
          }
          p.then(step, rej);
        }, rej);
      }
      step();
    });
  }

  function apply(items) {
    var cat = buildCatalog(items);
    S.all = cat.songs;
    S.stats = cat;
    buildArtistSelect();
    updateVocalsOnlyBtn();
    render();
    var withLrc = S.all.filter(function (s) { return s.lrc; }).length;
    var withVoc = S.all.filter(function (s) { return s.vocals; }).length;
    info('📚 <b>' + S.dirName + '</b>：共 <b>' + S.all.length + '</b> 首 · 歌手 ' +
      new Set(S.all.map(function (s) { return s.artist; })).size + ' 位 · 带歌词 ' + withLrc + ' · 有人声分离版 ' + withVoc +
      (cat.ncmCount ? ' · <span style="color:var(--warn)">另有 ' + cat.ncmCount + ' 个 .ncm 未转换（用 tools/ncmdump.js）</span>' : ''));
    var r = $('libRescan'); if (r) r.disabled = (S.mode !== 'dir');
  }

  function buildArtistSelect() {
    var sel = $('libArtist');
    if (!sel) return;
    var counts = {};
    S.all.forEach(function (s) { counts[s.artist] = (counts[s.artist] || 0) + 1; });
    var artists = Object.keys(counts).sort(function (a, b) { return a.localeCompare(b, 'zh'); });
    sel.innerHTML = '<option value="__all__">全部歌手（' + S.all.length + '）</option>' +
      artists.map(function (a) { return '<option value="' + a.replace(/"/g, '&quot;') + '">' + a + '（' + counts[a] + '）</option>'; }).join('');
  }

  function updateVocalsOnlyBtn() {
    var b = $('libVocalsOnly');
    if (!b) return;
    var n = S.all.filter(function (s) { return !!s.vocals; }).length;
    b.classList.toggle('on', S.vocalsOnly);
    b.textContent = (S.vocalsOnly ? '🎙 只看人声分离版 ✓' : '🎙 只看人声分离版') + '（' + n + '）';
    b.title = n ? ('曲库里共 ' + n + ' 首有人声分离版') : '曲库里还没有人声分离版；用 tools/separate-vocals.ps1 生成后再扫描';
  }

  function render() {
    var list = $('libList');
    if (!list) return;
    if (!S.all.length) { list.innerHTML = '<p class="muted small">曲库是空的。点上面的「选择音乐文件夹」授权一次，我就能把歌单列出来。</p>'; return; }
    var q = ($('libSearch') && $('libSearch').value) || '';
    var ar = ($('libArtist') && $('libArtist').value) || '__all__';
    var res = filterCatalog(S.all, q, ar, S.vocalsOnly);
    S.songs = res;
    var useVoc = $('libVocals') && $('libVocals').checked;
    var MAX = 800;
    var html = res.slice(0, MAX).map(function (s, i) {
      var tags = [];
      if (s.vocals) tags.push('<span class="tag tag-v">人声版</span>');
      if (s.lrc) tags.push('<span class="tag tag-l">歌词</span>');
      if (s.folder) tags.push('<span class="tag tag-d">' + s.folder + '</span>');
      var primary = (useVoc && s.vocals) ? ' （将使用人声分离版）' : '';
      return '<div class="lib-item' + (s.key === S.lastKey ? ' on' : '') + '" data-i="' + i + '" title="' + (s.folder ? s.folder + '/' : '') + s.titleRaw + '">' +
        '<span class="lib-title">' + s.title + '</span>' +
        '<span class="lib-artist">' + s.artist + '</span>' +
        '<span class="lib-tags">' + tags.join('') + '</span>' +
        '<span class="lib-go">▶' + primary + '</span></div>';
    }).join('');
    var head = '找到 <b>' + res.length + '</b> 首' + (S.vocalsOnly ? ' <span class="tag tag-v">只看人声分离版</span>' : '');
    var empty = res.length ? '' : '<p class="muted small">' + (S.vocalsOnly ? '没有匹配的「人声分离版」歌曲；试试把歌手切回「全部歌手」或清空搜索。' : '没有匹配的歌曲，换个关键词或歌手试试。') + '</p>';
    list.innerHTML = '<div class="lib-head">' + head + '</div>' + empty + html +
      (res.length > MAX ? '<div class="muted small">（只显示前 ' + MAX + ' 首，请用搜索缩小范围）</div>' : '');
  }

  function loadSong(s) {
    var K = window.KaraokeAPI;
    if (!K) { info('播放器还没准备好，请按 Ctrl+F5 强制刷新一次。'); return; }
    var preferVocals = $('libVocals') && $('libVocals').checked;
    var playItem = s.audio || s.vocals;                       // 播放：完整版（带伴奏）
    var refItem = (preferVocals && s.vocals) ? s.vocals : null; // 参考线：人声分离版
    if (!playItem) { info('这首歌没有可播放的音频（可能只有 .ncm，需要先转换）。'); return; }
    info('正在载入：<b>' + s.artist + ' - ' + s.title + '</b>'
      + (refItem ? '（播放完整伴奏版 · 参考线用人声版）' : '') + ' …');
    Promise.all([
      playItem.getFile(),
      s.lrc ? s.lrc.getFile().catch(function () { return null; }) : Promise.resolve(null),
      refItem ? refItem.getFile().catch(function () { return null; }) : Promise.resolve(null)
    ]).then(function (r) {
      S.lastKey = s.key;
      render();
      K.load(r[0], r[1], r[2]);
      var sr = document.getElementById('syncRecBtn');
      if (sr) sr.disabled = false;
      info('✅ 已载入 <b>' + s.artist + ' - ' + s.title + '</b>'
        + (r[2] ? '：播放的是<b>完整伴奏版</b>，参考线来自<b>人声分离版</b>（线更干净）。' : '：参考线直接从这首歌里估。')
        + '<br>准备好就点 <b>「🎤 开始唱歌」</b> —— <b>随时可以停</b>，按你唱到的部分算分。');
    }).catch(function (e) {
      info('读文件失败：' + (e && e.message ? e.message : e) + '（可能是授权失效，重新选一次文件夹）');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();