"""Key the green-screen artwork of the project screen into public/intro/.

    pip install pillow numpy imageio-ffmpeg
    python scripts/key_intro.py            # from simorgh-frontend/

Reads public/di1.png (the title) and public/videos/simorgh.mp4 (the Simorgh)
and writes public/intro/simorgh-title.webp, simorgh-flight.webm (VP9 with
alpha) and simorgh-bird-poster.webp.

The key keeps the glow. Alpha is how much greener a pixel is than it is red or
blue, measured against the screen's own green; the colour is then un-mixed
from the screen (C = aF + (1-a)K), so a half-transparent feather keeps its own
cyan instead of a green cast, and any green left over the other two channels
is spill and is taken out. The video's frame edges are feathered so the tail
and wing tips that leave the frame fade rather than stop at a line.
"""
import glob, os, subprocess, tempfile
import numpy as np
from PIL import Image
import imageio_ffmpeg

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(HERE, 'public')
OUT = os.path.join(PUBLIC, 'intro')
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()


def key_frame(rgb):
    c = rgb.astype(np.float32) / 255.0
    r, g, b = c[..., 0], c[..., 1], c[..., 2]
    d = g - np.maximum(r, b)
    border = np.concatenate([c[:8].reshape(-1, 3), c[-8:].reshape(-1, 3),
                             c[:, :8].reshape(-1, 3), c[:, -8:].reshape(-1, 3)])
    bg = np.median(border, axis=0)
    dk = bg[1] - max(bg[0], bg[2])
    hi, lo = dk * 0.78, dk * 0.18
    a = np.clip((hi - d) / (hi - lo), 0.0, 1.0)
    f = (c - (1.0 - a)[..., None] * bg.reshape(1, 1, 3)) / np.maximum(a, 1e-3)[..., None]
    f = np.clip(f, 0.0, 1.0)
    f[..., 1] = np.minimum(f[..., 1], np.maximum(f[..., 0], f[..., 2]))
    out = np.dstack([f, a]) * 255.0
    out[a <= 0.0] = 0
    return out.round().astype(np.uint8)


def ramp(n, m):
    r = np.ones(n, np.float32)
    k = np.arange(m) / m
    r[:m] = k ** 1.5
    r[-m:] = np.minimum(r[-m:], k[::-1] ** 1.5)
    return r


def main():
    os.makedirs(OUT, exist_ok=True)

    title = Image.fromarray(key_frame(np.array(Image.open(os.path.join(PUBLIC, 'di1.png')).convert('RGB'))), 'RGBA')
    title.crop((13, 182, 1674, 764)).save(os.path.join(OUT, 'simorgh-title.webp'), 'WEBP', quality=92, method=6)

    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run([FFMPEG, '-loglevel', 'error', '-y', '-i',
                        os.path.join(PUBLIC, 'videos', 'simorgh.mp4'), os.path.join(tmp, 'f%03d.png')], check=True)
        frames = sorted(glob.glob(os.path.join(tmp, 'f*.png')))
        x0, x1 = 48, 816
        h = np.array(Image.open(frames[0])).shape[0]
        mask = np.outer(ramp(h, 40), ramp(x1 - x0, 36))
        for i, path in enumerate(frames):
            k = key_frame(np.array(Image.open(path).convert('RGB'))).astype(np.float32)[:, x0:x1]
            k[..., 3] *= mask
            img = Image.fromarray(k.round().astype(np.uint8), 'RGBA')
            img.save(os.path.join(tmp, f'k{i:03d}.png'))
            if i == 0:
                img.save(os.path.join(OUT, 'simorgh-bird-poster.webp'), 'WEBP', quality=90, method=6)
        subprocess.run([FFMPEG, '-loglevel', 'error', '-y', '-framerate', '24', '-i', os.path.join(tmp, 'k%03d.png'),
                        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '38',
                        '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-an',
                        os.path.join(OUT, 'simorgh-flight.webm')], check=True)


if __name__ == '__main__':
    main()
