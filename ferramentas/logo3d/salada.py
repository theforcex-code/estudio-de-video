# Salada: a pérola translúcida furta-cor girando no lugar do anel, nas 3 paredes já sem o anel.
# Uma volta = 5 s, 30 q/s, na resolução da parede (6410 × 1150). Sai em videos-gerados/logo-salada-N.mp4.
# Uso: python salada.py [paredes, ex.: 1,2,3] [velocidade=1]
import os, sys, subprocess, numpy as np
from PIL import Image, ImageFilter

AQUI = os.path.dirname(os.path.abspath(__file__))
FF = os.path.join(AQUI, "..", "..", "..", "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe")
V = os.path.join(AQUI, "..", "..", "..", "videos-gerados")
P = os.path.join(AQUI, "salada")
paredes = [int(x) for x in (sys.argv[1] if len(sys.argv) > 1 else "1,2,3").split(",")]
VEL = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
W, H, FPS, VOLTA = 6410, 1150, 30, 5.0
CX, CY, LH = 5477, 416, 731           # o anel das paredes da Salada (medido nas máscaras)
L = int(round(LH * 1254 / 964))
x0, y0 = CX - L // 2, CY - L // 2
N = len(os.listdir(f"{P}/rgb-480"))
cache = {}

def get(i):
    if i not in cache:
        rgb = np.array(Image.open(f"{P}/rgb-480/{i:04d}.png").convert("RGB").resize((L, L), Image.LANCZOS), np.float32) / 255
        al = Image.open(f"{P}/sil-480/{i:04d}.png").getchannel("A").resize((L, L), Image.LANCZOS).filter(ImageFilter.GaussianBlur(0.8))
        cache[i] = (rgb, np.array(al, np.float32)[..., None] / 255)
    return cache[i]

FR = int(round(VOLTA * FPS / VEL))  # quadros do vídeo = uma volta
for k in paredes:
    fundo = np.array(Image.open(f"{AQUI}/salada-sem-anel/salada-{k}-sem-anel.png").convert("RGB"), np.float32) / 255
    out = os.path.join(V, f"logo-salada-{k}.mp4")
    enc = subprocess.Popen([FF, "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                            "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], stdin=subprocess.PIPE)
    xs, ys, xe, ye = max(0, x0), max(0, y0), min(W, x0 + L), min(H, y0 + L)
    for f in range(FR):
        pos = (f / FR) * N
        i0 = int(pos) % N; w = pos - int(pos)
        a, b = get(i0), get((i0 + 1) % N)
        rgb, al = (a[0] * (1 - w) + b[0] * w, a[1] * (1 - w) + b[1] * w) if w > 1e-3 else a
        F = fundo.copy()
        reg = F[ys:ye, xs:xe]
        lr, la = rgb[ys - y0:ye - y0, xs - x0:xe - x0], al[ys - y0:ye - y0, xs - x0:xe - x0]
        F[ys:ye, xs:xe] = reg * (1 - la) + lr * la
        enc.stdin.write((np.clip(F, 0, 1) * 255).round().astype(np.uint8).tobytes())
    enc.stdin.close(); enc.wait()
    print("ok", out, FR, "quadros")
