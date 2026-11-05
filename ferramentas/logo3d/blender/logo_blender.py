# Blender: o logo 3D (.glb) girando, no mesmo enquadramento das vistas (logo com 964/1254 da altura do quadro).
# Uso: blender -b -P logo3d.py -- <modo: silhueta|final|volta> <saida> [angulos...]
# Variáveis: YAW0 (giro de partida), BG (fundo), RES, SAMPLES, FRAMES, COR, ROUGH, TRANS, WORLD, BGDIST, SIL
import bpy, math, os, sys
from mathutils import Vector

ENV = os.environ
# O modelo 3D do logo: LOGO_GLB, ou logo.glb ao lado deste script (não vai para o repositório).
GLB = ENV.get("LOGO_GLB") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "logo.glb")
argv = sys.argv[sys.argv.index("--") + 1:]
MODE, OUT = argv[0], argv[1]
ANGLES = [float(a) for a in argv[2:]] or [0, 90, 180, 270]
RES = int(ENV.get("RES", "512"))
YAW0 = float(ENV.get("YAW0", "0"))

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
ob = [o for o in bpy.context.scene.objects if o.type == "MESH"][0]
# Centro do modelo na origem e altura de 964/1254 do quadro (2 unidades).
bb = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
mn = Vector([min(v[i] for v in bb) for i in range(3)])
mx = Vector([max(v[i] for v in bb) for i in range(3)])
ctr = (mn + mx) / 2
s = (2 * 964 / 1254) / (mx.z - mn.z)
ob.data.transform(__import__("mathutils").Matrix.Translation(-ctr))
ob.location = (0, 0, 0)
ob.scale = (s, s, s)
import bmesh
_bm = bmesh.new()
_bm.from_mesh(ob.data)
_n0 = len(_bm.verts)
if ENV.get("WELD", "1") != "0":  # o .glb vem com os pontos soltos por triângulo; colados, a faixa deforma sem costuras
    bmesh.ops.remove_doubles(_bm, verts=_bm.verts, dist=float(ENV.get("WELDD", "0.0005")) * (mx.z - mn.z))
_bm.to_mesh(ob.data)
_bm.free()
print("WELD", _n0, "->", len(ob.data.vertices))
for f in ob.data.polygons:
    f.use_smooth = True
# O .glb traz as normais gravadas para a forma parada; ao deformar a faixa elas deixam riscos no reflexo.
# Sem elas, o Blender recalcula as normais a cada quadro.
bpy.context.view_layer.objects.active = ob
try:
    bpy.ops.mesh.customdata_custom_splitnormals_clear()
except Exception as e:
    print("normais:", e)
piv = bpy.data.objects.new("pivo", None)  # o giro é em torno do eixo vertical que passa pelo centro
bpy.context.scene.collection.objects.link(piv)
ob.parent = piv

sce = bpy.context.scene
sce.render.resolution_x = sce.render.resolution_y = RES
sce.render.film_transparent = True
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
sce.collection.objects.link(cam)
sce.camera = cam
cam.data.type = "ORTHO"
cam.data.ortho_scale = 2.0
cam.location = (0, -10, 0)
cam.rotation_euler = (math.pi / 2, 0, 0)

if MODE == "silhueta" or ENV.get("SIL"):
    sce.render.engine = "BLENDER_WORKBENCH"
    sce.display.shading.light = "FLAT"
    sce.display.shading.color_type = "SINGLE"
    sce.display.shading.single_color = (1, 1, 1)
