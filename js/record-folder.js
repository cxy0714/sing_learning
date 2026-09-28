/* ============================================================
 * record-folder.js —— 统一的「记录文件夹」
 *
 *   · 音准页的每日音域记录 + K歌页的练习记录，统一写进同一个文件夹。
 *   · 只授权一次：文件夹句柄存进 IndexedDB（与 record.js 共用同一个 key）。
 *   · 两个页面只要都引入本文件，就能看到同一个「记录文件夹」。
 *   · 数据只在本地读写，不上传；不支持 File System Access API 时由页面降级导出。
 * ============================================================ */
(function (global) {
  'use strict';

  var DB = 'vpm-kara-rec';   // 与 record.js 共用一个 IndexedDB
  var STORE = 'kv';
  var KEY = 'recDir';

  var handle = null;
  var listeners = [];

  function supported() {
    return typeof indexedDB !== 'undefined' && !!global.showDirectoryPicker;
  }

  function db() {
    return new Promise(function (res, rej) {
      if (typeof indexedDB === 'undefined') return rej(new Error('这个浏览器不支持 IndexedDB'));
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' });
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }

  function kvGet(k) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var q = d.transaction(STORE, 'readonly').objectStore(STORE).get(k);
        q.onsuccess = function () { res(q.result); };
        q.onerror = function () { rej(q.error); };
      });
    });
  }

  function kvPut(k, v) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(STORE, 'readwrite');
        t.objectStore(STORE).put(v, k);
        t.oncomplete = function () { res(v); };
        t.onerror = function () { rej(t.error); };
      });
    });
  }

  function notify() {
    listeners.forEach(function (fn) {
      try { fn(handle); } catch (e) {}
    });
  }

  function get() { return handle; }

  function name() { return handle ? handle.name : ''; }

  function load() {
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('这个浏览器不支持 IndexedDB'));
    return kvGet(KEY).then(function (h) {
      if (h) handle = h;
      notify();
      return handle;
    });
  }

  function pick() {
    if (!global.showDirectoryPicker) {
      return Promise.reject(new Error('这个浏览器不支持直接写文件夹，请用 Chrome / Edge。'));
    }
    return global.showDirectoryPicker({ id: 'vpm-rec', mode: 'readwrite' }).then(function (h) {
      handle = h;
      return kvPut(KEY, h).catch(function () {}).then(function () {
        notify();
        return h;
      });
    });
  }

  function hasPermission() {
    if (!handle) return Promise.resolve(false);
    if (!handle.queryPermission) return Promise.resolve(true);
    return handle.queryPermission({ mode: 'readwrite' }).then(function (st) {
      if (st === 'granted') return true;
      return handle.requestPermission({ mode: 'readwrite' }).then(function (st2) {
        return st2 === 'granted';
      });
    }).catch(function () { return false; });
  }

  function ensure() {
    if (!supported()) return Promise.reject(new Error('这个浏览器不支持直接写文件夹，请用 Chrome / Edge。'));
    var ready = handle ? Promise.resolve(handle) : load();
    return ready.then(function (h) {
      if (!h) {
        var e1 = new Error('还没有选择记录文件夹');
        e1.code = 'NO_FOLDER';
        throw e1;
      }
      return hasPermission().then(function (ok) {
        if (ok) return h;
        var e2 = new Error('没有拿到记录文件夹的读写权限，请重新选择一次。');
        e2.code = 'NO_PERM';
        throw e2;
      });
    });
  }

  function writeOne(dir, name, data) {
    return dir.getFileHandle(name, { create: true })
      .then(function (fh) { return fh.createWritable(); })
      .then(function (w) {
        return w.write(data).then(function () { return w.close(); });
      });
  }

  function writeFile(name, data) {
    return ensure().then(function (dir) { return writeOne(dir, name, data); });
  }

  function writeFiles(files) {
    return ensure().then(function (dir) {
      var chain = Promise.resolve();
      (files || []).forEach(function (f) {
        chain = chain.then(function () { return writeOne(dir, f.name, f.data); });
      });
      return chain;
    });
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return;
    listeners.push(fn);
    if (handle) fn(handle);
  }

  global.RecordFolder = {
    supported: supported,
    load: load,
    pick: pick,
    get: get,
    name: name,
    hasPermission: hasPermission,
    ensure: ensure,
    writeFile: writeFile,
    writeFiles: writeFiles,
    onChange: onChange
  };
})(window);
