"""Offline CUDA ClearVoice speech cleanup for native Lumen audio clips.

Produces a lossless WAV matching the original source clock. Never renders video.
"""
import argparse
import json
import math
from pathlib import Path
import re
import subprocess
import time
import numpy as np
import av
import imageio_ffmpeg

ROOT=Path(__file__).resolve().parents[1]
FFMPEG=imageio_ffmpeg.get_ffmpeg_exe()
ENGINE=ROOT/'work/tools/deepfilter/deep-filter.exe'
ATTENUATION={'gentle':18,'balanced':30,'strong':45}

def deesser_filter(strength='balanced'):
    intensity={'gentle':0.20,'balanced':0.35,'strong':0.50}[strength]
    return f'deesser=i={intensity}:m=0.5:f=0.5',intensity


def pause_expander(metrics,strength):
    # The residual floor is measured BEFORE makeup gain. Keep the threshold
    # below quiet speech, use a soft knee, and release over syllable gaps.
    floor=metrics['quiet_window_rms_dbfs_p10']
    threshold_db=min(-42.,floor+{'gentle':5,'balanced':8,'strong':10}[strength])
    depth={'gentle':12,'balanced':24,'strong':36}[strength]
    threshold=10**(threshold_db/20)
    return f'agate=threshold={threshold:.9f}:ratio=3:range={10**(-depth/20):.9f}:attack=2:release=250:knee=4:detection=rms',threshold_db,depth

def progress(message,value):print(json.dumps({'message':message,'progress':value}),flush=True)