else:
    sce.render.engine = "CYCLES"
    sce.cycles.device = "GPU"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "OPTIX"
    prefs.get_devices()
    for dv in prefs.devices:
        dv.use = True
    sce.cycles.samples = int(ENV.get("SAMPLES", "128"))
    sce.cycles.use_denoising = True
    # Vidro fino e dobrado: sem cáusticas e com o brilho filtrado, os reflexos internos não viram granulado.
    sce.cycles.caustics_reflective = False
    sce.cycles.caustics_refractive = False
    sce.cycles.blur_glossy = float(ENV.get("BLURG", "0"))
    sce.view_settings.view_transform = "Standard"
    if ENV.get("VIDRO"):  # sem fundo: o vidro vira transparência no canal alfa
        sce.cycles.film_transparent_glass = True
        sce.cycles.film_transparent_roughness = 0.1
    BG = ENV.get("BG")
    if BG:  # a parede atrás do logo, para o vidro refratar o céu e o mar de verdade
        bpy.ops.mesh.primitive_plane_add(size=2, location=(0, float(ENV.get("BGDIST", "1.5")), 0), rotation=(math.pi / 2, 0, 0))
        pl = bpy.context.active_object
        mb = bpy.data.materials.new("fundo")
        mb.use_nodes = True
        nt = mb.node_tree
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = bpy.data.images.load(BG)
        BGTEX = tex
        tex.extension = "EXTEND"
        em = nt.nodes.new("ShaderNodeEmission")
        nt.links.new(tex.outputs[0], em.inputs[0])
        nt.links.new(em.outputs[0], nt.nodes["Material Output"].inputs[0])
        pl.data.materials.append(mb)
        sce.render.film_transparent = False
    mat = bpy.data.materials.new("gel")
    mat.use_nodes = True
    bs = mat.node_tree.nodes["Principled BSDF"]
    bs.inputs["Base Color"].default_value = tuple(float(v) for v in ENV.get("COR", "1,0.5,0.38").split(",")) + (1,)
    bs.inputs["Roughness"].default_value = float(ENV.get("ROUGH", "0.03"))
    bs.inputs["Transmission Weight"].default_value = float(ENV.get("TRANS", "1"))
    bs.inputs["IOR"].default_value = float(ENV.get("IOR", "1.4"))
    PEROLA = ENV.get("PEROLA")  # "r,g,b": madrepérola refletiva (opaca, verniz + película iridescente)
    if PEROLA:
        bs.inputs["Base Color"].default_value = tuple(float(v) for v in PEROLA.split(",")) + (1,)
        bs.inputs["Transmission Weight"].default_value = float(ENV.get("PTRANS", "0"))
        bs.inputs["IOR"].default_value = 1.45
        bs.inputs["Metallic"].default_value = float(ENV.get("METAL", "0.35"))
        bs.inputs["Roughness"].default_value = float(ENV.get("ROUGH", "0.18"))
        bs.inputs["Coat Weight"].default_value = 1.0
        bs.inputs["Coat Roughness"].default_value = 0.03
        bs.inputs["Sheen Weight"].default_value = float(ENV.get("SHEENP", "0.4"))
        bs.inputs["Sheen Tint"].default_value = (1, 0.9, 0.95, 1)
        IRIS = float(ENV.get("IRIS", "0"))
        if IRIS:  # furta-cor: a cor do reflexo e do verniz muda com o ângulo (degradê de pastéis)
            nt = mat.node_tree
            lw = nt.nodes.new("ShaderNodeLayerWeight"); lw.inputs["Blend"].default_value = 0.35
            cr = nt.nodes.new("ShaderNodeValToRGB")
            el = cr.color_ramp.elements
            cores = [(0.0, (1.0, 0.78, 0.86)), (0.3, (0.82, 0.78, 1.0)), (0.55, (0.72, 0.95, 1.0)), (0.8, (1.0, 0.93, 0.7)), (1.0, (1.0, 0.75, 0.9))]
            el[0].position, el[0].color = cores[0][0], cores[0][1] + (1,)
            el[1].position, el[1].color = cores[-1][0], cores[-1][1] + (1,)
            for pos, c in cores[1:-1]:
                e = el.new(pos); e.color = c + (1,)
            nt.links.new(lw.outputs["Facing"], cr.inputs["Fac"])
            mix = nt.nodes.new("ShaderNodeMix"); mix.data_type = "RGBA"
            mix.inputs["Factor"].default_value = IRIS
            mix.inputs["A"].default_value = (1, 1, 1, 1)
            nt.links.new(cr.outputs["Color"], mix.inputs["B"])
            nt.links.new(mix.outputs["Result"], bs.inputs["Specular Tint"])
            nt.links.new(mix.outputs["Result"], bs.inputs["Coat Tint"])
        try:
            bs.inputs["Thin Film Thickness"].default_value = float(ENV.get("FILME", "420"))
            bs.inputs["Thin Film IOR"].default_value = 1.45
        except KeyError:
            pass
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    w = bpy.data.worlds.new("w")
    sce.world = w
    w.use_nodes = True
    sky = w.node_tree.nodes.new("ShaderNodeTexSky")
    if ENV.get("NOITE"):
        w.node_tree.nodes["Background"].inputs[0].default_value = (0.03, 0.07, 0.3, 1)
    else:
        w.node_tree.links.new(sky.outputs[0], w.node_tree.nodes["Background"].inputs[0])
    w.node_tree.nodes["Background"].inputs[1].default_value = float(ENV.get("WORLD", "1.0"))
    ENVIMG = ENV.get("ENVIMG")
    if ENVIMG:  # a paisagem do ato em volta do logo: o vidro reflete o céu e a grama de verdade
        et = w.node_tree.nodes.new("ShaderNodeTexEnvironment"); et.image = bpy.data.images.load(ENVIMG)
        mp = w.node_tree.nodes.new("ShaderNodeMapping"); tcw = w.node_tree.nodes.new("ShaderNodeTexCoord")
        mp.inputs["Rotation"].default_value[2] = math.radians(float(ENV.get("ENVROT", "0")))
        w.node_tree.links.new(tcw.outputs["Generated"], mp.inputs["Vector"]); w.node_tree.links.new(mp.outputs[0], et.inputs["Vector"])
        w.node_tree.links.new(et.outputs[0], w.node_tree.nodes["Background"].inputs[0])
    try:
        sky.sun_elevation = math.radians(6)
        sky.sun_rotation = math.radians(80)
    except Exception:
        pass
    LUZES = [((6, -4, 3), 900, (1, 0.62, 0.38)), ((-5, -6, 4), 300, (1, 0.85, 0.8)), ((0, 6, 2), 500, (1, 0.7, 0.45))]
    if ENV.get("NOITE"):  # couvert: lago azul ao anoitecer, luz fria vinda de trás e de cima
        LUZES = [((4, -5, 4), 1400, (0.75, 0.85, 1)), ((-5, -5, 3), 700, (0.65, 0.75, 1)), ((0, 6, 1.5), 1600, (0.85, 0.92, 1)), ((0, -3, 6), 900, (0.9, 0.95, 1))]
    for loc, en, col in LUZES:
        L = bpy.data.objects.new("l", bpy.data.lights.new("l", "AREA"))
        L.data.energy, L.data.color, L.data.size = en * float(ENV.get("LUZ", "1")), col, float(ENV.get("LUZTAM", "4"))
        L.location = loc
        L.rotation_euler = (Vector((0, 0, 0)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        sce.collection.objects.link(L)
        L.visible_camera = False

if ENV.get("SOL") and not (MODE == "silhueta" or ENV.get("SIL")):  # sol baixo e forte: brilhos dourados nítidos nas bordas do vidro
    sl_ = bpy.data.objects.new("sol", bpy.data.lights.new("sol", "SUN"))
    sl_.data.energy = float(ENV.get("SOL")); sl_.data.angle = math.radians(float(ENV.get("SOLANG", "1.5")))
    sl_.data.color = (1.0, 0.78, 0.5)
    az, el = math.radians(float(ENV.get("SOLAZ", "60"))), math.radians(float(ENV.get("SOLEL", "12")))
    sl_.rotation_euler = (math.pi / 2 - el, 0, az)        # vem de trás-direita, baixo
    sce.collection.objects.link(sl_)

ROLL = float(ENV.get("ROLL", "0"))  # quanto a faixa rola em volta da própria linha central numa volta (graus)
if ROLL or float(ENV.get("WAVE", "0")):
    import numpy as np
    me = ob.data
    V0 = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", V0)
    V0 = V0.reshape(-1, 3)
    # Linha central: média dos vértices por fatia de ângulo em volta do centro (no plano da frente, x-z).
    NB = 180
    ang = np.arctan2(V0[:, 2], V0[:, 0])
    fb = (ang + np.pi) / (2 * np.pi) * NB  # fatia fracionária de cada vértice
    bi = np.floor(fb).astype(int) % NB
    C = np.stack([V0[bi == b].mean(0) for b in range(NB)])
    for _ in range(3):  # suaviza a linha central
        C = (np.roll(C, 1, 0) + 2 * C + np.roll(C, -1, 0)) / 4
    for _ in range(int(ENV.get("SMOOTH", "12"))):
        C = (np.roll(C, 1, 0) + 2 * C + np.roll(C, -1, 0)) / 4
    # Linha central densa; cada ponto do modelo vai para o ponto mais próximo dela (não pelo ângulo).
    k = 20
    tt = np.arange(NB * k) / k
    j0 = np.floor(tt).astype(int) % NB
    ww = (tt - np.floor(tt))[:, None]
    Cd = C[j0] * (1 - ww) + C[(j0 + 1) % NB] * ww
    # Direção da linha central sem degraus: a das fatias, interpolada suave (antes mudava aos saltos e riscava a faixa).
    Tb = np.roll(C, -1, 0) - np.roll(C, 1, 0)
    Tb /= np.linalg.norm(Tb, axis=1, keepdims=True)
    sm = ww[:, 0] * ww[:, 0] * (3 - 2 * ww[:, 0])
    Td = Tb[j0] * (1 - sm)[:, None] + Tb[(j0 + 1) % NB] * sm[:, None]
    # Pontos da linha central em curva (Catmull-Rom) em vez de retas entre as fatias.
    P0, P1, P2, P3 = C[(j0 - 1) % NB], C[j0], C[(j0 + 1) % NB], C[(j0 + 2) % NB]
    t_ = ww
    Cd = 0.5 * ((2 * P1) + (-P0 + P2) * t_ + (2 * P0 - 5 * P1 + 4 * P2 - P3) * t_ ** 2 + (-P0 + 3 * P1 - 3 * P2 + P3) * t_ ** 3)
    Td /= np.linalg.norm(Td, axis=1, keepdims=True)
    from mathutils.kdtree import KDTree
    kd = KDTree(len(Cd))
    for i, p in enumerate(Cd):
        kd.insert(p, i)
    kd.balance()
    near = np.array([kd.find(p)[1] for p in V0])
    Cv, Tv = Cd[near], Td[near]
    R = V0 - Cv
    R -= Tv * (R * Tv).sum(1, keepdims=True)  # só a parte perpendicular à linha central gira
    Cv = V0 - R

    U = near / len(Cd)  # posição de cada ponto ao longo do anel (0..1)
    # Onde dois trechos distantes do anel ficam encostados (a faixa passa sobre si mesma), a onda diminui,
    # senão as camadas se cruzam e o vidro mostra riscos.
    GUARD = float(ENV.get("GUARD", "0"))
    AMP = np.ones(len(V0))
    if GUARD:
        size = np.ptp(V0, axis=0).max()
        rad = GUARD * size
        idx = np.arange(0, len(V0), 4)
        kv = KDTree(len(idx))
        for j, i in enumerate(idx):
            kv.insert(V0[i], int(i))
        kv.balance()
        clash = []
        for i in idx:
            for _, k, _ in kv.find_range(V0[i], rad):
                du = abs(U[i] - U[k])
                if min(du, 1 - du) > 0.12:
                    clash.append(i)
                    break
        print("CLASH", len(clash), "de", len(idx))
        if clash:
            kc = KDTree(len(clash))
            for j, i in enumerate(clash):
                kc.insert(V0[i], j)
            kc.balance()
            dist = np.array([kc.find(p)[2] for p in V0])
            fall = 2.5 * rad
            AMP = np.clip(dist / fall, 0, 1) ** 2  # 0 no encosto, 1 longe dele (transição suave)
    # Nas curvas fechadas do anel, girar a faixa em volta da linha central dobra a superfície sobre si mesma
    # (vira granulado no vidro): ali a onda diminui, conforme distância do eixo x curvatura.
    QMAX = float(ENV.get("QMAX", "0"))
    if QMAX:
        ds = np.linalg.norm(np.roll(Cd, -1, 0) - Cd, axis=1).mean()
        kap = np.linalg.norm(np.roll(Td, -1, 0) - np.roll(Td, 1, 0), axis=1) / (2 * ds)
        for _ in range(200):  # curvatura suave ao longo do anel
            kap = (np.roll(kap, 1) + 2 * kap + np.roll(kap, -1)) / 4
        w = np.percentile(np.linalg.norm(R, axis=1), 90)  # meia largura da faixa, igual de borda a borda
        q = w * kap[near]
        AMP = AMP * np.clip(1 - q / QMAX, 0, 1) ** 2
        print("QSTAT", round(float(q.max()), 3), round(float(np.percentile(q, 50)), 3), round(float((AMP < 0.5).mean()), 3))
    AMP = AMP[:, None]

# LIQ: ondas de líquido na faixa (metal líquido), correndo ao longo do anel; ciclos inteiros por volta (laço sem salto)
LIQ = float(ENV.get("LIQ", "0"))
if LIQ:
    M_ = len(Cd); nn = np.zeros_like(Cd)
    t0 = Td[0]; n0 = np.cross(t0, [0, 1, 0] if abs(t0[1]) < 0.9 else [1, 0, 0]); nn[0] = n0 / np.linalg.norm(n0)
    for i in range(1, M_):
        v = nn[i - 1] - Td[i] * (nn[i - 1] @ Td[i]); nn[i] = v / np.linalg.norm(v)
    v = nn[-1] - Td[0] * (nn[-1] @ Td[0]); v /= np.linalg.norm(v)
    phi = math.atan2(np.cross(v, nn[0]) @ Td[0], v @ nn[0])
    for i in range(M_):
        a_ = phi * i / M_; t_ = Td[i]; c_, s_ = math.cos(a_), math.sin(a_)
        nn[i] = nn[i] * c_ + np.cross(t_, nn[i]) * s_ + t_ * (t_ @ nn[i]) * (1 - c_)
    bb_ = np.cross(Td, nn)
    FIO = np.arctan2((R * bb_[near]).sum(1), (R * nn[near]).sum(1)) / math.pi
    rr = np.linalg.norm(R, axis=1); sl2 = (near * 180 // len(Cd)).astype(int); mx2 = np.zeros(180); np.maximum.at(mx2, sl2, rr)
    W2 = (rr / (mx2[sl2] + 1e-9)) ** 2
    LIQ *= 2 * 964 / 1254

LAP = int(ENV.get("LAP", "0"))
if LAP:
    import numpy as np
    E = np.empty(len(ob.data.edges) * 2, dtype=np.int64)
    ob.data.edges.foreach_get("vertices", E)
    E = E.reshape(-1, 2)
    DEG = np.bincount(E.ravel(), minlength=len(ob.data.vertices)).astype(float)[:, None]
    DEG[DEG == 0] = 1
WAVE = float(ENV.get("WAVE", "0"))      # amplitude da onda de rolagem (graus)
NWAVE = int(ENV.get("NWAVE", "2"))      # quantas ondas cabem em volta do anel
BULGE = float(ENV.get("BULGE", "0"))    # quanto a faixa engrossa/afina (fração)
KT = int(ENV.get("KT", "1"))            # quantas vezes a onda dá a volta no anel por volta do logo

def roll(frac):  # Rodrigues: gira cada ponto em volta da tangente da linha central
    ph = 2 * np.pi * (U * NWAVE - frac * KT)
    th = (math.radians(ROLL) * frac + math.radians(WAVE) * np.sin(ph))[:, None] * AMP
    c, s = np.cos(th), np.sin(th)
    Rb = R * (1 + BULGE * np.sin(ph + 1.3)[:, None] * AMP)
    cr = np.cross(Tv, Rb)
    V = Cv + Rb * c + cr * s
    if LIQ:
        f_ = frac
        disp = LIQ * (0.35 + 0.65 * W2) * (np.sin(2 * np.pi * (U * 7 - 2 * f_) + FIO * np.pi)
                                           + 0.5 * np.sin(2 * np.pi * (U * 11 + f_) - FIO * np.pi * 1.6)
                                           + 0.6 * np.sin(2 * np.pi * (U * 3 - f_)))
        Rn = V - Cv; Rn /= (np.linalg.norm(Rn, axis=1, keepdims=True) + 1e-9)
        Nf = np.cross(Tv, Rn); Nf /= (np.linalg.norm(Nf, axis=1, keepdims=True) + 1e-9)
        V = V + Nf * disp[:, None]
    if LAP:  # alisa o deslocamento com a média dos vizinhos: some o "granulado", fica o movimento grande
        D = V - V0
        for _ in range(LAP):
            S_ = np.zeros_like(D)
            np.add.at(S_, E[:, 0], D[E[:, 1]])
            np.add.at(S_, E[:, 1], D[E[:, 0]])
            D = 0.5 * D + 0.5 * S_ / DEG
        V = V0 + D
    ob.data.vertices.foreach_set("co", V.ravel())
    ob.data.update()

TWIST = float(ENV.get("TWIST", "0"))  # torção suave: cima e baixo giram em sentidos opostos (graus)
WOB = float(ENV.get("WOB", "0"))      # balanço mole de gel (fração do tamanho)
if TWIST or WOB:
    import numpy as np
    W0 = np.empty(len(ob.data.vertices) * 3)
    ob.data.vertices.foreach_get("co", W0)
    W0 = W0.reshape(-1, 3)
    HH = W0[:, 2].max() - W0[:, 2].min()

def field(frac):  # campo contínuo no espaço todo: a faixa nunca atravessa a si mesma
    p = 2 * np.pi * frac
    z = W0[:, 2] / HH  # -0.5..0.5
    th = np.radians(TWIST) * np.sin(2 * np.pi * z * 1.2 - p)  # a torção sobe pelo logo como uma onda
    c, s = np.cos(th), np.sin(th)
    x, y = W0[:, 0] * c - W0[:, 1] * s, W0[:, 0] * s + W0[:, 1] * c
    V = np.stack([x, y, W0[:, 2]], 1)
    if ROLL or WAVE:  # já houve a onda da faixa (roll): soma o balanço por cima dela, sem apagar
        cur = np.empty(len(W0) * 3); ob.data.vertices.foreach_get("co", cur); cur = cur.reshape(-1, 3)
        V = cur + (V - W0)
    if WOB:
        d = WOB * HH
        V[:, 0] += d * np.sin(2 * np.pi * (W0[:, 2] / HH) * 1.5 + p)
        V[:, 1] += d * np.sin(2 * np.pi * (W0[:, 0] / HH) * 1.3 - p + 1.0)
        V[:, 2] += d * 0.6 * np.sin(2 * np.pi * (W0[:, 0] / HH) * 1.1 + p + 2.0)
    ob.data.vertices.foreach_set("co", V.ravel())
    ob.data.update()

def pose(a):
    piv.rotation_euler = (0, 0, -math.radians(YAW0 + a))
    if ROLL or WAVE:
        roll(a / 360)
    if TWIST or WOB:
        field(a / 360)

sce.render.image_settings.file_format = "PNG"
sce.render.image_settings.color_mode = "RGBA"
if MODE == "volta":
    n = int(ENV.get("FRAMES", "120"))
    BGSEQ = ENV.get("BGSEQ")
    for f in range(n):
        if os.path.exists(f"{OUT}/{f:04d}.png"):  # retoma: pula o que já foi renderizado
            continue
        if BGSEQ:  # BGN: quantos fundos há (a volta pode ter mais quadros que o fundo)
            nb = int(ENV.get("BGN", n))
            BGTEX.image = bpy.data.images.load(BGSEQ.format(f=f * nb // n))
        pose(360 * f / n)
        sce.render.filepath = f"{OUT}/{f:04d}.png"
        bpy.ops.render.render(write_still=True)
else:
    for a in ANGLES:
        pose(a)
        sce.render.filepath = f"{OUT}-{int(a)}.png"
        bpy.ops.render.render(write_still=True)
