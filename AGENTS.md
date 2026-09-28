# AGENTS.md

> 给后续 AI Agent / 开发者的项目速读，2026-09-28 扫描当前工作区生成。
> 项目目录：`C:\Users\thinkbook-cxy\Documents\sing_learning`
> 项目定位：纯前端的「唱歌音准实时监测 + K 歌练习」静态网页。

## 0. 一句话

这是一个**无后端、无构建、无第三方依赖**的静态网页工具：

- `index.html`：实时音准检测、音域记录、标准频率表、单音跟唱、音高轨迹、录音统计与导出。
- `karaoke.html`：选本地歌曲 → 提取参考音高线 → 跟唱打分 → 导出 JSON / CSV → 练习记录。

麦克风数据、本地音频、录音、音高轨迹**只在浏览器本机处理**，不上传、不进仓库。
这是硬约束：不要引入后端、统计脚本、第三方 CDN 或任何会外发用户数据的逻辑。

## 1. 快速命令

```powershell
# 本地预览（推荐 localhost，浏览器才给麦克风权限）
node serve.js
# 自定义端口
$env:PORT=8080; node serve.js

# 离线回归测试（不需要浏览器、不需要麦克风）
node test/selftest.js

# 评估「从音频提取音高线」的质量；非 wav 需要 ffmpeg
node test/analyze-audio.js "C:\Music\song.mp3"
node test/analyze-audio.js "C:\Music\song.wav" --raw   # 对照组：不滤波/不限人声范围

# 网易云 .ncm -> mp3/flac
node tools/ncmdump.js "C:\CloudMusic\VipSongsDownload" -o "C:\CloudMusic\converted" --manifest

# Demucs 人声分离：得到 xxx.vocals.mp3 / xxx.no_vocals.mp3
powershell -ExecutionPolicy Bypass -File tools\separate-vocals.ps1 -Path "C:\Music\周华健 - 难念的经.mp3"
powershell -ExecutionPolicy Bypass -File tools\separate-vocals.ps1 -Path "C:\Music" -Out "C:\Music\vocals"
powershell -ExecutionPolicy Bypass -File tools\separate-vocals.ps1 -Path "C:\Music" -Out "C:\Music\vocals" -SkipExisting

# 备选本地服务器
python -m http.server 8000
```

Demucs 脚本默认使用 `%USERPROFILE%\.demucs-env`，首次准备：

```powershell
python -m venv "$env:USERPROFILE\.demucs-env"
& "$env:USERPROFILE\.demucs-env\Scripts\python.exe" -m pip install demucs numpy
```

## 2. 目录结构

```text
.
├─ index.html                 音准检测主页面
├─ karaoke.html               K 歌练习页面
├─ style.css                  两个页面共用样式
├─ karaoke.css                K 歌页专用样式
├─ serve.js                   Node 静态预览服务器（仅用 Node 内置模块）
├─ js/
│  ├─ pitch.js                YIN 音高检测 + 音名/唱名/MIDI 换算，无 DOM 依赖
│  ├─ app.js                  音准页逻辑：实时曲线、音域、录音统计、导出、单音测试
│  ├─ library.js              本地曲库：文件夹授权、扫描、搜索、同名/人声版合并
│  ├─ karaoke.js              K 歌页逻辑：音频解码、参考线提取、跟唱打分、歌词同步
│  ├─ record-folder.js        统一记录文件夹：音域记录 + K 歌记录共用一个授权文件夹
│  └─ record.js               练习记录：MediaRecorder + IndexedDB + 保存到文件夹
├─ test/
│  ├─ selftest.js             离线回归测试（Node vm + 假 DOM）
│  └─ analyze-audio.js        音频提取质量评估脚本
├─ tools/
│  ├─ ncmdump.js              .ncm -> mp3/flac，JS 重写自 MIT 项目 taurusxin/ncmdump
│  ├─ separate-vocals.ps1     Demucs 人声分离
│  └─ LICENSE-upstream-ncmdump.txt
├─ .github/workflows/pages.yml GitHub Pages 部署
└─ README.md                  面向使用者的详细说明
```

没有被部署的目录：`test/`、`tools/`、`README.md` 不会进入 Pages 站点。

## 3. 核心架构与数据流

### 3.1 `js/pitch.js` —— 共用音高算法

- 以 IIFE 方式挂到 `window.PitchTool`，不依赖 DOM。
- 对外 API：
  - `detectPitch(buf, sampleRate, { minFreq, maxFreq, threshold })`
  - `freqToMidi` / `midiToFreq` / `describeMidi`
  - `midiFromName` / `midiToName`
  - `scaleNotes` / `chromaticNotes`
