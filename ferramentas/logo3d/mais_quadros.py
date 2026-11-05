# Quadros intermediários de verdade para o giro lento: o RIFE cria 3 quadros entre cada par renderizado
# (o passo é de ~3° de giro, pequeno o bastante para a interpolação ficar limpa). O laço fecha: o último quadro
# interpola até o primeiro. Faz a cor (rgb/) e o recorte (sil/, o alfa vira cinza para o RIFE e volta a alfa).
# Uso: python mais_quadros.py <gel|couvert> [fator=4]
import os, sys, shutil, subprocess, tempfile
from PIL import Image

AQUI = os.path.dirname(os.path.abspath(__file__))
RIFE = os.path.join(AQUI, "..", "rife-ncnn-vulkan-20221029-windows", "rife-ncnn-vulkan.exe")
preset = sys.argv[1]
K = int(sys.argv[2]) if len(sys.argv) > 2 else 4
base = os.path.join(AQUI, preset)
n = len(os.listdir(f"{base}/rgb"))
for parte in ("rgb", "sil"):
    tmp = tempfile.mkdtemp()
    ent, sai = os.path.join(tmp, "in"), os.path.join(tmp, "out")
    os.makedirs(ent); os.makedirs(sai)
    for i in range(n + 1):  # o n-ésimo é o primeiro de novo: o laço fecha
        im = Image.open(f"{base}/{parte}/{i % n:04d}.png")
        im = im.convert("RGB") if parte == "rgb" else im.getchannel("A").convert("RGB")
        im.save(f"{ent}/{i:05d}.png")
    subprocess.run([RIFE, "-m", os.path.join(os.path.dirname(RIFE), "rife-v4.6"), "-i", ent, "-o", sai, "-n", str(n * K + 1)], check=True, capture_output=True)
    outs = sorted(os.listdir(sai))[: n * K]  # o último é o primeiro de novo
    dest = f"{base}/{parte}-x{K}"
    shutil.rmtree(dest, ignore_errors=True); os.makedirs(dest)
    for j, f in enumerate(outs):
        im = Image.open(os.path.join(sai, f))
        if parte == "sil":
            a = im.convert("L"); im = Image.new("RGBA", a.size, (255, 255, 255, 0)); im.putalpha(a)
        im.save(f"{dest}/{j:04d}.png")
    shutil.rmtree(tmp)
    print(preset, parte, n, "->", len(outs))
