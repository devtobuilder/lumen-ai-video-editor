import importlib.util
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path
import numpy as np

spec=importlib.util.spec_from_file_location('native_audio',Path(__file__).with_name('native_audio.py'))
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)

class DeesserTests(unittest.TestCase):
    def test_reduces_sibilant_band_without_dulling_low_voice_or_changing_clock(self):
        rate=48000;n=rate*2;t=np.arange(n)/rate
        noise=np.random.default_rng(11).normal(size=n)
        bins=np.fft.rfftfreq(n,1/rate);spectrum=np.fft.rfft(noise);spectrum[(bins<5500)|(bins>10000)]=0
        ess=np.fft.irfft(spectrum,n);ess=ess/max(abs(ess))
        mask=((t>.35)&(t<.8))|((t>1.15)&(t<1.65))
        x=.12*np.sin(2*np.pi*220*t)+.45*ess*mask
        with tempfile.TemporaryDirectory() as tmp:
            src=Path(tmp)/'input.wav';dst=Path(tmp)/'output.wav'
            with wave.open(str(src),'wb') as f:
                f.setnchannels(1);f.setsampwidth(2);f.setframerate(rate);f.writeframes((x*32767).astype('<i2').tobytes())
            filt,_=worker.deesser_filter('balanced')
            subprocess.run([worker.FFMPEG,'-y','-v','error','-i',str(src),'-af',filt,'-c:a','pcm_s16le',str(dst)],check=True)
            with wave.open(str(dst),'rb') as f:
                self.assertEqual(f.getnframes(),n);self.assertEqual(f.getframerate(),rate)
                y=np.frombuffer(f.readframes(n),dtype='<i2')/32767
            X=abs(np.fft.rfft(x))**2;Y=abs(np.fft.rfft(y))**2
            high=(bins>=5500)&(bins<=10000);low=(bins>=150)&(bins<=1000)
            reduction=10*np.log10(Y[high].sum()/X[high].sum())
            voice=10*np.log10(Y[low].sum()/X[low].sum())
            self.assertLess(reduction,-1)
            self.assertGreater(voice,-.5)
            self.assertLess(abs(y).max(),1)
    def test_strengths_are_conservative_and_invalid_strength_does_not_silently_fallback(self):
        self.assertEqual(worker.deesser_filter('gentle')[1],.2)
        self.assertEqual(worker.deesser_filter('balanced')[1],.35)
        self.assertEqual(worker.deesser_filter('strong')[1],.5)
        with self.assertRaises(KeyError):worker.deesser_filter('unknown')

if __name__=='__main__':unittest.main()