- 默认检测范围约 `C2(65Hz) ~ E6(1300Hz)`；YIN 使用自相关、累积均值归一化和抛物线插值。
- 页面/模块间的基础换算必须复用这里，不要在别处重新实现一份。

### 3.2 `js/app.js` —— 音准页

- 全局状态集中在 `S`。
- 麦克风链路：
  `getUserMedia` → `AudioContext` + `AnalyserNode` → `requestAnimationFrame` 循环
  → 约 16fps 调用 `detectPitch` → 最近 400ms 音高历史做「中位数 + 邻近平均」
  → `updateReadout` / 曲线绘制 / 录音统计。
- 实时曲线约 30fps，绿色带为 ±25 音分；录音只记录音高点和统计，不保存原始声音。
- 每日音域记录：
  - 存储 key：`vpm.range.v1`
  - 原本要求连续同一音若干帧才记录；当前工作区正在改为更严格的「稳定唱住」过滤。
  - 可同步到「我的音域」，并导出 JSON / CSV。
- 设置：`vpm.settings.v1`
- 练习音高记录：`vpm.sessions.v1`
- 导出 JSON 的结构大致包含：`app`、`a4`、`durationMs`、`summary`、`perNote`、`points`。

### 3.3 `js/karaoke.js` —— K 歌提取与打分

- 参考线提取：
  解码音频 → 混单声道 → 可选 `120Hz~1200Hz` 带通 → 降采样到约 11kHz
  → 1024 点窗口 / 512 hop（约 46ms 一帧）跑 YIN
  → 自适应人声门限 → 简化 Viterbi 串成连续旋律线 → 切成片段。
- 若曲库提供 `.vocals.mp3`，优先用分离后人声提取参考线；播放仍用完整版。
- 跟唱：
  播放参考音频，同时用 `audio.currentTime` 校准时间轴；麦克风采样点按时间落在目标片段内，
  每个片段取中位数音高，计算音分误差和逐音得分。
- 评分规则：
  `单音得分 = 100 - |偏差音分| × 1.2`，最终对真正唱到的片段求平均；漏唱不额外扣分但显示覆盖率。
- 八度自动对齐：偏差先折叠到 ±600 音分，避免男女声差八度被当跑调。
- 对曲库暴露：`window.KaraokeAPI`。
- 设置与最近练习：`vpm.karaoke.v1`。

### 3.4 `js/library.js` —— 本地曲库

- 使用 File System Access API 授权文件夹，句柄存 IndexedDB `vpm-karaoke`；
  其他浏览器可退回 `webkitdirectory`。
- 扫描后按文件名整理：
  - `歌手 - 歌名.ext`
  - 同名 `.vocals` / `.no_vocals` 自动合并成一个条目
  - 自动配对同名 `.lrc`
  - 统计未转换的 `.ncm`
- 支持按歌手 / 歌名搜索；点击条目会调用 `KaraokeAPI.load`。
- 「只看有人声分离版」按钮切换 `S.vocalsOnly`，过滤出带 `s.vocals` 的歌曲；按钮上显示曲库里共有多少首。
- 对测试暴露：`window.SongLibrary`。

### 3.5 `js/record-folder.js` —— 统一记录文件夹

- 用 File System Access API 让用户只授权一次文件夹，句柄存在 IndexedDB `vpm-kara-rec` 的 `kv` store，key `recDir`。
- 与 `record.js` 共用同一个 IndexedDB 和 key，所以在任一页面选择后，另一个页面也能直接使用。
- 对外暴露 `window.RecordFolder`，提供 `load`、`pick`、`get`、`name`、`hasPermission`、`writeFile`、`writeFiles`、`onChange`。
- 音准页的「保存音域记录」和 K 歌页的「自动保存/手动保存」都会写到这个文件夹。
- 不支持 File System Access API 时，`supported()` 返回 false，页面降级为下载 / 浏览器内存储。

### 3.6 `js/record.js` —— 练习记录

- 用 `MediaRecorder` 录 webm/opus，停止后把「音高数据 + 成绩 + 录音」写入 IndexedDB `vpm-kara-rec`。
- 可回听、导出 JSON / CSV、也可用 File System Access API 写入用户选择的文件夹。
- 记录文件夹复用 `RecordFolder` 的句柄；页面启动时会调用 `loadPrefs()` 恢复上一次授权的文件夹。
- 偏好 key：`vpm.recAuto`。
- 对 K 歌页暴露：`window.KaraokeRec`。

