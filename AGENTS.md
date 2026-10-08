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
│  ├─ app.js                  音准页逻辑：实时曲线、音域、录音统计、导出、单音测试、换声区扫描与音域趋势
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
  - 格式：`{ 'YYYY-MM-DD': { low, high, notes: { midi: count }, updatedAt } }`。
  - 原本要求连续同一音若干帧才记录；当前工作区正在改为更严格的「稳定唱住」过滤。
  - 可同步到「我的音域」，并导出 JSON / CSV。
- 换声区 & 音域趋势（页面第 ⑧ 块）：
  - 存储 key：`vpm.passaggio.v1`，格式 `{ scans: [...], manual, updatedAt }`，只保留最近 20 次扫描。
  - 纯函数（可在 Node vm 里直接测）：`trendSeries`（每日音域 → 按日期升序序列）、
    `noteHistogram`（汇总每个音被稳定唱住的次数）、`rangeHoles`（音域上半段从没唱到过的连续空洞）、
    `analyzePassaggio`（逐音抖动 / 唱住比例 / 音量突变 → 换声点候选）、`passCompare`（与男声换声区常见位置对照）。
  - 换声区扫描由主分析循环驱动：`analyze()` → `scanFeed(ts, cur)`，按 `performance.now()` 时间轴切
    「听参考音 1.2s / 跟着唱 2.2s」两段，`SCAN_STEPS = 12` 个半音；`finishPassScan()` 收尾并落盘。
    修改 `analyze()` 或 `S.analysisInterval` 时要同步检查 `scanFeed` / `finishPassScan` 的帧数假设。
  - 基线取扫描里最下面 1/3 的音；四条线索（抖动、唱住比例、音量骤增、音量骤降）任意两条**连续**音
    同时出现才算换声点；往上基本唱不出来时报「高音上限」而不是换声点。
  - 导出 `passaggio-<stamp>.json / -trend.csv / -scan.csv`，可写进统一记录文件夹。
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
- 回放配对走纯函数 `pickBacking(files, mode)`（对测试暴露 `KaraokeRec.pickBacking`）：
  「🎤 原唱版」= 有伴奏版就给 `伴奏 + 原唱` 两轨，没有就直接放完整版；
  「🎧 录音+伴奏」**只认 `.no_vocals`（伴奏版）**，没有伴奏版时 `backing = null`、调用方只回放录音 ——
  绝不能拿带原唱的完整版来凑（否则听起来像"我的录音里原唱声音很大"）。
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
- 导出/录音：`karaoke-*.json`、`pitch-*.json`、`pitch-*.csv`、`range-log-*.json`、`range-log-*.csv`、`passaggio-*.json`、`passaggio-*.csv`、`*-manifest.json`、`*.webm`。
- 本地目录：`recordings/`、`tools/vocals/`、`.demucs-env/`、`node_modules/`。

数据存储位置：

| 数据 | 位置 |
|---|---|
| 页面设置、A4、音域 | `localStorage: vpm.settings.v1` |
| 音准页录音统计 | `localStorage: vpm.sessions.v1` |
| 每日音域记录 | `localStorage: vpm.range.v1` + 可选 `range-log-*.json/csv` 文件 |
| 换声区扫描 / 手动换声点 | `localStorage: vpm.passaggio.v1` + 可选 `passaggio-*.json` / `passaggio-*-trend.csv` / `passaggio-*-scan.csv` |
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
5. **缓存版本号**：`index.html` / `karaoke.html` 的 JS/CSS 带 `?v=N`，**每个文件各自计数**，不是全局统一号
   （例如现在 `style.css?v=9`、`js/app.js?v=9`、`js/karaoke.js?v=11`、`js/library.js?v=12`、`js/record.js?v=13`）。改完哪个静态资源就提升哪个文件的号，
   否则用户浏览器会缓存旧文件；新增站点 JS 要同时更新引用它的页面的 `<script>` 和 Pages workflow 的 `cp` 步骤。
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

## 7. 最近一次改动（换声区 & 音域趋势）

- `index.html`：新增第 ⑧ 块「换声区 & 音域趋势」——起始音选择、🎙 换声区扫描、趋势图 canvas、
  手动换声点下拉、逐音表格、口径说明 `<details>`；`style.css` 与 `js/app.js` 的引用提升到 `?v=9`。
- `karaoke.html`：`style.css` 引用同步提升到 `?v=9`（共用样式改了）。
- `style.css`：新增 `.trend-chart` / `.pass-tag` / `tr.pass-break` 样式。
- `js/app.js`：新增整块换声区逻辑（`PASS_KEY`、`trendSeries`、`noteHistogram`、`rangeHoles`、
  `analyzePassaggio`、`passCompare`、`startPassScan` / `scanFeed` / `finishPassScan`、`drawTrend`、
  `renderPassaggio`、导出与保存）；`analyze()` 里接一行 `scanFeed`；`stopMic()` 会中断扫描；
  `recordRangeNote()` 的节流块顺带刷新趋势图。
