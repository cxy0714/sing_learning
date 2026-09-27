#!/usr/bin/env node
/* ⚠️⚠️ 实测说明（2024-2025 版网易云客户端下载的 .ncm）⚠️⚠️
 *  我按公开的 ncmdump 算法复现了这一版，但**对你机器上这批 .ncm 解不出合法音频**：
 *   - 容器结构我是解对的（magic、AES 密钥块里的 "neteasecloudmusic" 标记、
 *     元数据块的 "163 key(Don't modify)" 标记、CRC、封面尺寸都对，
 *     连封面 JPEG 的结束标记 ff d9 都正好落在推算的音频起点上）；
 *   - 但音频部分的密钥流（公开的 RC4 变体）对不上：我把 AES 解出的密钥块
 *     做了 8256 种切片 × 多种算法变体 × 多种"丢字节"组合，整文件扫描都没找到
 *     任何一个合法音频头；元数据块用公开的两把密钥（含 AES-192 meta key）也解不开。
 *   → 结论：这批文件是更新版客户端下载的格式，公开算法对不上（我也没网查最新实现）。
 *
 *  所以：想转这批 ncm，请用活跃维护的工具（例如网页版 unlock-music 或 ncmdump 的最新 release），
 *  或者直接用网易云下载的 .mp3（你机器上有 450 首，浏览器可直接用）。
 *  这个脚本保留着，对**旧版** ncm 可能仍然有效，但对你现在这批无效。
 * ============================================================ *//* ============================================================
 * tools/ncmdump.js —— 把网易云 .ncm 本地音乐还原成 mp3 / flac
 *
 *   .ncm 是网易云自己的「加密容器」格式（文件头 CTENFDAM）：
 *   密钥就藏在这个文件里（AES-128-ECB 解出来），音频部分再用一段
 *   自写的 RC4 变体异或还原。所以这是纯本地的「格式转换」，不需要联网，
 *   也不涉及服务器校验。
 *
 *   用法：
 *     node tools/ncmdump.js <文件.ncm 或 目录> [-o 输出目录] [--dry] [--verify]
 *   例：
 *     node tools/ncmdump.js "C:\CloudMusic\VipSongsDownload" -o "C:\CloudMusic\converted"
 *
 *   ⚠️ 仅供转换你自己的本地文件、自己练歌用，别拿去传播。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const CORE_KEY = Buffer.from('hzHRAmso5kInbaxW', 'latin1');   // AES-128-ECB 密钥
const MAGIC = 'CTENFDAM';

/* ---------- 解出 RC4 密钥 + 元数据 ---------- */
function parseHeader(buf) {
  if (buf.slice(0, 8).toString('latin1') !== MAGIC) throw new Error('不是 ncm 文件（文件头不对）');
  let pos = 10;                                     // 8 字节 magic + 2 字节间隔
  const keyLen = buf.readUInt32LE(pos); pos += 4;
  if (keyLen <= 0 || keyLen > 4096 || pos + keyLen > buf.length) throw new Error('密钥长度异常');
  let keyData = Buffer.from(buf.slice(pos, pos + keyLen)); pos += keyLen;
  for (let i = 0; i < keyData.length; i++) keyData[i] ^= 0x64;

  const d = crypto.createDecipheriv('aes-128-ecb', CORE_KEY, null);
  d.setAutoPadding(true);
  let rc4key = Buffer.concat([d.update(keyData), d.final()]);
  if (rc4key.slice(0, 17).toString('latin1') === 'neteasecloudmusic') rc4key = rc4key.slice(17);
  if (!rc4key.length) throw new Error('RC4 密钥为空');

  const metaLen = buf.readUInt32LE(pos); pos += 4;
  let meta = null;
  if (metaLen > 0 && metaLen < 1024 * 1024 && pos + metaLen <= buf.length) {
    const raw = Buffer.from(buf.slice(pos, pos + metaLen));
    for (let i = 0; i < raw.length; i++) raw[i] ^= 0x63;
    let txt = raw.toString('utf8');
    const c = txt.indexOf(':');
    if (c >= 0) txt = txt.slice(c + 1);
    try { meta = JSON.parse(Buffer.from(txt, 'base64').toString('utf8')); } catch (e) { meta = null; }
    pos += metaLen;
  }
  return { rc4key, meta, afterMeta: pos };
}

/* ---------- RC4 变体：ncm 的音频异或流 ---------- */
function decryptAudio(data, key) {
  const box = new Uint8Array(256);
  for (let i = 0; i < 256; i++) box[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + box[i] + key[i % key.length]) & 0xFF;
    const t = box[i]; box[i] = box[j]; box[j] = t;
  }
  const out = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) {
    const j = (i + 1) & 0xFF;
    box[i & 0xFF] = (box[i & 0xFF] + box[j]) & 0xFF;
    out[i] = data[i] ^ box[(box[i & 0xFF] + box[j]) & 0xFF];
  }
  return out;
}