### 3.7 `test/selftest.js`

- 纯 Node，自造假 DOM / 假 AudioContext / 假 localStorage，不需要浏览器和麦克风。
- 覆盖：YIN 检测、音名换算、本地曲库解析、K 歌提取、Viterbi、打分、歌词解析、音准页统计、音域记录等。
- 测试通过 `loadWithHook` 在 IIFE 的最后一个 `})();` 前注入 hook 访问内部函数。
  如果移动或改写 IIFE 结尾，需要同步检查 `test/selftest.js` 的 hook 注入逻辑。
- 修改纯逻辑时优先补测试，再跑 `node test/selftest.js`。

## 4. 数据与隐私红线

以下内容**绝对不能提交进 Git**，`.gitignore` 已拦截：

- 音频：`*.mp3`、`*.flac`、`*.wav`、`*.m4a`、`*.ncm`、`*.lrc` 等。
- 导出/录音：`karaoke-*.json`、`pitch-*.json`、`pitch-*.csv`、`range-log-*.json`、`range-log-*.csv`、`*-manifest.json`、`*.webm`。
- 本地目录：`recordings/`、`tools/vocals/`、`.demucs-env/`、`node_modules/`。

数据存储位置：

| 数据 | 位置 |
|---|---|
| 页面设置、A4、音域 | `localStorage: vpm.settings.v1` |
| 音准页录音统计 | `localStorage: vpm.sessions.v1` |
| 每日音域记录 | `localStorage: vpm.range.v1` + 可选 `range-log-*.json/csv` 文件 |
| K 歌设置/最近练习 | `localStorage: vpm.karaoke.v1` |
| 曲库文件夹句柄 | `IndexedDB: vpm-karaoke` |
| 统一记录文件夹句柄 | `IndexedDB: vpm-kara-rec / kv / recDir`（音准页和 K 歌页共用） |
| K 歌录音记录 | `IndexedDB: vpm-kara-rec` |

## 5. 开发约定

1. **保持纯静态**：浏览器代码不引入 npm / CDN / 网络请求；不要新增打包步骤。
2. **浏览器端保持无依赖 IIFE 风格**：现有代码以 `var` + `function` 为主，新增逻辑尽量沿用；
   Node 工具与测试可以使用现代 JS。
3. **中文界面与中文注释**：现有 UI、报错、README 均为中文，保持一致。
4. **不要破坏测试可访问性**：核心纯函数（音高、曲库解析、打分、统计）应保持可在 Node vm 中加载。
5. **缓存版本号**：`index.html` / `karaoke.html` 的 JS/CSS 带 `?v=8`。改完静态资源后同步提升版本号，
   否则用户浏览器会缓存旧文件；新增站点 JS 要同时更新两个页面的 `<script>` 和 Pages workflow 的 `cp` 步骤。
6. **Pages 打包名单**：`.github/workflows/pages.yml` 显式 `cp` 网站文件；新增前端资源时要同步更新该步骤。
7. **`.ncm` 工具注意许可证**：算法/常量来自 MIT 的 `taurusxin/ncmdump`，不要移除 `tools/LICENSE-upstream-ncmdump.txt`。
8. **隐私优先**：任何新功能都要默认本地处理；如果确实需要网络，先与项目维护者确认。

## 6. 当前工作区状态（2026-09-28）

- 新增 `js/record-folder.js`：统一记录文件夹，音域记录和 K 歌记录共用一个持久化授权文件夹。
- `index.html`：新增「📁 选择记录文件夹」按钮；「保存音域记录」写到统一文件夹；静态资源版本提升到 `?v=8`。
- `karaoke.html`：引入 `record-folder.js`，同步使用「记录文件夹」措辞，静态资源版本提升到 `?v=8`。
- `js/app.js`：接入 `RecordFolder`；修复音域 hold 逻辑里 `cur.midi` 未赋值导致稳定音无法记录的问题。
- `js/record.js`：页面启动时恢复上次记录文件夹；选择/更换文件夹走统一模块。
- `README.md`：补充统一记录文件夹和新的文件结构。
- `karaoke.html` / `js/library.js` / `karaoke.css`：新增「🎙 只看有人声分离版」过滤按钮，只有带 `.vocals.mp3` 的歌曲会显示。
- `js/karaoke.js` / `karaoke.css`：歌词新增「下一句」预告和最后 3 秒 `···` → `··` → `·` 倒计时。
- `test/selftest.js`：新增统一记录文件夹接口测试、人声分离版过滤测试、歌词预告测试；当前 `node test/selftest.js` 全部通过（74 项）。
