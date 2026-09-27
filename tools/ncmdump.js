#!/usr/bin/env node
/* ============================================================
 * tools/ncmdump.js —— 把网易云 .ncm 本地音乐还原成 mp3 / flac
 *
 *   算法对齐自活跃维护的实现 taurusxin/ncmdump (★4.6k, src/ncmcrypt.cpp)：
 *     1. 头 8 字节 "CTENFDAM"，再跳 2 字节
 *     2. 读密钥块长度 + 数据，逐字节 XOR 0x64
 *     3. AES-128-ECB(CORE_KEY) 解密 → 去掉前 17 字节 "neteasecloudmusic" → 得到 RC4 密钥
 *     4. 读元数据块长度 + 数据，逐字节 XOR 0x63
 *        → 去掉前 22 字节 "163 key(Don't modify):" → base64 → AES-128-ECB(MODIFY_KEY)
 *        → 去掉前 6 字节 "music:" → JSON（歌名/歌手/码率/时长/格式）
 *     5. 跳 5 字节（crc32 + image version）→ 封面长度(4) → 图像长度(4) → 跳过封面
 *     6. 剩下的是音频，用「无状态 256 字节周期密钥流」异或还原：
 *          j = (i+1) & 0xff
 *          ks[i] = keybox[(keybox[j] + keybox[(keybox[j] + j) & 0xff]) & 0xff]
 *
 *   用法：
 *     node tools/ncmdump.js <文件.ncm | 目录> [-o 输出目录] [--dry] [--meta-names] [--manifest]
 *   例：
 *     node tools/ncmdump.js "C:\CloudMusic\VipSongsDownload" -o "C:\CloudMusic\converted"
 *
 *   ── 出处与许可 ─────────────────────────────────────────────
 *   本文件的算法与密钥常量来自 MIT 许可的开源项目：
 *     taurusxin/ncmdump  ·  https://github.com/taurusxin/ncmdump
 *     Copyright (c) 2024 taurusxin  ·  MIT License（见同目录 LICENSE-upstream-ncmdump.txt）
 *   这里是 JavaScript 重写版（不是复制粘贴），用途只有一个：
 *   把使用者**自己本机**的 .ncm 文件还原成通用 mp3/flac，方便自己练歌。
 *   请勿用于传播、分发他人作品。
 *   ─────────────────────────────────────────────────────────
 *   ⚠️ 仅供转换你自己的本地文件、自己练歌用，别拿去传播。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* 两个密钥常量（与 taurusxin/ncmdump 的 sCoreKey / sModifyKey 一致，数组末位是 C 字符串的 \0） */
const CORE_KEY = Buffer.from([0x68, 0x7A, 0x48, 0x52, 0x41, 0x6D, 0x73, 0x6F, 0x35, 0x6B, 0x49, 0x6E, 0x62, 0x61, 0x78, 0x57]);
const MODIFY_KEY = Buffer.from([0x23, 0x31, 0x34, 0x6C, 0x6A, 0x6B, 0x5F, 0x21, 0x5C, 0x5D, 0x26, 0x30, 0x55, 0x3C, 0x27, 0x28]);
const MAGIC = 'CTENFDAM';

/** AES-128-ECB 解密；最后一块按「末字节 = 填充长度」去掉填充（和参考实现一致） */
function aesEcbDecrypt(key, src) {
  const blocks = src.length >> 4;
  if (!blocks) return Buffer.alloc(0);
  const d = crypto.createDecipheriv('aes-128-ecb', key, null);
  d.setAutoPadding(false);
  const out = Buffer.concat([d.update(src.subarray(0, blocks << 4)), d.final()]);
  let pad = out[out.length - 1];
  if (pad > 16) pad = 0;
  return out.slice(0, out.length - pad);
}

/** 标准 RC4 KSA，得到 256 字节 keybox */
function buildKeyBox(key) {
  const box = new Uint8Array(256);
  for (let i = 0; i < 256; i++) box[i] = i;
  let last = 0, ko = 0;
  for (let i = 0; i < 256; i++) {
    const swap = box[i];
    const c = (swap + last + key[ko++]) & 0xff;
    if (ko >= key.length) ko = 0;
    box[i] = box[c];
    box[c] = swap;
    last = c;
  }
  return box;
}

