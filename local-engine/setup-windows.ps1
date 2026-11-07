param([switch]$DownloadModels)
$ErrorActionPreference = 'Stop'
$engineRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $engineRoot
function Invoke-Checked { param([string]$Exe, [string[]]$Arguments) & $Exe @Arguments; if ($LASTEXITCODE -ne 0) { throw "$Exe failed ($LASTEXITCODE)" } }
Invoke-Checked py @('-3.12','-m','venv','work/venv')
Invoke-Checked py @('-3.12','-m','venv','work/voice-venv')
Invoke-Checked './work/venv/Scripts/python.exe' @('-m','pip','install','-r','local-engine/requirements.txt')
Invoke-Checked './work/voice-venv/Scripts/python.exe' @('-m','pip','install','torch==2.5.1+cu121','torchaudio==2.5.1+cu121','--index-url','https://download.pytorch.org/whl/cu121')
Invoke-Checked './work/voice-venv/Scripts/python.exe' @('-m','pip','install','-r','local-engine/requirements-voice.txt')
if (!(Test-Path -LiteralPath 'work/clearervoice')) {
 Invoke-Checked git @('clone','https://github.com/modelscope/ClearerVoice-Studio.git','work/clearervoice')
}
Invoke-Checked git @('-C','work/clearervoice','checkout','6b3774dc79c46ae8bed2a4fa5f706f0ac8c75c61')
if ($DownloadModels) { Invoke-Checked './work/venv/Scripts/python.exe' @('local-engine/download_models.py') }
Write-Host 'Set LUMEN_LOCAL_VIDEO_ROOT to this repository root before launching Lumen:' $engineRoot
Write-Host 'Run work/venv/Scripts/python.exe local-engine/check_runtime.py to verify readiness.'