def run(args):
    p=subprocess.run(list(map(str,args)),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',errors='replace')
    if p.returncode:raise RuntimeError(p.stderr[-6000:] or p.stdout[-6000:])
    return p.stderr

def loudness(file,filters=''):
    chain=(filters+',' if filters else '')+'loudnorm=I=-16:TP=-1.5:LRA=9:print_format=json'
    log=run([FFMPEG,'-v','info','-i',file,'-vn','-af',chain,'-f','null','-'])
    matches=re.findall(r'\{\s*"input_i".*?\}',log,re.S)
    if not matches:raise RuntimeError('Could not measure speech loudness.')
    return json.loads(matches[-1])

def waveform_metrics(file):
    total=0; squares=0.;peak=0.;clipped=0;bins=[];left=np.empty(0,dtype=np.float32)
    with av.open(str(file)) as container:
        resampler=av.AudioResampler(format='fltp',layout='mono',rate=48000)
        for frame in container.decode(audio=0):
            for converted in resampler.resample(frame):
                samples=converted.to_ndarray().reshape(-1).astype(np.float32,copy=False)
                total+=samples.size;squares+=float(np.dot(samples,samples));peak=max(peak,float(np.max(np.abs(samples),initial=0)));clipped+=int(np.count_nonzero(np.abs(samples)>=0.999))
                joined=np.concatenate((left,samples));count=joined.size//960
                if count:bins.extend(np.sqrt(np.mean(joined[:count*960].reshape(count,960)**2,axis=1)).tolist())
                left=joined[count*960:]
        for converted in resampler.resample(None):
            samples=converted.to_ndarray().reshape(-1).astype(np.float32,copy=False)
            total+=samples.size;squares+=float(np.dot(samples,samples));peak=max(peak,float(np.max(np.abs(samples),initial=0)));clipped+=int(np.count_nonzero(np.abs(samples)>=0.999))
            joined=np.concatenate((left,samples));count=joined.size//960
            if count:bins.extend(np.sqrt(np.mean(joined[:count*960].reshape(count,960)**2,axis=1)).tolist())
            left=joined[count*960:]
    def db(x):return round(20*math.log10(max(1e-6,float(x))),3)
    return {'samples':total,'seconds':round(total/48000,6),'peak_dbfs':db(peak),'rms_dbfs':db(math.sqrt(squares/max(1,total))),
        'quiet_window_rms_dbfs_p10':db(np.quantile(bins,0.1) if bins else 0),'near_clipped_sample_fraction':round(clipped/max(1,total),8)}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('source',type=Path);parser.add_argument('--outdir',type=Path,required=True)
    parser.add_argument('--strength',choices=ATTENUATION,default='balanced');parser.add_argument('--level-voice',action=argparse.BooleanOptionalAction,default=True)
    parser.add_argument('--duration',type=float)
    parser.add_argument('--engine',choices=['deepfilter','clearvoice'],default='clearvoice')
    args=parser.parse_args();source=args.source.resolve(strict=True);out=args.outdir.resolve();out.mkdir(parents=True,exist_ok=False)
    if args.engine=='deepfilter' and not ENGINE.is_file():raise RuntimeError('The local DeepFilterNet Windows engine is missing.')
    started=time.monotonic();raw=out/'original-audio.wav';denoised=out/'denoised'/'original-audio.wav';final=out/'enhanced.wav'
    progress('Extracting original microphone audio (48 kHz mono)…',0.05)
    run([FFMPEG,'-y','-v','error','-i',source,'-vn','-ar',48000,'-ac',1,'-c:a','pcm_s16le',raw])
    if args.engine=='clearvoice':
        denoised.parent.mkdir()
        progress('ClearVoice MossFormer2 neural speech restoration on local CUDA…',0.20)
        run([ROOT/'work/voice-venv/Scripts/python.exe',Path(__file__).with_name('clearvoice_infer.py'),raw,denoised])
    else:
        progress('DeepFilterNet neural noise reduction on CPU…',0.20)
        run([ENGINE,'-D','-a',ATTENUATION[args.strength],'-o',denoised.parent,raw])
    if not denoised.is_file():raise RuntimeError('The local neural engine returned no enhanced audio.')
    before=waveform_metrics(raw);noise_reduced=waveform_metrics(denoised)
    target=args.duration if args.duration and math.isfinite(args.duration) and args.duration>0 else before['seconds']
    # Suppress residual stationary noise in pauses before loudness makeup can
    # raise it again. This is downward expansion, never a hard silence cut.
    expansion,expansion_threshold,expansion_depth=pause_expander(noise_reduced,args.strength)
    deesser,deesser_intensity=deesser_filter(args.strength)
    cleaned=out/'pause-cleaned.wav'
    progress('Reducing fan noise and softening sharp S sounds locally…',0.55)
    run([FFMPEG,'-y','-v','error','-i',denoised,'-af',expansion+','+deesser,'-ar',48000,'-ac',1,'-c:a','pcm_s24le',cleaned])
    # DeepFilterNet compensates its lookahead; explicit pad/trim preserves the
    # full original asset's time base, including a video's small audio tail gap.
    tone='highpass=f=75,lowpass=f=16000,equalizer=f=250:t=q:w=1:g=-1.5,acompressor=threshold=0.125:ratio=2:attack=10:release=120'
    filters=''
    if args.level_voice:
        progress('Balancing voice level, rumble and peaks…',0.65)
        measured=loudness(cleaned,tone)
        if measured['input_i'] not in ('-inf','inf'):
            filters=tone+f",loudnorm=I=-16:TP=-1.5:LRA=9:measured_I={measured['input_i']}:measured_TP={measured['input_tp']}:measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}:offset={measured['target_offset']}:linear=true"
    filters+=((',' if filters else '')+f'aresample=48000,asetpts=PTS-STARTPTS,apad,atrim=end_sample={round(target*48000)}')
    run([FFMPEG,'-y','-v','error','-i',cleaned,'-af',filters,'-ar',48000,'-ac',1,'-c:a','pcm_s24le',final])
    progress('Measuring before/after audio…',0.90)
    after=waveform_metrics(final);before_loud=loudness(raw);after_loud=loudness(final)
    report={'source':str(source),'output':str(final),'engine':'ClearVoice MossFormer2_SE_48K' if args.engine=='clearvoice' else 'DeepFilterNet 0.5.6 official Windows CPU binary','neural_inference':'local CUDA' if args.engine=='clearvoice' else 'local CPU','strength':args.strength,
        'attenuation_limit_db':ATTENUATION[args.strength] if args.engine=='deepfilter' else None,'requested_duration_seconds':target,'pause_expansion':{'threshold_dbfs':round(expansion_threshold,3),'maximum_reduction_db':expansion_depth,'attack_ms':2,'release_ms':250,'hard_gate':False},'deessing':{'enabled':True,'engine':'FFmpeg adaptive deesser','intensity':deesser_intensity,'max_deessing':0.5,'frequency':0.5},'voice_leveling':args.level_voice,'delay_compensated':True,'sample_rate':48000,'channels':1,'pcm_bits':24,
        'before':before,'denoised_before_leveling':noise_reduced,'after':after,
        'before_loudness_lufs':before_loud['input_i'],'after_loudness_lufs':after_loud['input_i'],'after_true_peak_dbtp':after_loud['input_tp'],
        'quiet_window_attenuation_before_leveling_db':round(before['quiet_window_rms_dbfs_p10']-noise_reduced['quiet_window_rms_dbfs_p10'],3),
        'elapsed_seconds':round(time.monotonic()-started,3),'cloud_inference':False,'video_was_rendered':False,
        'limitations':['Noise reduction cannot reconstruct clipped or missing speech.','Room echo and strong reverb may remain.','Designed for speech; do not apply to music beds.','Quiet-window attenuation is not a speech-quality or SNR score.','Listen for artifacts; use gentle strength if consonants or ambience sound unnatural.']}
    (out/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    progress('Local voice enhancement ready; original media is unchanged.',1)

if __name__=='__main__':main()