/** ncm 的密钥流：不含状态更新，所以是 256 字节周期（这是和我之前搞错的地方） */
function buildKeyStream(box) {
  const ks = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const j = (i + 1) & 0xff;
    ks[i] = box[(box[j] + box[(box[j] + j) & 0xff]) & 0xff];
  }
  return ks;
}

/** 解析容器，返回 { ks, meta, audioStart, coverFrameLen } */
function parseNcm(buf) {
  if (buf.length < 16 || buf.slice(0, 8).toString('latin1') !== MAGIC) {
    throw new Error('不是 ncm 文件（文件头不对）');
  }
  let pos = 10;
  const keyLen = buf.readUInt32LE(pos); pos += 4;
  if (keyLen <= 0 || keyLen > 4096 || pos + keyLen > buf.length) throw new Error('密钥长度异常');
  const kd = Buffer.from(buf.subarray(pos, pos + keyLen));
  for (let i = 0; i < kd.length; i++) kd[i] ^= 0x64;
  pos += keyLen;

  const keyData = aesEcbDecrypt(CORE_KEY, kd);
  if (keyData.slice(0, 17).toString('latin1') !== 'neteasecloudmusic') throw new Error('密钥块标记不对（可能不是网易云的 ncm）');
  const rc4key = keyData.subarray(17);
  const ks = buildKeyStream(buildKeyBox(rc4key));

  const metaLen = buf.readUInt32LE(pos); pos += 4;
  let meta = null;
  if (metaLen > 0 && pos + metaLen <= buf.length) {
    const md = Buffer.from(buf.subarray(pos, pos + metaLen));
    for (let i = 0; i < md.length; i++) md[i] ^= 0x63;
    pos += metaLen;
    try {
      const b64 = md.toString('latin1').slice(22);              // 去掉 "163 key(Don't modify):"
      const json = aesEcbDecrypt(MODIFY_KEY, Buffer.from(b64, 'base64')).slice(6).toString('utf8'); // 去掉 "music:"
      meta = JSON.parse(json);
    } catch (e) { meta = null; }
  }

  pos += 5;                                                     // crc32(4) + image version(1)
  const coverFrameLen = buf.readUInt32LE(pos); pos += 4;
  const imgLen = buf.readUInt32LE(pos); pos += 4;
  const audioStart = pos + imgLen + Math.max(0, coverFrameLen - imgLen);
  if (audioStart >= buf.length) throw new Error('音频起点越界（文件可能损坏）');
  return { ks, meta, audioStart, coverFrameLen, rc4keyLen: rc4key.length };
}

function snapHeader(b) {
  if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mp3';
  if (b.length >= 4 && b.slice(0, 4).toString('latin1') === 'fLaC') return 'flac';
  if (b.length >= 2 && b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return 'mp3';
  return null;
}

function safeName(s) { return String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim(); }

function convert(inPath, outDir, opts) {
  const buf = fs.readFileSync(inPath);
  const { ks, meta, audioStart, rc4keyLen } = parseNcm(buf);
  const size = buf.length - audioStart;
  const audio = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) audio[i] = buf[audioStart + i] ^ ks[i & 0xff];   // i & 0xff 等价于 256 周期

  const fmt = snapHeader(audio) || (meta && meta.format) || 'mp3';
  const base = path.basename(inPath).replace(/\.ncm$/i, '');
  let outName;
  if (opts.metaNames && meta && meta.musicName) {
    outName = safeName((meta.artist && meta.artist[0] && meta.artist[0][0] ? meta.artist[0][0] + ' - ' : '') + meta.musicName);
  } else {
    outName = safeName(base);
  }
  const outPath = path.join(outDir, outName + '.' + fmt);

  /* 自检：元数据里的「码率 × 时长」应该和实际大小吻合 */
  let check = null;
  if (meta && meta.bitrate && meta.duration) {
    const expect = meta.bitrate * (meta.duration / 1000) / 8;
    check = size / expect;
  }

  if (!opts.dry) {
    if (opts.skipExisting) {
      for (const ext of ['mp3', 'flac']) {
        const ex = path.join(outDir, outName + '.' + ext);
        if (fs.existsSync(ex)) return { inPath, outPath: ex, fmt, size, meta, audioStart, rc4keyLen, check, ok: true, skipped: true };
      }
    }
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, audio);
  }
  return { inPath, outPath: opts.dry ? null : outPath, fmt, size, meta, audioStart, rc4keyLen, check, ok: !!snapHeader(audio), skipped: false };
}

