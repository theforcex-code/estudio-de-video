# Logo 3D girando (render do Blender) por cima de um vídeo do estúdio. Chamado pelo nó "Logo 3D".
# Uso: python logo3d.py <gel|perola|salada|couvert> <entrada.mp4> <saida.mp4> [ajustes JSON]
#  salada:  paredes da Salada (6410×1150). A pérola translúcida furta-cor no lugar do anel, NA FRENTE de tudo.
#  gel:     paredes de gel (faixa 5,67:1). O logo rosado fica no lugar da Forma, ATRÁS das fitas: a fita rosa
#           (pela cor) e os brilhos das transparentes voltam por cima; o corpo transparente deixa o logo aparecer.
#  couvert: paredes azuis (2676×480). No lugar da Forma antiga entra o próprio quadro deslocado 420 px (água e
#           céu se mexendo como o resto), e por cima o logo azul com reflexo ondulado na água.
# Ajustes opcionais (5º argumento, JSON): velocidade (1 = uma volta a cada 5 s), inicio (0–1 da volta),
# tamanho (1 = o da Forma), dx e dy (deslocamento, em fração da largura e da altura).
# Imprime "progresso <quadro> <total>" de tempos em tempos.
import sys, os, re, math, json, subprocess, numpy as np, cv2
from PIL import Image, ImageFilter