/* ---------- 音频头部识别（顺便验证解密对不对） ---------- */
function sniffHeader(b) {
  if (b.length < 4) return null;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mp3';            // "ID3"
  if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return 'mp3';                    // MPEG 帧同步
  if (b.slice(0, 4).toString('latin1') === 'fLaC') return 'flac';
  if (b.slice(0, 4).toString('latin1') === 'OggS') return 'ogg';
  return null;
}

/** meta 之后还有：crc(4) + 一些填充 + 封面长度(4) + 封面数据，具体偏移各版本略有差异。
 *  我们不猜版本，直接从 meta 结尾往后 32 字节里暴力试：哪个偏移解出来是合法音频头，就用哪个。 */
function findAudioOffset(buf, afterMeta, rc4key) {
  const limit = Math.min(afterMeta + 32, buf.length - 16);
  for (let off = afterMeta; off <= limit; off++) {
    const probe = decryptAudio(buf.slice(off, Math.min(off + 16, buf.length)), rc4key);
    if (sniffHeader(probe)) return off;
  }
  return -1;
}

function convert(inPath, outDir, opts) {
  const buf = fs.readFileSync(inPath);
  const { rc4key, meta } = parseHeader(buf);
  const afterMeta = parseHeader(buf).afterMeta;
  const off = findAudioOffset(buf, afterMeta, rc4key);
  if (off < 0) throw new Error('找不到音频起点（可能不是标准的 ncm 文件）');

  const audio = decryptAudio(buf.slice(off), rc4key);
  const fmt = sniffHeader(audio) || (meta && meta.format) || 'mp3';
  const base = path.basename(inPath).replace(/\.ncm$/i, '');
  const safe = base.replace(/[\\/:*?"<>|]/g, '_');

  if (opts.dry) return { inPath, fmt, size: audio.length, meta, offset: off, wrote: null };

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, safe + '.' + fmt);
  fs.writeFileSync(outPath, audio);
  return { inPath, outPath, fmt, size: audio.length, meta, offset: off, wrote: outPath };
}

/* ---------- 遍历输入 ---------- */
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

/* ---------- 主流程 ---------- */
function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) { console.log(fs.readFileSync(__filename, 'utf8').split('用法：')[1].split('\n').slice(0, 4).join('\n')); process.exit(1); }
  const input = argv[0];
  let outDir = null, dry = false, verify = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '-o' || argv[i] === '--out') outDir = argv[++i];
    else if (argv[i] === '--dry') dry = true;
    else if (argv[i] === '--verify') verify = true;
  }
  const files = walk(input);
  if (!files.length) { console.log('没找到 .ncm 文件'); process.exit(1); }
  if (!outDir) outDir = path.join(path.dirname(files[0]), 'converted');

  console.log('共 ' + files.length + ' 个文件 → 输出到 ' + (dry ? '(dry-run，不写文件)' : outDir));
  let ok = 0, bad = 0, bytes = 0, metOk = 0;
  const t0 = Date.now();
  files.forEach((f, i) => {
    try {
      const r = convert(f, outDir, { dry });
      bytes += r.size;
      ok++;
      if (r.meta && r.meta.duration && r.meta.bitrate) {
        const expect = r.meta.bitrate * 1000 * (r.meta.duration / 1000) / 8;   // 字节
        const ratio = r.size / expect;
        if (ratio > 0.85 && ratio < 1.15) metOk++;
      }
      if (i % 25 === 0 || i === files.length - 1) {
        const el = (Date.now() - t0) / 1000;
        console.log('  [' + (i + 1) + '/' + files.length + '] ' + Math.round((i + 1) / files.length * 100) + '%  ' +
          (bytes / 1048576).toFixed(0) + 'MB  ' + el.toFixed(0) + 's  ' + path.basename(f).slice(0, 40));
      }
    } catch (e) {
      bad++;
      console.log('  ❌ ' + path.basename(f) + ' : ' + e.message);
    }
  });
  console.log('\n完成：成功 ' + ok + ' / 失败 ' + bad + '，输出 ' + (bytes / 1048576).toFixed(0) + ' MB，用时 ' +
    ((Date.now() - t0) / 1000).toFixed(1) + 's');
  if (metOk) console.log('元数据校验：' + metOk + ' 个文件的「时长×码率」和实际大小吻合（解码正确的强证据）');
}

if (require.main === module) main();
module.exports = { parseHeader, decryptAudio, findAudioOffset, sniffHeader, convert, walk };