# Local inference engine (Windows / NVIDIA)

These workers are source code, not model weights or bundled Python installations. Lumen's native timeline remains editable; these workers provide transcription, speech restoration and optional MP4 compatibility finishing. Inference uses local files only. Downloading installers, packages and weights requires internet once.

## Prerequisites

- Windows x64, Python **3.12** (`py -3.12`), Git, recent NVIDIA driver and Ollama.
- Tested GPU class: RTX 3080 10 GB. CPU-only Whisper/voice is not configured by this setup.
- Allow several GB for Ollama, Whisper, ClearVoice, Python CUDA libraries and downloaded sources.
- For building the editor, follow the repository's Node/npm build instructions separately.

From the repository root in PowerShell:

```powershell
./local-engine/setup-windows.ps1 -DownloadModels
$env:LUMEN_LOCAL_VIDEO_ROOT = (Get-Location).Path
./work/venv/Scripts/python.exe local-engine/check_runtime.py
```

The script creates ignored `work/venv`, `work/voice-venv`, `work/clearervoice` and `work/models` folders. It checks out the tested ClearerVoice-Studio commit. Existing environments are not reset; use a clean clone for reproducibility. Requirements pin direct dependencies, not every transitive dependency; a clean-machine installation still needs validation for your driver and package availability. It does not change system settings or install the NVIDIA driver.

Launch Lumen from **the same shell** (for development, `npm run dev`) so it receives `LUMEN_LOCAL_VIDEO_ROOT`. Alternatively configure the app's profile file `local-video-engine.json` as `{"root":"D:/path/to/this/repository"}`. The root must be the repository root, not `local-engine`. Never commit this machine-specific configuration.

## Models and licensing

The explicit `download_models.py` step downloads **Systran/faster-whisper-small.en** (English only) and **alibabasglab/MossFormer2_SE_48K** from Hugging Face into `work/models`. It verifies the tested ClearVoice checkpoint SHA-256 before use. Read the original model cards and licenses before redistribution or commercial use. ClearerVoice-Studio source is fetched from its upstream repository, not vendored here. Model weights are not included in this repository.

Configure Ollama separately:

```powershell
ollama pull qwen2.5:7b-instruct-q4_K_M
ollama create local-video-editor -f local-engine/Modelfile
```

In Lumen select the local Ollama/OpenAI-compatible endpoint `http://127.0.0.1:11434/v1` and model `local-video-editor`. Optional local visual analysis additionally needs `ollama pull qwen3-vl:4b`. No paid API is required. Runtime workers unload resident Ollama models before CUDA jobs to reduce peak VRAM; keep other GPU workloads closed on 10 GB cards.

## Readiness and limitations

`check_runtime.py` checks required paths, Python packages and voice CUDA availability; it is not an end-to-end inference test. After setup, import a short recording, request native captions/voice cleanup, inspect the timeline, then test a short export. Review retake decisions: uncertain speech, overlapping speakers and incomplete takes can need manual edits. The setup and help commands were checked against the development environment; a clean Windows installation has not been exercised automatically.

The default voice worker uses **ClearVoice MossFormer2** plus local FFmpeg leveling, expansion and de-essing. The optional `--engine deepfilter` mode additionally requires an independently installed `work/tools/deepfilter/deep-filter.exe` and its model/runtime; setup does **not** install it. Initial native timeline audio filters use the editor's existing browser processing. The deprecated flattened `editor.py` pipeline is not distributed or used by the native workflow.

All inference workers operate offline after setup. Network package/model downloads happen only in the explicit setup/download steps. Optional cloud editor integrations in the upstream application are separate; choose the local provider for the workflow described here.