AQUI = os.path.dirname(os.path.abspath(__file__))
FF = os.path.join(AQUI, "..", "..", "..", "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe")
preset, inp, outp = sys.argv[1], sys.argv[2], sys.argv[3]
AJ = json.loads(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else {}
VEL = float(AJ.get("velocidade", 1)); INI = float(AJ.get("inicio", 0)); TAM = float(AJ.get("tamanho", 1))
DX, DY = float(AJ.get("dx", 0)), float(AJ.get("dy", 0))
if AJ.get("estilo") == "diamante":  # pelo estúdio: o preset "diamante" vem como ajuste
    preset = "diamante"
FRENTE = bool(AJ.get("frente", False))  # o logo na frente de tudo: os elementos passam atrás dele
# "mascara": máscaras (.npy, quadros × altura × largura, 0/1) dos elementos que passam NA FRENTE do logo, feitas por
# fora (ex.: SAM2 seguindo as pétalas); "mascara_passo": quantos quadros deste vídeo cada máscara cobre.
MASC = np.load(AJ["mascara"], mmap_mode="r") if AJ.get("mascara") else None
MPASSO = float(AJ.get("mascara_passo", 1))


TEMPO = None  # tabela do ritmo visual da volta (ver ritmo()); None = giro em ângulo constante


def ritmo(dirn):
    """O ângulo do render é constante, mas de frente o logo quase não muda de um quadro para o outro e de
    lado muda muito: no lento parece travar e depois pular. Mede quanto cada passo muda na imagem (cor
    dentro do recorte + recorte) e devolve a posição acumulada (0..n) de cada fração da volta, para o giro
    andar com mudança visual constante. Fica salvo em <pasta>/ritmo-<rgb>.npy."""
    rd, sd = SUB(dirn)
    arq = f"{dirn}/ritmo-{rd}.npy"
    if os.path.exists(arq):
        return np.load(arq)
    n = len(os.listdir(f"{dirn}/{rd}"))
    def le(i):
        rgb = np.array(Image.open(f"{dirn}/{rd}/{i:04d}.png").convert("RGB").resize((160, 160)), np.float32) / 255
        al = np.array(Image.open(f"{dirn}/{sd}/{i:04d}.png").getchannel("A").resize((160, 160)), np.float32) / 255
        return rgb * al[..., None], al
    q = [le(i) for i in range(n)]
    d = np.array([np.abs(q[i][0] - q[(i + 1) % n][0]).mean() + np.abs(q[i][1] - q[(i + 1) % n][1]).mean() for i in range(n)])
    k = max(3, n // 40) | 1  # suaviza em volta (o laço fecha)
    d = np.convolve(np.concatenate([d[-k:], d, d[:k]]), np.ones(k) / k, "same")[k:-k]
    d = np.maximum(d, 0.12 * d.mean())  # nunca dispara nas partes em que quase nada muda
    c = np.concatenate([[0], np.cumsum(d)]); c /= c[-1]
    np.save(arq, c)
    return c


def quadro(t, n, get):
    """Quadro do giro no instante t (em quadros de 24 q/s). Uma volta = 5 s (120 quadros do vídeo) em 1×,
    qualquer que seja o número de quadros renderizados n; entre dois quadros vizinhos, mistura."""
    u = (INI + t * VEL / 120) % 1
    pos = (np.interp(u, TEMPO, np.arange(n + 1)) if TEMPO is not None and len(TEMPO) == n + 1 else u * n) % n
    i0 = int(math.floor(pos)) % n
    i1, w = (i0 + 1) % n, pos - math.floor(pos)
    a, b = get(i0), get(i1)
    if w < 1e-3:
        return a, i0
    return tuple(x * (1 - w) + y * w for x, y in zip(a, b)), i0

info = subprocess.run([FF, "-hide_banner", "-i", inp], capture_output=True, text=True).stderr
W, H = map(int, re.search(r"(\d{3,5})x(\d{2,4})", info.split("Video:")[1]).groups())
dur = re.search(r"Duration: (\d+):(\d+):([\d.]+)", info)
TOTAL = int(round((int(dur[1]) * 3600 + int(dur[2]) * 60 + float(dur[3])) * 24)) if dur else 0
if preset == "couvert" and abs(W / H - 6410 / 1150) < 0.3:  # paredes novas do Couvert (sem o anel): logo no lugar dele
    preset = "couvert2"
if preset == "couvert":  # as medidas do couvert são em 2676×480
    PW, PH = 2676, 480
else:
    PW, PH = W, H

dec = subprocess.Popen([FF, "-hide_banner", "-loglevel", "error", "-i", inp, "-vf", f"scale={PW}:{PH},fps=24", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
enc = subprocess.Popen([FF, "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{PW}x{PH}", "-r", "24", "-i", "-",
                        "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "15", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outp], stdin=subprocess.PIPE)


# Quadros do giro: se houver uma volta renderizada com mais quadros (rgb-480/sil-480 etc.) e completa, usa
# ela (giro lento suave, cada quadro é uma posição real); senão, a volta original de ~120 quadros.
def SUB(dirn):
    for d in sorted(os.listdir(dirn), reverse=True):
        if d.startswith("rgb-") and d[4:].isdigit():
            n = int(d[4:])
            sd = f"sil-{n}"
            if os.path.isdir(f"{dirn}/{sd}") and len(os.listdir(f"{dirn}/{d}")) == n and len(os.listdir(f"{dirn}/{sd}")) == n:
                return d, sd
    return "rgb", "sil"


def load(dirn, i, size):
    rd, sd = SUB(dirn)
    rgb = np.array(Image.open(f"{dirn}/{rd}/{i:04d}.png").convert("RGB").resize((size, size), Image.LANCZOS), np.float32) / 255
    al = Image.open(f"{dirn}/{sd}/{i:04d}.png").getchannel("A").resize((size, size), Image.LANCZOS).filter(ImageFilter.GaussianBlur(0.6))
    return rgb, np.array(al, np.float32)[..., None] / 255


# ---------- gel ----------
if preset == "diamante":  # Sobremesa: o vidro do Couvert virado diamante na composição (sem render novo)
    FRENTE = True
if preset in ("gel", "perola", "salada", "risoto", "prato", "couvert2", "diamante"):  # pérola rosé: mesma posição e montagem do gel (atrás das fitas)
    # couvert2: as paredes novas do Couvert (6410×1150, horizonte 32%), no lugar do anel de vidro que foi tirado delas
    G = os.path.join(AQUI, "couvert" if preset in ("couvert2", "diamante") else preset)
    if AJ.get("pasta"):  # outro render do mesmo logo (ex.: "gel-petalas": o gel iluminado pela cena das pétalas)
        G = os.path.join(AQUI, os.path.basename(str(AJ["pasta"])))
    sx, sy = W / 6410, H / 1150  # gel: lugar da Forma na parede 2 (6410×1150), centro (5465, 438), altura 782
    PX, PY, PH_ = {"salada": (5477, 416, 731), "risoto": (5450, 417, 697), "prato": (5450, 420, 697), "couvert2": (5445, 352, 640), "diamante": (5465, 425, 720)}.get(preset, (5465, 438, 782))  # salada/risoto: lugar do anel
    CX, CY, LH = PX * sx + DX * W, PY * sy + DY * H, PH_ * sy
    L = max(8, int(round(LH * 1254 / 964 * TAM)))
    x0, y0 = int(round(CX - L / 2)), int(round(CY - L / 2))
    N = len(os.listdir(f"{G}/{SUB(G)[0]}"))
    TEMPO = ritmo(G)
    # Reflexo na água: o logo espelhado logo abaixo dele, ondulando e sumindo para baixo, só da linha do horizonte
    # para baixo (horizonte de cada ato, na parede 6410×1150). A Salada é grama: sem reflexo. "reflexo": 0 desliga.
    HZW = {"gel": 505, "perola": 505, "risoto": 495, "prato": 495, "couvert2": 372, "diamante": 600}.get(preset)
    REFL = HZW is not None and float(AJ.get("reflexo", 1)) > 0
    HZ_ = HZW * sy if REFL else 0
    # espelho: o salar do Prato é um espelho d'água quase parado (reflexo forte e pouco ondulado); mar e lago ondulam mais
    ESP_FORCA, ESP_FIM, ESP_ONDA = {"prato": (0.8, 0.9, 0.35), "couvert2": (0.65, 0.6, 1.0)}.get(preset, (0.6, 0.55, 1.0))
    # região de trabalho: o quadrado do logo e, com reflexo, mais uma altura dele embaixo
    XS, YS, XE, YE = max(0, x0), max(0, y0), min(W, x0 + L), min(H, y0 + L + (L if REFL else 0))

    def amostras(n=120):
        """n quadros espalhados pelo vídeo, só a região do logo (RGB 0..1)."""
        cap = cv2.VideoCapture(inp); tot = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)); out = []
        for i in np.linspace(0, max(0, tot - 1), n).astype(int):
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(i)); ok, Fr = cap.read()
            if ok:
                out.append(cv2.cvtColor(cv2.resize(Fr, (W, H)), cv2.COLOR_BGR2RGB)[YS:YE, XS:XE].astype(np.float32) / 255)
        cap.release()
        return np.stack(out)

    PLATE = None
    if preset == "prato":  # fundo limpo do ato (sem metal), no tamanho do vídeo: o metal cobre a região muitas vezes
        PLATE = np.asarray(Image.open(f"{G}/fundo-limpo.png").convert("RGB").resize((W, H), Image.LANCZOS), np.float32)[YS:YE, XS:XE] / 255
    elif preset == "salada":  # fundo travado: a mediana dos quadros é o próprio fundo, pixel a pixel
        PLATE = np.median(amostras(), 0).astype(np.float32)
    elif preset == "risoto":  # fitas douradas sobre céu e mar azulados: o "calor" (R−B) mais baixo de cada ponto é o fundo
        a = amostras(); BASE = cv2.GaussianBlur(np.percentile(a[..., 0] - a[..., 2], 15, axis=0).astype(np.float32), (0, 0), 3)
    cache = {}

    def diamante(lr, la, reg, t):
        """O render de vidro vira diamante: o fundo visto através com refração (desvio pelas bordas do vidro), as
        arestas e os reflexos em branco forte com um leve arco-íris nas bordas, um halo de luz e estrelas de brilho
        que piscam nos pontos mais claros."""
        hb, wb = la.shape[:2]
        Lr = lr.mean(2)
        a = la[..., 0]
        gx = cv2.Sobel(cv2.GaussianBlur(Lr, (0, 0), 1.5), cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(cv2.GaussianBlur(Lr, (0, 0), 1.5), cv2.CV_32F, 0, 1, ksize=3)
        k = L / 40.0
        yy, xx = np.mgrid[0:hb, 0:wb].astype(np.float32)
        visto = cv2.remap(reg, xx + gx * k * a, yy + gy * k * a, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        # corpo: metade a cena vista através, metade o próprio vidro do render (cinza claro, levemente frio): fica
        # transparente mas com presença, sem virar um fantasma
        vidro = np.repeat(np.clip(Lr * 1.15, 0, 1)[..., None], 3, 2) * np.array([0.96, 0.98, 1.0], np.float32)
        corpo = visto * 0.5 + vidro * 0.5
        hi = np.clip((Lr - 0.5) / 0.4, 0, 1) ** 1.8 * a
        sh = max(1, int(round(L / 300)))
        disp = np.stack([np.roll(hi, sh, 1), hi, np.roll(hi, -sh, 1)], 2)         # leve arco-íris nas arestas
        corpo = corpo + disp * 0.9
        glow = cv2.GaussianBlur(hi, (0, 0), max(1.0, L / 90))[..., None] * np.array([0.22, 0.22, 0.25], np.float32)
        # brilhinhos de estrela: um ou dois por vez, cada um acende e apaga em ~1,3 s num ponto de brilho do vidro
        # (o ponto acompanha o reflexo enquanto o logo gira); raios finos que afinam, os diagonais menores
        sm = cv2.GaussianBlur(hi, (0, 0), 2)
        cand, tmp = [], sm.copy()
        for j in range(4):
            y, x = np.unravel_index(np.argmax(tmp), tmp.shape)
            if tmp[y, x] < 0.35: break
            cand.append((x, y)); r = int(L / 10); tmp[max(0, y - r):y + r, max(0, x - r):x + r] = 0
        est = np.zeros((hb, wb), np.float32)
        DUR, PASSO = 32, 18
        for e in range(int(t // PASSO) - 2, int(t // PASSO) + 1):
            if e < 0 or not cand: continue
            f = (t - e * PASSO) / DUR
            if not 0 < f < 1: continue
            env = math.sin(math.pi * f) ** 2
            x, y = cand[(e * 7) % len(cand)]
            R = L / 11 * (0.7 + 0.3 * env)
            dx, dy = xx - x, yy - y
            ax, ay = np.abs(dx), np.abs(dy)
            raio = np.exp(-ay / 0.6) * np.exp(-(ax / R) ** 1.3) + np.exp(-ax / 0.6) * np.exp(-(ay / R) ** 1.3)
            d1, d2 = np.abs(dx + dy) / 1.414, np.abs(dx - dy) / 1.414
            diag = (np.exp(-d1 / 0.6) * np.exp(-(d2 / (R * 0.45)) ** 1.3) + np.exp(-d2 / 0.6) * np.exp(-(d1 / (R * 0.45)) ** 1.3)) * 0.5
            nucleo = np.exp(-(dx * dx + dy * dy) / (2 * (L / 70) ** 2))
            est += env * (raio * 0.9 + diag + nucleo * 1.2)
        glow = glow + est[..., None] * np.array([1.0, 0.98, 0.94], np.float32)
        return np.clip(corpo, 0, 1), glow

    def fitas(reg):
        hsv = cv2.cvtColor((reg * 255).astype(np.uint8), cv2.COLOR_RGB2HSV).astype(np.float32)
        h, s, v = hsv[..., 0] * 2, hsv[..., 1] / 255, hsv[..., 2] / 255
        rosa = ((h < 18) | (h > 320)).astype(np.float32) * np.clip((s - 0.12) / 0.2, 0, 1) * np.clip((v - 0.35) / 0.2, 0, 1)
        brilho = np.clip((v - 0.86) / 0.1, 0, 1) * np.clip((0.35 - s) / 0.2, 0, 1)
        return cv2.GaussianBlur(np.maximum(rosa * 0.9, brilho), (0, 0), 0.8)[..., None]

    def compor(F, t):
        def get(i):
            if i not in cache:
                cache[i] = load(G, i, L)
            return cache[i]
        (rgb, al), _ = quadro(t, N, get)
        xs, ys, xe, ye = XS, YS, XE, YE
        reg = F[ys:ye, xs:xe]
        hb, wb = ye - ys, xe - xs
        lr = np.zeros((hb, wb, 3), np.float32); la = np.zeros((hb, wb, 1), np.float32)
        ly = min(hb, y0 + L - ys)  # o quadrado do logo dentro da região
        lr[:ly] = rgb[ys - y0:ys - y0 + ly, xs - x0:xe - x0]; la[:ly] = al[ys - y0:ys - y0 + ly, xs - x0:xe - x0]
        GLOW = None
        if preset == "diamante":
            lr, GLOW = diamante(lr, la, reg, t)
        comp = reg
        if REFL:
            rows = np.nonzero(la[..., 0].max(1) > 0.3)[0]
            if len(rows):
                ax = rows[-1] + 1                       # pé do logo: o espelho começa logo abaixo dele
                rr = np.zeros_like(lr); ra = np.zeros_like(la); xi = np.arange(wb)
                for r in range(ax, hb):
                    dd = r - ax; src = ax - 1 - dd
                    if src < 0 or ys + r < HZ_:
                        if src < 0: break
                        continue
                    amp = (1.5 + dd * 0.06) * L / 600 * ESP_ONDA
                    # a ondulação acompanha o tamanho do logo (em vídeos grandes, a mesma conta por linha dava um serrilhado)
                    dq = dd * 600 / L
                    dx = amp * math.sin(dq * 0.35 + t * 0.21) + 0.6 * amp * math.sin(dq * 0.9 - t * 0.33)
                    sxi = np.clip((xi - dx).round().astype(int), 0, wb - 1)
                    rr[r] = lr[src, sxi]; ra[r] = la[src, sxi] * (ESP_FORCA * math.exp(-dd / (ESP_FIM * L)))
                rr = cv2.GaussianBlur(rr, (0, 0), 0.8); ra = cv2.GaussianBlur(ra[..., 0], (0, 0), 1.0)[..., None]
                # a cor do próprio logo, só um pouco mais escura (a água absorve), sem misturar com o fundo (ficava leitosa)
                comp = comp * (1 - ra) + rr * 0.88 * ra
                la_r = ra
            else:
                la_r = np.zeros_like(la)
        else:
            la_r = np.zeros_like(la)
        comp = comp * (1 - la) + lr * la
        if GLOW is not None:
            comp = 1 - (1 - comp) * (1 - np.clip(GLOW, 0, 1))  # brilho somado como luz (screen)
        if MASC is not None:
            u = min(t / MPASSO, len(MASC) - 1.001); i0 = int(u); w = u - i0
            m = MASC[i0].astype(np.float32) * (1 - w) + MASC[min(i0 + 1, len(MASC) - 1)].astype(np.float32) * w
            if m.shape != (H, W): m = cv2.resize(m, (W, H))
            g = cv2.GaussianBlur(m[ys:ye, xs:xe], (0, 0), 1.0)[..., None]
            F[ys:ye, xs:xe] = comp * (1 - g) + reg * g
            return F
        if FRENTE:
            F[ys:ye, xs:xe] = comp
            return F
        k = max(3, int(round(L / 90)) | 1)
        if preset == "risoto":
            # O anel de fios de ouro passa ATRÁS das fitas de seda e ouro: fita é o que está mais "quente" (R−B) que o
            # fundo daquele ponto. Elas voltam por cima a 90%, para o anel ainda brilhar um pouco através da seda.
            wr = cv2.GaussianBlur(reg[..., 0] - reg[..., 2], (0, 0), 1.0)
            # só as fitas grossas e cheias (a seda) passam na frente; os fios finos de ouro ficam atrás do anel
            # (antes eles cobriam metade do anel o tempo todo e ele parecia sumir)
            g = np.clip((wr - BASE - 0.22) / 0.12, 0, 1).astype(np.float32)
            kk = max(5, int(round(L / 25)) | 1)
            g = cv2.morphologyEx(g, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kk, kk)))
            g = cv2.GaussianBlur(g, (0, 0), 1.2)[..., None] * 0.85
            F[ys:ye, xs:xe] = comp * (1 - g) + reg * g
            return F
        if preset in ("salada", "prato"):
            # A Forma fica ATRÁS dos elementos, quadro a quadro: elemento é o que difere do fundo limpo do ato. Ele volta
            # por cima do logo — o vidro da Salada 85% (deixa ver um pouco atrás), o metal do Prato inteiro. As linhas
            # finas do horizonte (o vídeo não bate pixel a pixel com o fundo) saem num filtro vertical. Se o fundo do
            # quadro não bate com o limpo (cena diferente), o logo fica na frente, para não sumir à toa.
            pl = PLATE
            d = np.abs(cv2.GaussianBlur(reg, (0, 0), 1.2) - cv2.GaussianBlur(pl, (0, 0), 1.2)).sum(2)
            lim, ini, fx, opac = (0.06, 0.10, 0.12, 0.85) if preset == "salada" else (0.14, 0.18, 0.15, 1.0)
            if np.median(d[la[..., 0] < 0.02]) < lim:
                g = np.clip((d - ini) / fx, 0, 1).astype(np.float32)
                g = cv2.morphologyEx(g, cv2.MORPH_OPEN, np.ones((k, 1), np.uint8))       # tira as linhas do horizonte
                g = cv2.GaussianBlur(cv2.dilate(g, np.ones((3, 3), np.uint8)), (0, 0), 1.2)[..., None] * opac
                comp = comp * (1 - g) + reg * g
            F[ys:ye, xs:xe] = comp
            return F
        if preset == "couvert2":  # as esferas ficam longe do logo: nada passa na frente
            F[ys:ye, xs:xe] = comp
            return F
        fa = fitas(reg) * ((la + la_r) > 0.02)
        F[ys:ye, xs:xe] = comp * (1 - fa) + reg * fa
        return F

# ---------- couvert ----------
else:
    C = os.path.join(AQUI, "couvert")
    X0, SW, HZ = 1990, 620, 197                   # faixa da Forma e horizonte
    WL = 321                                      # linha da água (na faixa)
    L = max(8, int(round(392 * TAM)))             # quadro do logo; o pé continua na água ao mudar o tamanho
    CX = int(round(310 + DX * PW))
    CY = int(round(WL - L * 964 / 1254 / 2 + DY * PH))
    HA, HB, SH, FE = 2090, 2510, 420, 28          # buraco da Forma antiga e deslocamento
    BR = np.load(f"{C}/brilho.npy")
    N = len(os.listdir(f"{C}/{SUB(C)[0]}"))
    TEMPO = ritmo(C)
    xs_ = np.arange(HA - FE, HB + FE)
    al_b = np.clip(np.minimum(xs_ - (HA - FE), (HB + FE) - xs_) / FE, 0, 1)[None, :, None]
    u = ((xs_ - HA) / (HB - HA)).clip(0, 1)[None, :, None]
    cache = {}

    def layer(i):
        if i not in cache:
            rgb, al = load(C, i, L)
            R = np.zeros((PH, SW, 3), np.float32); A = np.zeros((PH, SW, 1), np.float32)
            x0, y0 = CX - L // 2, CY - L // 2
            xs, ys, xe, ye = max(0, x0), max(0, y0), min(SW, x0 + L), min(PH, y0 + L)
            R[ys:ye, xs:xe] = rgb[ys - y0:ye - y0, xs - x0:xe - x0]
            A[ys:ye, xs:xe] = al[ys - y0:ye - y0, xs - x0:xe - x0]
            cache[i] = (R, A)
        return cache[i]

    def reflexo(R, A, t):
        Rr = np.zeros_like(R); Ar = np.zeros_like(A); xs = np.arange(SW)
        for y in range(WL, PH):
            d = y - WL; src = WL - d
            if src < 0:
                break
            amp = 1.5 + d * 0.09
            dx = amp * math.sin(d * 0.55 + t * 2 * math.pi * 3) + 0.6 * amp * math.sin(d * 1.3 - t * 2 * math.pi * 5)
            sx = np.clip((xs - dx).round().astype(int), 0, SW - 1)
            Rr[y] = R[src, sx]; Ar[y] = A[src, sx] * (0.85 * math.exp(-d / 170))
        Rr = cv2.GaussianBlur(Rr, (0, 0), 1.2); Ar = cv2.GaussianBlur(Ar[..., 0], (0, 0), 1.5)[..., None]
        return Rr * 0.9, Ar

    def compor(J, t):
        fill = J[:, xs_ - SH]
        dl = J[:, HA - FE - 12:HA - FE].mean(1) - fill[:, :12].mean(1)
        dr = J[:, HB + FE:HB + FE + 12].mean(1) - fill[:, -12:].mean(1)
        dl = cv2.GaussianBlur(dl[:, None, :], (0, 0), sigmaX=0.1, sigmaY=12)[:, 0]
        dr = cv2.GaussianBlur(dr[:, None, :], (0, 0), sigmaX=0.1, sigmaY=12)[:, 0]
        fill = fill + dl[:, None] * (1 - u) + dr[:, None] * u
        J[:, xs_] = J[:, xs_] * (1 - al_b) + fill * al_b
        (R, A), i = quadro(t, N, layer)
        strip = J[:, X0:X0 + SW]
        dsky = strip[: HZ - 8].reshape(-1, 3).mean(0) - BR[i * len(BR) // N, 0]
        dsea = strip[HZ + 8:].reshape(-1, 3).mean(0) - BR[i * len(BR) // N, 1]
        wy = np.clip((np.arange(PH) - (HZ - 8)) / 16, 0, 1)[:, None, None]
        Rc = np.clip(R + 0.8 * (dsky * (1 - wy) + dsea * wy), 0, 1)
        Rr, Ar = reflexo(Rc, A, i / N)
        strip = strip * (1 - Ar) + Rr * Ar
        J[:, X0:X0 + SW] = strip * (1 - A) + Rc * A
        return J

t = 0
while True:
    b = dec.stdout.read(PW * PH * 3)
    if len(b) < PW * PH * 3:
        break
    F = np.frombuffer(b, np.uint8).reshape(PH, PW, 3).astype(np.float32) / 255
    enc.stdin.write((np.clip(compor(F, t), 0, 1) * 255).round().astype(np.uint8).tobytes())
    t += 1
    if t % 24 == 0:
        print(f"progresso {t} {TOTAL}", flush=True)
enc.stdin.close()
enc.wait()
print(f"ok {t} {PW}x{PH}", flush=True)
