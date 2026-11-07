"""Read-only readiness check. Does not download models or change configuration."""
import argparse
import importlib.metadata
from pathlib import Path
import subprocess
import sys
ROOT = Path(__file__).resolve().parents[1]
def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    failures = []
    for item in ['work/venv/Scripts/python.exe', 'work/voice-venv/Scripts/python.exe', 'work/clearervoice/clearvoice/clearvoice/networks.py', 'work/models/whisper-small.en/model.bin', 'work/models/MossFormer2_SE_48K/last_best_checkpoint.pt']:
        if not (ROOT/item).is_file(): failures.append('Missing: '+item)
    for name in ['av','faster-whisper','ctranslate2','imageio-ffmpeg']:
        try: print(name, importlib.metadata.version(name))
        except importlib.metadata.PackageNotFoundError: failures.append('Missing Python package: '+name)
    voice = ROOT/'work/voice-venv/Scripts/python.exe'
    if voice.is_file():
        result = subprocess.run([str(voice), '-c', 'import torch; print("Voice CUDA:", torch.cuda.is_available()); assert torch.cuda.is_available(), "NVIDIA CUDA unavailable"'], capture_output=True, text=True)
        print(result.stdout.strip())
        if result.returncode: failures.append(result.stderr.strip())
    for failure in failures: print(failure, file=sys.stderr)
    return bool(failures)
if __name__ == '__main__': sys.exit(main())
