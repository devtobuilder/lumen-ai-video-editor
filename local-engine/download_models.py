"""Explicit one-time model download; never called during editing/inference."""
import hashlib
from pathlib import Path
from huggingface_hub import snapshot_download, hf_hub_download
ROOT = Path(__file__).resolve().parents[1]
snapshot_download('Systran/faster-whisper-small.en', revision='d1d751a5f8271d482d14ca55d9e2deeebbae577f', local_dir=ROOT/'work/models/whisper-small.en')
checkpoint = Path(hf_hub_download('alibabasglab/MossFormer2_SE_48K', 'last_best_checkpoint.pt', local_dir=ROOT/'work/models/MossFormer2_SE_48K'))
expected = '03692b9f773bbd6bb43b9c5a41f96b1e28affd66e13796b7bec66ad3d8b227c6'
with checkpoint.open('rb') as stream:
    if hashlib.file_digest(stream, 'sha256').hexdigest() != expected:
        raise RuntimeError('ClearVoice checkpoint hash differs from the tested model. Do not run inference; review the upstream change.')
print('Local models downloaded and ClearVoice integrity verified.')
