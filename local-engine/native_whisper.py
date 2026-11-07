"""CUDA Whisper worker for Lumen's native transcript command. Never renders video."""
import argparse
import json
import math
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]

def progress(message, value):
    print(json.dumps({'message': message, 'progress': value}), flush=True)

def unload_ollama():
    # The editor's model has completed generation before its tool executes.
    # Unload every resident model, including vision models, before allocating CUDA.
    try:
        with urllib.request.urlopen('http://127.0.0.1:11434/api/ps', timeout=10) as r:
            models = json.load(r).get('models', [])
    except urllib.error.HTTPError as error:
        raise RuntimeError('Cannot confirm local model memory state; transcription was not started.') from error
    except urllib.error.URLError as error:
        if isinstance(error.reason, ConnectionRefusedError) or getattr(error.reason, 'winerror', None) == 10061:
            return  # No listening local server means no resident Ollama runner.
        raise RuntimeError('Cannot confirm local model memory state; transcription was not started.') from error
    for model in models:
        name = model.get('name') or model.get('model')
        if not name:
            continue
        req = urllib.request.Request('http://127.0.0.1:11434/api/generate',
            data=json.dumps({'model': name, 'keep_alive': 0}).encode(),
            headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=120) as r:
            r.read()


def decode_utterances(model, audio, utterances, sample_rate=16000):
    """Decode each ORIGINAL-TIME crop separately; never concatenate takes.

    Whisper can collapse repeated attempts inside a single inference window
    even with condition_on_previous_text=False. Independent calls prevent that.
    """
    words, diagnostics = [], []
    for index, interval in enumerate(utterances):
        start_sample, end_sample = int(interval['start']), int(interval['end'])
        offset = start_sample / sample_rate
        end_time = end_sample / sample_rate
        utterance_id = f'utterance_{index}'
        segments, _ = model.transcribe(audio[start_sample:end_sample], language='en',
            word_timestamps=True, vad_filter=False, beam_size=5,
            condition_on_previous_text=False, suppress_tokens=[])
        utterance_words, segment_diagnostics = [], []
        for segment in segments:
            segment_diagnostics.append({'start':offset+segment.start,'end':offset+segment.end,
                'text':segment.text,'avg_logprob':segment.avg_logprob,'no_speech_prob':segment.no_speech_prob})
            if segment.no_speech_prob > 0.85:
                continue
            for word in segment.words or []:
                start, end, text = offset+float(word.start), offset+float(word.end), word.word.strip()
                if not math.isfinite(start) or not math.isfinite(end):
                    continue
                start, end = max(offset,start), min(end_time,end)
                if text and math.isfinite(start) and math.isfinite(end) and end > start:
                    utterance_words.append({'start':start,'end':end,'text':text,
                        'utterance_id':utterance_id,'probability':float(word.probability),
                        'avg_logprob':float(segment.avg_logprob),'no_speech_prob':float(segment.no_speech_prob)})
        words.extend(utterance_words)
        diagnostics.append({'id':utterance_id,'start':offset,'end':end_time,
            'text':' '.join(w['text'] for w in utterance_words),'word_count':len(utterance_words),'segments':segment_diagnostics})
        progress(f'Decoded independent utterance {index+1}/{len(utterances)} ({end_time:.1f}s source clock)', min(.99,(index+1)/max(1,len(utterances))))
    return words, diagnostics

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--language', default='en')
    args = parser.parse_args()
    if args.language and args.language.lower() not in ('en', 'english'):
        raise ValueError('The installed CUDA Whisper model is English-only. Install a multilingual Whisper model for other languages.')
    source = args.source.resolve(strict=True)
    progress('Releasing local model VRAM before CUDA transcription…', 0)
    unload_ollama()
    dirs = {p.parent for p in (Path(sys.prefix) / 'Lib/site-packages/nvidia').rglob('*.dll')}
    os.environ['PATH'] = ';'.join(map(str, dirs)) + ';' + os.environ['PATH']
    dll_handles = [os.add_dll_directory(str(p)) for p in dirs]
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import get_speech_timestamps, VadOptions
    progress('Loading cached CUDA Whisper small.en…', 0.03)
    model = WhisperModel(str(ROOT / 'work/models/whisper-small.en'),
        device='cuda', compute_type='int8_float16', num_workers=1)
    audio = decode_audio(str(source), sampling_rate=16000)
    options = VadOptions(threshold=.5,min_speech_duration_ms=100,
        min_silence_duration_ms=800,max_speech_duration_s=25,speech_pad_ms=250)
    utterances = get_speech_timestamps(audio, vad_options=options, sampling_rate=16000)
    progress(f'Found {len(utterances)} independent speech utterances; preserving retake boundaries…',.05)
    words, diagnostics = decode_utterances(model,audio,utterances)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({'device': 'cuda', 'compute_type': 'int8_float16',
        'language':'en','duration':len(audio)/16000,'transcription_mode':'independent_vad_utterances_v1',
        'utterances':diagnostics,'segments': words}, ensure_ascii=False), encoding='utf-8')
    args.out.with_name(args.out.stem+'-utterances.json').write_text(json.dumps({
        'source':str(source),'transcription_mode':'independent_vad_utterances_v1',
        'sample_rate':16000,'vad':{'min_silence_ms':800,'speech_pad_ms':250},
        'utterances':diagnostics},ensure_ascii=False,indent=2),encoding='utf-8')
    progress(f'CUDA transcription complete: {len(words)} timed words.', 1)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