- `.gitignore`：补 `passaggio-*.json` / `passaggio-*.csv`（导出文件绝不入库）。
- `test/selftest.js`：新增 3c 节 34 项测试（趋势序列、音高直方图、音域空洞、换声点判定、
  高音上限 vs 换声点、手动覆盖、JSON/CSV 导出、端到端扫描流程）；当前 **108 项全部通过**。

## 8. 最近一次改动（"录音+伴奏里原唱很大"：没有伴奏版时不要拿完整版凑）

背景：用户反馈 `成龙 - 拯救 (2013再生抒情版)` 的练习录音回放里原唱很大。排查结论：
这首歌没做过人声分离（`C:\CloudMusic\vocals\` 里只有 `孙楠 - 拯救 (live)` 的分离版），
所以曲库里 `accomp = null`；`js/record.js` 的「🎧 录音+伴奏」当时会退回 `files.audio`（完整版，带原唱），
实测原版 mp3 平均 −14.2 dB、用户录音平均 −32.3 dB，混起来原唱比人声高约 11 dB。
另外录音本身也有原唱：MediaRecorder 只录麦克风，把录音与原版做 25ms 包络归一化互相关 ρ≈0.50
（两次不同录音之间只有 0.20）→ 是外放时麦克风拾到了原唱，所以**必须戴耳机**。

- `js/record.js`：抽出纯函数 `pickBacking(files, mode)`（暴露 `KaraokeRec.pickBacking`）；
  「录音+伴奏」只认 `.no_vocals`，没有伴奏版时只回放录音并说明原因；「原唱版」行为不变。
- `js/record.js` 再加**混音响度对齐**（同一个坑的第二层：固定音量下人声被伴奏盖住）：
  - `bufferLoudness(buf)`：每 50ms 一帧功率 → 以最响帧 −10dB 为门限 → 门限内平均功率 = 响度，顺带取真实峰值。
  - `decodeLoudness` / `measureLoudness`：用 `OfflineAudioContext(1,1,8000)` 解码（4 分钟的歌只要 ~18MB），
    只用来算 dB，不进播放链路；结果按 `文件名|大小`（录音按 `rec|<id>`）缓存进 `loudCache`。
  - `planMixLevels(tracks, louds, headroom)`（纯函数）：人声目标 `VOICE_TARGET_DB = −17 dBFS`、
    伴奏 `BACK_TARGET_DB = −19 dBFS`（差 2dB = 听感相当、人声不被压住）；单路增益夹在
    `MIN_GAIN_DB = −24dB` ~ `MAX_BOOST_DB = +18dB`；再按**估计总峰值**（增益 × 测量峰值）整体等比例留白。
    没有限幅总线时留白上限 `HEADROOM = 0.95`，有限幅时 `LIMITED_HEADROOM = 1.5`。
  - `fallbackVolumes(plan)`：拿不到 Web Audio（无法放大）时的兜底 —— 整体等量压低，保住人声/伴奏的相对比例。
  - 播放侧：`masterBus(ctx)` = master gain → `DynamicsCompressor`（threshold −3dB / ratio 20 / attack 3ms，
    只压峰不动平均音量）→ destination；人声走 `GainNode`（可以 >1），没有音频图就退回 `volume`。
    量不出响度时回退老的固定比例（人声 1 / 伴奏 0.6）。
  - 实测（`成龙 - 拯救` 两遍）：录音 −22.7 / −27.0 dBFS、伴奏 −14.3、原唱 −13.1、完整版 −12.0；
    对齐后恰好人声 −17.0、伴奏 −19.0 dBFS（限幅时估计总峰值 1.08~1.5，由限幅器兜住）。
- `js/karaoke.js` / `js/library.js` / `karaoke.html`：把「完整伴奏版」措辞改成
  「完整版（原唱 + 伴奏）」，没有分离版时在状态栏明确提示"播放的是带原唱的完整版、戴耳机"。
- `karaoke.html`：`js/karaoke.js?v=11`、`js/library.js?v=11`、`js/record.js?v=13`。
- `README.md`：练习记录回放一节补上"没有伴奏版时只回放录音"和响度对齐说明。
- `test/selftest.js`：新增 4b 节 7 项（`pickBacking` 五种组合 + 接口暴露）、4c 节 14 项
  （响度测量对正弦/dBFS、全静音、2dB 不变式、放大与上下限、留白与限幅模式、兜底比例、量不出响度）；
  当前 **132 项全部通过**。

## 9. 最近一次改动（批量把已有录音做成"人声加强"混音 + 曲库过滤混音）

- `js/library.js`：新增 `MIX_RE = /我的练习|练习\+|练习混音/`，扫描时跳过练习混音成品 ——
  否则 `C:\CloudMusic\recordings\` 里的 `xxx - 我的练习+伴奏.mp3` 会被当成一首新歌进曲库。
  实测真实目录 5464 个文件 → 1862 首，混音误入 0 首。`karaoke.html` 里 `js/library.js?v=12`。
- `.music-staging/mix-recordings.py`（本地工具，不进仓库）：把 `recordings\karaoke-*.webm` 批量混成
  `<歌> - 我的练习+伴奏 - <时间戳>.mp3`，增益规则与 `js/record.js` 的 `planMixLevels` 完全一致
  （人声 −17 / 伴奏 −19 dBFS、单路 +18/−24dB 夹紧、限幅留白 1.5、`alimiter` 兜底）。`--dry` 只列计划。
- **对齐修正（重要）**：音频元素开始播放到真的出声有输出延迟，人是跟着"听到的"唱的，所以
  `MediaRecorder` 录下来的内容整体晚于歌曲时间轴。用「JSON 里的音高轮廓 ×从人声版提取的参考线」
  扫描所有偏移量量出来：匹配率可信的 4 条一致落在 −550 ~ −875ms（中位数 650ms），
  所以混音时统一裁掉录音开头这段（`-ss 0.6` 量级）。物理方向也自洽：串音法的峰值只能在负方向。
  复现工具：`.music-staging/_align_prep.py`（解码参考音频）+ `_align_check2.js`（扫偏移）。
- 实测产出 11 个文件，响度 −16.2 ~ −22.2 dBFS、峰值 −0.8 ~ −3.4 dBFS、**0 个削顶样本**；
  人声增益 +4.4 ~ +14.1dB、伴奏 −2.3 ~ −6.6dB（每条都落在"人声比伴奏高 2dB"附近，被 +18dB 上限夹住的略少）。
- `test/selftest.js`：新增「练习混音不进曲库」1 项；当前 **133 项全部通过**。

## 10. 最近一次改动（分离带重音符号的歌名：修 demucs 的 GBK 编码崩溃）

背景：给 `Les Misérables Live!（25 周年）` 那批歌做分离，7 首**全部**在跑模型之前就退出。
根因不是模型、不是显存，是编码：Windows 控制台/管道默认 GBK，`demucs/separate.py` 一开始就
`print(f"Separating track {track}")`，曲名里的 `ö`（`Schönberg`）没法用 GBK 编码，
Python 抛 `UnicodeEncodeError` 直接结束进程。中文歌名反而没事（GBK 能表示中文）。

- `tools/separate-vocals.ps1`：调用 demucs 前设 `$env:PYTHONIOENCODING = 'utf-8'` +
  `$env:PYTHONUTF8 = '1'`（只影响子进程 Python 的输出编码，不动别的）。
  以后 `Céline`、`Édith`、`Schönberg` 这类歌手名都不会再挡路。
- ⚠️ **改 `.ps1` 的坑**：`tools/separate-vocals.ps1` 是 **UTF-8 with BOM**，而编辑工具会把 BOM 吃掉；
  一旦没 BOM，Windows PowerShell 5.1 会按 GBK 读这个文件，中文字符串被解码坏掉 →
  `Unexpected token` / `The string is missing the terminator` 之类**语法错误**（不是编码警告，是整个脚本跑不了）。
  改完 `.ps1` 记得查前 3 字节是不是 `EF BB BF`，不是就用
  `[System.IO.File]::WriteAllBytes($p, ([byte[]](0xEF,0xBB,0xBF) + [System.IO.File]::ReadAllBytes($p)))` 补回来。
- 顺带确认的执行方式：这台机器上 `pwsh` 不在 PATH，脚本用
  `& 'C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File <脚本>`
  跑（当前会话直接 `& 脚本.ps1` 会被执行策略/签名挡下）。
- 本次产出：7 首 × (`.vocals.mp3` + `.no_vocals.mp3`) 全部落在 `C:\CloudMusic\vocals\`，
  用 `js/library.js` 的真实 `buildCatalog` 复核：7 首都是「完整版 + 人声版 + 伴奏版」齐全
  （`.vocals` 跨目录按歌名合并，`.no_vocals` 靠 artist|title 合并回主条目）。
  人声/伴奏实测 −15.4 ~ −27.6 dBFS、峰值 −0.2 ~ −6.9 dBFS，无静音、无削顶。
