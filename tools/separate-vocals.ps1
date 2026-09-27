<#
  人声分离（去掉伴奏，只留人声）—— 为了让「音高线」真正跟上人声
  模型：Demucs (htdemucs)，Meta 开源，最主流的开源人声分离方案之一
        https://github.com/facebookresearch/demucs

  为什么需要它：
    浏览器里那套 DSP（带通 + 限制音高范围）只能"尽力避开"贝斯和鼓，
    伴奏一满还是会被带跑。真正干净的做法是**先把人声分离出来**再提取音高 ——
    这也是现在业界（UVR / Demucs / BS-RoFormer）的标准流程。

  用法：
    powershell -ExecutionPolicy Bypass -File tools\separate-vocals.ps1 -Path "C:\CloudMusic\周华健 - 难念的经.mp3"
    powershell -ExecutionPolicy Bypass -File tools\separate-vocals.ps1 -Path "C:\CloudMusic" -Out "C:\CloudMusic\vocals"

  输出： <Out>\<原文件名>.vocals.mp3      ← 在 K歌页④里当音频选它，音高线就干净了
         <Out>\<原文件名>.no_vocals.mp3  ← 伴奏（可以当自己的 K 歌伴奏）

  首次准备（已装好可跳过）：
    python -m venv %USERPROFILE%\.demucs-env
    %USERPROFILE%\.demucs-env\Scripts\pip install demucs

  CPU 上大约 1~3 分钟/首（4 分钟的歌）；有 NVIDIA 显卡会快很多。
#>
param(
  [Parameter(Mandatory=$true)][string]$Path,
  [string]$Out = "",
  [string]$Model = "htdemucs",
  [int]$Bitrate = 192,
  [switch]$KeepWav
)
$ErrorActionPreference = 'Stop'
$envDir = Join-Path $env:USERPROFILE '.demucs-env'
$py = Join-Path $envDir 'Scripts\python.exe'
if (-not (Test-Path $py)) { throw "没找到 Demucs 环境：$envDir`n先执行：`n  python -m venv `"$envDir`"`n  & `"$py`" -m pip install demucs" }
$ff = (Get-Command ffmpeg -ErrorAction SilentlyContinue)
if (-not $ff -and -not $KeepWav) { throw "没找到 ffmpeg（转 mp3 需要）。可以装 ffmpeg，或加 -KeepWav 只输出 wav。" }

$files = @()
if (Test-Path $Path -PathType Container) {
  $files = Get-ChildItem $Path -Recurse -File -ErrorAction SilentlyContinue |
           Where-Object { $_.Extension -match '^\.(mp3|flac|wav|m4a|aac|ogg)$' -and $_.Name -notmatch '\.(vocals|no_vocals)\.' }
  if (-not $Out) { $Out = Join-Path $Path 'vocals' }
} else { $files = @(Get-Item $Path) }
if (-not $Out) { $Out = Join-Path (Split-Path $files[0].FullName) 'vocals' }
New-Item -ItemType Directory -Force -Path $Out | Out-Null

Write-Host "共 $($files.Count) 个文件 → 输出到 $Out" -ForegroundColor Cyan
$tmp = Join-Path $env:TEMP ('demucs-' + [guid]::NewGuid().ToString('N').Substring(0,8))
foreach ($f in $files) {
  Write-Host ("`n▶ " + $f.Name) -ForegroundColor Yellow
  $t0 = Get-Date
  & $py -m demucs --two-stems=vocals -n $Model -o $tmp $f.FullName
  if ($LASTEXITCODE -ne 0) { Write-Warning "分离失败：$($f.Name)"; continue }
  $sub = Get-ChildItem $tmp -Recurse -Directory -Filter $Model | Select-Object -First 1
  if (-not $sub) { Write-Warning "找不到输出目录：$($f.Name)"; continue }
  $v = Join-Path $sub.FullName 'vocals.wav'
  $n = Join-Path $sub.FullName 'no_vocals.wav'
  $base = Join-Path $Out $f.BaseName
  if ($KeepWav) {
    Copy-Item $v "$base.vocals.wav" -Force
    Copy-Item $n "$base.no_vocals.wav" -Force
  } else {
    & ffmpeg -y -v error -i $v -b:a "${Bitrate}k" "$base.vocals.mp3"
    & ffmpeg -y -v error -i $n -b:a "${Bitrate}k" "$base.no_vocals.mp3"
  }
  Remove-Item $sub.FullName -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host ("   ✅ " + [math]::Round(((Get-Date)-$t0).TotalSeconds) + " 秒 → " + $f.BaseName + ".vocals.mp3") -ForegroundColor Green
}
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "`n完成。K歌页④里选 <文件名>.vocals.mp3 当音频，音高线会干净很多。" -ForegroundColor Cyan