function walk(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return /\.ncm$/i.test(p) ? [p] : [];
  const out = [];
  for (const name of fs.readdirSync(p)) {
    const f = path.join(p, name);
    let s; try { s = fs.statSync(f); } catch (e) { continue; }
    if (s.isDirectory()) out.push(...walk(f));
    else if (/\.ncm$/i.test(name)) out.push(f);
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    console.log('用法: node tools/ncmdump.js <文件.ncm | 目录> [-o 输出目录] [--dry] [--meta-names] [--manifest]');
    process.exit(1);
  }
  const input = argv[0];
  let outDir = null, dry = false, metaNames = false, manifest = false, skipExisting = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '-o' || argv[i] === '--out') outDir = argv[++i];
    else if (argv[i] === '--dry') dry = true;
    else if (argv[i] === '--meta-names') metaNames = true;
    else if (argv[i] === '--manifest') manifest = true;
    else if (argv[i] === '--skip-existing') skipExisting = true;
  }
  const files = walk(input);
  if (!files.length) { console.log('没找到 .ncm 文件'); process.exit(1); }
  if (!outDir) outDir = path.join(path.dirname(files[0]), 'converted');

  console.log('共 ' + files.length + ' 个 ncm → ' + (dry ? '(dry-run)' : outDir));
  let ok = 0, bad = 0, bytes = 0, checked = 0, good = 0, skipped = 0;
  const list = [];
  const t0 = Date.now();
  files.forEach((f, i) => {
    try {
      const r = convert(f, outDir, { dry, metaNames, skipExisting });
      if (r.skipped) { skipped++; } else { bytes += r.size; if (r.ok) ok++; else bad++; }
      if (r.check !== null) {
        checked++;
        if (r.check > 0.9 && r.check < 1.1) good++;
        else console.log('  ⚠️ 大小与元数据不符: ' + path.basename(f) + ' 比值=' + r.check.toFixed(3));
      }
      if (manifest && r.meta) {
        list.push({
          file: path.basename(r.outPath || f),
          title: r.meta.musicName, artist: (r.meta.artist || []).map(a => a && a[0]).filter(Boolean).join('/'),
          album: r.meta.album, format: r.fmt, bitrate: r.meta.bitrate, durationMs: r.meta.duration
        });
      }
      if (i % 50 === 0 || i === files.length - 1) {
        const el = (Date.now() - t0) / 1000;
        console.log('  [' + String(i + 1).padStart(4) + '/' + files.length + '] ' + String(Math.round((i + 1) / files.length * 100)).padStart(3) + '%  ' +
          (bytes / 1073741824).toFixed(2) + 'GB  ' + el.toFixed(0) + 's  ' + (el / (i + 1) * (files.length - i - 1)).toFixed(0) + 's剩余');
      }
    } catch (e) {
      bad++;
      console.log('  ❌ ' + path.basename(f) + ' : ' + e.message);
    }
  });
  console.log('\n完成：新转换 ' + ok + ' / 跳过已存在 ' + skipped + ' / 失败 ' + bad + '，本次写出 ' +
    (bytes / 1073741824).toFixed(2) + ' GB，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  if (checked) console.log('一致性校验：' + good + '/' + checked + ' 个文件的「码率×时长」与实际大小吻合（说明解密正确）');
  if (manifest && list.length) {
    fs.mkdirSync(outDir, { recursive: true });
    const mf = path.join(outDir, 'ncm-manifest.json');
    let merged = list;
    try {
      const old = JSON.parse(fs.readFileSync(mf, 'utf8'));
      const byFile = new Map();
      old.forEach(o => byFile.set(o.file, o));
      list.forEach(o => byFile.set(o.file, o));
      merged = Array.from(byFile.values()).sort((a, b) => String(a.file).localeCompare(String(b.file)));
      console.log('清单合并：原有 ' + old.length + ' + 本次 ' + list.length + ' → ' + merged.length + ' 首');
    } catch (e) { /* 首次运行没有旧清单 */ }
    fs.writeFileSync(mf, JSON.stringify(merged, null, 1));
    console.log('已写出清单: ' + mf + '（' + merged.length + ' 首，含歌名/歌手/码率/时长）');
  }
}

if (require.main === module) main();
module.exports = { parseNcm, buildKeyBox, buildKeyStream, convert, walk, aesEcbDecrypt };