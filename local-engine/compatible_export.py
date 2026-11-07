"""Local MP4 compatibility finishing; preserves audio and exact frame timestamps."""
import argparse
from fractions import Fraction
import av

def convert(source, destination):
    with av.open(source) as inp, av.open(destination, 'w', options={'movflags': '+faststart'}) as out:
        vin = inp.streams.video[0]
        rate = vin.average_rate or Fraction(30, 1)
        v = out.add_stream('libx264', rate=rate)
        v.width, v.height = vin.codec_context.width, vin.codec_context.height
        v.pix_fmt = 'yuv420p'
        v.options = {'crf': '18', 'preset': 'fast', 'profile': 'high', 'level': '4.1', 'x264-params': 'keyint=60:min-keyint=30:open-gop=0'}
        aud = {s.index: out.add_stream_from_template(s) for s in inp.streams.audio}
        for packet in inp.demux():
            if packet.stream.type == 'video':
                for frame in packet.decode():
                    for encoded in v.encode(frame):
                        out.mux(encoded)
            elif packet.dts is not None and packet.stream.index in aud:
                packet.stream = aud[packet.stream.index]
                out.mux(packet)
        for encoded in v.encode():
            out.mux(encoded)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('destination')
    args = parser.parse_args()
    convert(args.source, args.destination)
