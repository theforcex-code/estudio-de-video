# Travar fundo: o cenário vem de uma imagem parada (o fundo limpo do ato) e, do vídeo gerado, só entram os elementos
# (vidro, fitas, esferas, metal), seguidos pelo SAM2 a partir do contorno exato deles no primeiro e no último quadro.
# O cenário pode ganhar um movimento natural feito aqui: vento na grama ou água ondulando (sem mexer a câmera).
# Chamado pelo nó "Travar fundo". Uso: python travar.py '<json>'
#   video, fundo, inicio, fim, saida: caminhos. inicio/fim: os elementos do começo e do fim — PNG transparente (camada do
#   Codex) ou a parede inteira (aí o contorno é o que difere do fundo limpo).
#   movimento: "grama" | "agua" | "nenhum". indice/total: a posição da troca no laço (o movimento fecha o laço).
#   largura: largura da saída (a altura segue a proporção do vídeo). horizonte: fração da altura (0,43).
import sys, os, re, json, shutil, subprocess, tempfile, numpy as np, cv2, torch
from PIL import Image
from sam2.build_sam import build_sam2_video_predictor
AQUI = os.path.dirname(os.path.abspath(__file__))
FF = os.path.join(AQUI, "..", "..", "..", "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe")
FER = os.path.join(AQUI, "..")
A = json.loads(sys.argv[1])
vid, out = A["video"], A["saida"]
MOV, IDX, TOT = A.get("movimento", "nenhum"), int(A.get("indice", 0)), max(1, int(A.get("total", 1)))
HZF = float(A.get("horizonte", 0.43))
info = subprocess.run([FF, "-hide_banner", "-i", vid], capture_output=True, text=True).stderr
W, H = map(int, re.search(r"(\d{3,5})x(\d{2,4})", info.split("Video:")[1]).groups())
OW = int(A.get("largura", 6410)) // 2 * 2
OH = int(round(OW * H / W)) // 2 * 2
fundoG = Image.open(A["fundo"]).convert("RGB")
tmp = tempfile.mkdtemp()
subprocess.run([FF, "-loglevel", "error", "-i", vid, "-q:v", "2", "-start_number", "0", f"{tmp}/%05d.jpg"], check=True)
N = len(os.listdir(tmp))
print(f"progresso 0 {N}", flush=True)

def contorno(caminho):
    """Máscara dos elementos no tamanho do vídeo: alfa do PNG transparente, ou o que difere do fundo limpo."""
    im = Image.open(caminho)
    if im.mode in ("RGBA", "LA") and np.asarray(im.getchannel("A")).min() < 250:
        m = np.asarray(im.getchannel("A").resize((W, H), Image.BILINEAR)) > 80
    else:
        a = np.asarray(im.convert("RGB").resize((W, H), Image.LANCZOS), np.float32)
        b = np.asarray(fundoG.resize((W, H), Image.LANCZOS), np.float32)
        d = np.abs(cv2.GaussianBlur(a, (0, 0), 1.5) - cv2.GaussianBlur(b, (0, 0), 1.5)).sum(2)
        m = d > 45
    m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m)
    keep = np.zeros_like(m)
    for i in range(1, n):
        if st[i, 4] >= max(40, W * H // 20000): keep[lab == i] = 1
    return keep.astype(bool)

pr = build_sam2_video_predictor("configs/sam2.1/sam2.1_hiera_l.yaml", f"{FER}/modelos/sam2.1_hiera_large.pt", device="cuda")
M = np.zeros((N, H, W), np.float32)
with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
    st = pr.init_state(video_path=tmp)
    ma, mb = contorno(A["inicio"]), contorno(A["fim"])
    if ma.any(): pr.add_new_mask(st, frame_idx=0, obj_id=1, mask=ma)
    if mb.any(): pr.add_new_mask(st, frame_idx=N - 1, obj_id=2, mask=mb)
    for rev in (False, True):
        for fi, ids, logits in pr.propagate_in_video(st, reverse=rev):
            for j in range(len(ids)):
                M[fi] = np.maximum(M[fi], (logits[j, 0] > 0).float().cpu().numpy())
shutil.rmtree(tmp)
M = np.stack([cv2.GaussianBlur(cv2.dilate(m, np.ones((3, 3), np.uint8)), (0, 0), 1.2) for m in M])
k = 2; Mp = np.pad(M, ((k, k), (0, 0), (0, 0)), mode="edge"); M = np.stack([Mp[i:i + 2 * k + 1].mean(0) for i in range(N)])
print(f"progresso {N // 3} {N}", flush=True)

fundo = np.asarray(fundoG.resize((OW, OH), Image.LANCZOS), np.float32) / 255
HZ = int(OH * HZF)
yy, xx = np.mgrid[0:OH, 0:OW].astype(np.float32)
prof = np.clip((yy - HZ - 4) / (OH - HZ), 0, 1)
s = OW / 2560                                             # amplitudes pensadas para 2560 px de largura
rng = np.random.default_rng(7)
fase = cv2.GaussianBlur(rng.standard_normal((OH, OW)).astype(np.float32), (0, 0), 6 * s) * 25
TT = TOT * N

def cenario(i):
    if MOV == "nenhum":
        return fundo
    t = (IDX * N + i) / TT
    if MOV == "grama":   # rajadas da esquerda para a direita; a grama da frente balança mais
        amp = s * (0.4 + 3.2 * prof ** 1.3) * (yy > HZ + 2)
        g = (np.sin(2 * np.pi * (xx / (900 * s) - 6 * TOT / 3 * t)) * 0.5 + 0.5) ** 2
        dx = amp * (0.35 + 0.65 * g) * np.sin(2 * np.pi * (xx / (140 * s) - 24 * TOT / 3 * t) + fase)
        dy = amp * 0.25 * np.cos(2 * np.pi * (xx / (140 * s) - 24 * TOT / 3 * t) + fase)
        img = cv2.remap(fundo, xx + dx, yy + dy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        return img * (1 + 0.04 * (g[..., None] - 0.5) * (prof[..., None] > 0))
    # água: ondinhas que correm devagar, mais largas perto da borda de baixo; o céu parado
    amp = s * (0.3 + 2.2 * prof ** 1.2) * (yy > HZ + 1)
    dy = amp * np.sin(2 * np.pi * (yy / (14 * s + 30 * s * prof) - 12 * TOT / 3 * t) + fase * 0.3)
    dx = amp * 0.6 * np.sin(2 * np.pi * (xx / (320 * s) - 8 * TOT / 3 * t) + fase)
    return cv2.remap(fundo, xx + dx, yy + dy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)

dec = subprocess.Popen([FF, "-loglevel", "error", "-i", vid, "-vf", f"scale={OW}:{OH}:flags=lanczos", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
enc = subprocess.Popen([FF, "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{OW}x{OH}", "-r", "24", "-i", "-",
                        "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], stdin=subprocess.PIPE)
for i in range(N):
    b = dec.stdout.read(OW * OH * 3)
    if len(b) < OW * OH * 3: break
    f = np.frombuffer(b, np.uint8).reshape(OH, OW, 3).astype(np.float32) / 255
    m = cv2.resize(M[i], (OW, OH), interpolation=cv2.INTER_LINEAR)[..., None]
    o = cenario(i) * (1 - m) + f * m
    enc.stdin.write((np.clip(o, 0, 1) * 255).astype(np.uint8).tobytes())
    if i % 12 == 0: print(f"progresso {N // 3 + i * 2 // 3} {N}", flush=True)
enc.stdin.close(); enc.wait()
print(f"ok {N} {OW}x{OH}", flush=True)
