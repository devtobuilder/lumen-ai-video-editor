"""Offline MossFormer2 48k inference in a separate CUDA environment.

Called by native_audio.py; produces AUDIO only. Requires verified local weights.
"""
import os
os.environ['HF_HUB_OFFLINE']='1'
os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
import argparse,hashlib,json,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'work/clearervoice/clearvoice'))
HASH='03692b9f773bbd6bb43b9c5a41f96b1e28affd66e13796b7bec66ad3d8b227c6'

def install_strict_loader(speech_model_class, torch, checkpoint):
 """Load the verified checkpoint directly; no pointer file or network fallback."""
 def load_model(self):
  self._verified_weights_loaded=False
  state=torch.load(checkpoint,map_location='cpu',weights_only=True)
  state=state.get('model',state)
  state={k.removeprefix('module.'):v for k,v in state.items()}
  self.model.load_state_dict(state,strict=True)
  self._verified_weights_loaded=True
 speech_model_class.load_model=load_model


def main():
 p=argparse.ArgumentParser();p.add_argument('source',type=Path);p.add_argument('output',type=Path);args=p.parse_args()
 checkpoint=ROOT/'work/models/MossFormer2_SE_48K/last_best_checkpoint.pt'
 if not checkpoint.is_file() or hashlib.file_digest(checkpoint.open('rb'),'sha256').hexdigest()!=HASH:raise RuntimeError('Local ClearVoice checkpoint integrity check failed.')
 import numpy as np
 import soundfile as sf
 import torch
 from clearvoice.networks import CLS_MossFormer2_SE_48K,SpeechModel
 # Bypass upstream pointer-file discovery and its silent offline download fallback.
 install_strict_loader(SpeechModel,torch,checkpoint)
 settings=argparse.Namespace(mode='inference',use_cuda=1,num_gpu=1,sampling_rate=48000,network='MossFormer2_SE_48K',checkpoint_dir=str(checkpoint.parent),one_time_decode_length=4,decode_window=4,win_type='hamming',win_len=1920,win_inc=384,fft_len=1920,num_mels=60)
 torch.set_num_threads(4)
 model=CLS_MossFormer2_SE_48K(settings)
 if not getattr(model,'_verified_weights_loaded',False):raise RuntimeError('ClearVoice did not load verified trained weights.')
 if model.device.type!='cuda':raise RuntimeError('ClearVoice requires the configured local NVIDIA CUDA device.')
 audio,sr=sf.read(args.source,dtype='float32',always_2d=True)
 if sr!=48000:raise RuntimeError('Expected 48kHz source audio.')
 audio=audio.mean(axis=1)
 started=time.monotonic()
 # Upstream NumPy batch decoder checks shape[0] rather than sample length
 # when deciding to chunk. Bound GPU memory ourselves and overlap-add a full
 # second of context to avoid hard boundaries between inference windows.
 window=4*48000;stride=3*48000;overlap=window-stride
 result=np.zeros(len(audio),dtype=np.float64);weights=np.zeros(len(audio),dtype=np.float64)
 with torch.inference_mode():
  for start in range(0,len(audio),stride):
   stop=min(len(audio),start+window);chunk=np.pad(audio[start:stop],(0,max(0,window-(stop-start))))
   enhanced=np.asarray(model.decode_data(chunk[None,:])).reshape(-1)[:stop-start]
   weight=np.ones(len(enhanced))
   if start:weight[:min(overlap,len(weight))]=np.linspace(0,1,min(overlap,len(weight)))
   if stop<len(audio):weight[-overlap:]=np.linspace(1,0,overlap)
   result[start:stop]+=enhanced*weight;weights[start:stop]+=weight
   print(json.dumps({'message':f'ClearVoice restored {stop/48000:.1f}/{len(audio)/48000:.1f}s locally','progress':round(.2+.3*stop/len(audio),3)}),flush=True)
 result=np.divide(result,weights,out=np.zeros_like(result),where=weights>0)
 if not np.isfinite(result).all():raise RuntimeError('ClearVoice returned invalid samples.')
 if abs(len(result)-len(audio))>1920:raise RuntimeError('ClearVoice output changed source clock unexpectedly.')
 result=np.pad(result,(0,max(0,len(audio)-len(result))))[:len(audio)]
 sf.write(args.output,result,48000,subtype='PCM_24')
 (args.output.parent/'clearvoice-inference.json').write_text(json.dumps({'model':'MossFormer2_SE_48K','checkpoint_sha256':HASH,'strict_weights_loaded':True,'device':str(model.device),'chunk_seconds':4,'samples':len(result),'seconds':round(time.monotonic()-started,3),'peak_allocated_vram_bytes':torch.cuda.max_memory_allocated(),'cloud_inference':False},indent=2))

if __name__=='__main__':main()
