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
        bs.inputs["Sheen Weight"].default_value = 0.4
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
        L.data.energy, L.data.color, L.data.size = en * float(ENV.get("LUZ", "1")), col, 4
        L.location = loc
        L.rotation_euler = (Vector((0, 0, 0)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        sce.collection.objects.link(L)
        L.visible_camera = False

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

# ---------- Risoto: seda que vira fios de ouro ----------
# Atributos fixos na faixa (andam junto com a deformação): "u" = posição ao longo do anel (0..1) e
# "fio" = posição de uma borda à outra da faixa (-1..1). O material lê os dois; o valor T (0..1) leva a seda ao ouro.
TNODE = None
if True:  # o referencial e os atributos valem também para a silhueta (o contorno acompanha o tecido)
    # referencial que viaja ao longo do anel sem virar (transporte paralelo), com a torção total distribuída
    M_ = len(Cd); nn = np.zeros_like(Cd)
    t0 = Td[0]; n0 = np.cross(t0, [0, 1, 0] if abs(t0[1]) < 0.9 else [1, 0, 0]); nn[0] = n0 / np.linalg.norm(n0)
    for i in range(1, M_):
        v = nn[i - 1] - Td[i] * (nn[i - 1] @ Td[i]); nn[i] = v / np.linalg.norm(v)
    v = nn[-1] - Td[0] * (nn[-1] @ Td[0]); v /= np.linalg.norm(v)
    phi = math.atan2(np.cross(v, nn[0]) @ Td[0], v @ nn[0])           # quanto falta para fechar o laço
    for i in range(M_):
        a_ = phi * i / M_; t_ = Td[i]; c_, s_ = math.cos(a_), math.sin(a_)
        nn[i] = nn[i] * c_ + np.cross(t_, nn[i]) * s_ + t_ * (t_ @ nn[i]) * (1 - c_)
    bb_ = np.cross(Td, nn)
    FIO = np.arctan2((R * bb_[near]).sum(1), (R * nn[near]).sum(1)) / math.pi   # -1..1 em volta da faixa
    me = ob.data
    for nm, arr in (("u", U), ("fio", np.clip(FIO, -1.2, 1.2))):
        at = me.attributes.new(nm, "FLOAT", "POINT"); at.data.foreach_set("value", arr.astype(np.float32))
    at = me.attributes.new("tan", "FLOAT_VECTOR", "POINT"); at.data.foreach_set("vector", Td[near].astype(np.float32).ravel())
    U0 = float(ENV.get("U0", "0.15"))  # onde a transformação começa no anel
if not ENV.get("SIL"):
    m = bpy.data.materials.new("risoto"); m.use_nodes = True
    nt = m.node_tree; N = nt.nodes; Lk = nt.links.new
    out = N["Material Output"]; N.remove(N["Principled BSDF"])
    def node(t, **kw):
        x = N.new(t)
        for k, v in kw.items(): setattr(x, k, v)
        return x
    def math_(op, a, b=None, clamp=False):
        x = node("ShaderNodeMath", operation=op, use_clamp=clamp)
        for i, v in enumerate((a, b)):
            if v is None: continue
            if isinstance(v, (int, float)): x.inputs[i].default_value = v
            else: Lk(v, x.inputs[i])
        return x.outputs[0]
    au = node("ShaderNodeAttribute", attribute_name="u").outputs["Fac"]
    af = node("ShaderNodeAttribute", attribute_name="fio").outputs["Fac"]
    TV = node("ShaderNodeValue"); TV.outputs[0].default_value = float(ENV.get("T", "0")); TNODE = TV
    # distância (ao longo do anel) do ponto de partida, 0..1
    du = math_("ABSOLUTE", math_("SUBTRACT", au, U0))
    du = math_("MINIMUM", du, math_("SUBTRACT", 1.0, du))
    du = math_("MULTIPLY", du, 2.0)
    # borda irregular da frente: ruído
    tc = node("ShaderNodeTexCoord")
    nz = node("ShaderNodeTexNoise"); nz.inputs["Scale"].default_value = 6.0; nz.inputs["Detail"].default_value = 4.0
    Lk(tc.outputs["Object"], nz.inputs["Vector"])
    front = math_("SUBTRACT", math_("MULTIPLY", TV.outputs[0], 1.35), math_("ADD", du, math_("MULTIPLY", math_("SUBTRACT", nz.outputs["Fac"], 0.5), 0.35)))
    G = math_("MULTIPLY", front, 6.0, clamp=True)                       # 0 = seda, 1 = ouro
    # fios: listras finas ao longo da faixa (seguem "fio"), com leve ondulação
    wob = node("ShaderNodeTexNoise"); wob.inputs["Scale"].default_value = 3.0
    Lk(tc.outputs["Object"], wob.inputs["Vector"])
    NF = round(float(ENV.get("NFIOS", "16")))  # inteiro: as listras fecham em volta da faixa
    ph = math_("ADD", math_("MULTIPLY", af, NF * math.pi), math_("MULTIPLY", wob.outputs["Fac"], 4.0))
    st = math_("ABSOLUTE", math_("SINE", ph))                           # 0 no meio do vão, 1 no meio do fio
    # o vão entre os fios abre com o ouro (nos fios recém-soltos o vão ainda é pequeno)
    abre = math_("MULTIPLY", math_("MULTIPLY", G, G), float(ENV.get("VAO", "0.55")))
    fio_on = math_("MULTIPLY", math_("SUBTRACT", st, abre), 25.0, clamp=True)
    alpha = math_("ADD", math_("SUBTRACT", 1.0, G), math_("MULTIPLY", G, fio_on), clamp=True)
    # seda
    seda = node("ShaderNodeBsdfPrincipled")
    seda.inputs["Base Color"].default_value = tuple(float(v) for v in ENV.get("SEDA", "0.72,0.58,0.42").split(",")) + (1,)
    seda.inputs["Roughness"].default_value = float(ENV.get("ROUGHS", "0.12"))
    seda.inputs["Anisotropic"].default_value = 0.9              # cetim: o brilho escorre ao longo da faixa
    seda.inputs["Sheen Weight"].default_value = float(ENV.get("SHEEN", "0.15"))
    seda.inputs["Sheen Roughness"].default_value = 0.3
    seda.inputs["Sheen Tint"].default_value = (1, 0.95, 0.88, 1)
    seda.inputs["Specular IOR Level"].default_value = 1.0
    seda.inputs["Specular Tint"].default_value = (1, 0.92, 0.8, 1)
    trama = node("ShaderNodeTexWave", wave_type="BANDS", bands_direction="X")
    trama.inputs["Scale"].default_value = 900.0; trama.inputs["Distortion"].default_value = 0.0
    Lk(tc.outputs["Object"], trama.inputs["Vector"])
    bp = node("ShaderNodeBump"); bp.inputs["Strength"].default_value = 0.03
    Lk(trama.outputs["Fac"], bp.inputs["Height"])
    # dobras macias de tecido (ondas largas ao longo da faixa)
    dob = node("ShaderNodeTexNoise"); dob.inputs["Scale"].default_value = float(ENV.get("DOBRA", "1.5")); dob.inputs["Detail"].default_value = 1.5
    Lk(tc.outputs["Object"], dob.inputs["Vector"])
    bd = node("ShaderNodeBump"); bd.inputs["Strength"].default_value = float(ENV.get("DOBRAF", "0.3"))
    Lk(dob.outputs["Fac"], bd.inputs["Height"]); Lk(bp.outputs["Normal"], bd.inputs["Normal"])
    # vincos e pregas de seda: duas famílias de dobras em diagonal pela faixa, com a crista fina (1 - |sen|)
    def vinco(ku, kf, fase):
        w = math_("ADD", math_("ADD", math_("MULTIPLY", au, ku * 2 * math.pi), math_("MULTIPLY", af, kf * math.pi)),
                  math_("MULTIPLY", dob.outputs["Fac"], fase))
        sw = math_("SINE", w)
        return math_("MULTIPLY", sw, sw)                                  # prega macia (sen²)
    VK = float(ENV.get("VINCOS", "6"))
    pregas = vinco(VK, 0.7, 2.0)                                         # uma família só: pregas longas em diagonal
    bv = node("ShaderNodeBump"); bv.inputs["Strength"].default_value = float(ENV.get("VINCOF", "0.45"))
    bv.inputs["Distance"].default_value = 0.05
    Lk(pregas, bv.inputs["Height"]); Lk(bd.outputs["Normal"], bv.inputs["Normal"])
    Lk(bv.outputs["Normal"], seda.inputs["Normal"])
    # duas tonalidades: mais clara onde encara a luz/câmera, champanhe-rosado nas partes viradas
    lw = node("ShaderNodeLayerWeight"); lw.inputs["Blend"].default_value = 0.45
    Lk(bv.outputs["Normal"], lw.inputs["Normal"])
    cm_ = node("ShaderNodeMix", data_type="RGBA")
    cm_.inputs["A"].default_value = tuple(float(v) for v in ENV.get("SEDA", "0.92,0.82,0.66").split(",")) + (1,)
    cm_.inputs["B"].default_value = tuple(float(v) for v in ENV.get("SEDA2", "0.80,0.58,0.44").split(",")) + (1,)
    Lk(lw.outputs["Facing"], cm_.inputs["Factor"])
    if ENV.get("FINA"):  # seda fina como as fitas da parede: marfim, rosé e chocolate ao longo da faixa, deixando a luz passar
        cr = node("ShaderNodeValToRGB"); el = cr.color_ramp.elements
        cores = [(0.0, (0.86, 0.72, 0.52)), (0.3, (0.84, 0.60, 0.48)), (0.55, (0.55, 0.36, 0.24)), (0.8, (0.88, 0.70, 0.50)), (1.0, (0.86, 0.72, 0.52))]
        el[0].position, el[0].color = cores[0][0], cores[0][1] + (1,)
        el[1].position, el[1].color = cores[-1][0], cores[-1][1] + (1,)
        for pos_, c_ in cores[1:-1]:
            e_ = el.new(pos_); e_.color = c_ + (1,)
        Lk(math_("ADD", au, math_("MULTIPLY", math_("SUBTRACT", dob.outputs["Fac"], 0.5), 0.15)), cr.inputs["Fac"])
        Lk(cr.outputs["Color"], seda.inputs["Base Color"])
        seda.inputs["Transmission Weight"].default_value = float(ENV.get("TRANSS", "0.45"))
        seda.inputs["IOR"].default_value = 1.2
        sa = node("ShaderNodeValue"); sa.outputs[0].default_value = float(ENV.get("ALFAS", "0.85"))
        # a seda fina deixa ver um pouco através (o alfa final mistura seda e ouro)
        alpha2 = math_("ADD", math_("MULTIPLY", math_("SUBTRACT", 1.0, G), sa.outputs[0]), math_("MULTIPLY", G, fio_on), clamp=True)
        ALFA_FINA = alpha2; Lk(sa.outputs[0], seda.inputs["Alpha"])
        # seda amassada como a da parede: rede fina de vincos (Voronoi, distância à borda), esticada ao longo da faixa
        cxyz = node("ShaderNodeCombineXYZ")
        Lk(math_("MULTIPLY", au, float(ENV.get("VU", "14"))), cxyz.inputs[0]); Lk(math_("MULTIPLY", af, float(ENV.get("VF", "13"))), cxyz.inputs[1])
        Lk(math_("MULTIPLY", dob.outputs["Fac"], 1.5), cxyz.inputs[2])
        vor = node("ShaderNodeTexVoronoi", feature="DISTANCE_TO_EDGE"); vor.inputs["Scale"].default_value = 1.0
        vor.inputs["Randomness"].default_value = 1.0
        Lk(cxyz.outputs[0], vor.inputs["Vector"])
        cre = math_("POWER", math_("MULTIPLY", vor.outputs["Distance"], float(ENV.get("VFINO", "14")), clamp=True), 0.6)   # 0 no vinco, 1 no meio da célula
        bc = node("ShaderNodeBump"); bc.inputs["Strength"].default_value = float(ENV.get("CRINK", "0.35")); bc.inputs["Distance"].default_value = 0.01
        Lk(cre, bc.inputs["Height"]); Lk(bv.outputs["Normal"], bc.inputs["Normal"]); Lk(bc.outputs["Normal"], seda.inputs["Normal"])
        seda.inputs["Metallic"].default_value = float(ENV.get("METS", "0.5"))   # brilho champanhe meio metálico
        seda.inputs["Sheen Weight"].default_value = 0.3
    else:
        Lk(cm_.outputs["Result"], seda.inputs["Base Color"])
    # ouro
    ouro = node("ShaderNodeBsdfPrincipled")
    ouro.inputs["Base Color"].default_value = tuple(float(v) for v in ENV.get("OURO", "1.0,0.78,0.46").split(",")) + (1,)
    ouro.inputs["Metallic"].default_value = 1.0
    ouro.inputs["Roughness"].default_value = float(ENV.get("ROUGHO", "0.14"))
    ouro.inputs["Anisotropic"].default_value = 0.7
    bo = node("ShaderNodeBump"); bo.inputs["Strength"].default_value = 0.6
    Lk(st, bo.inputs["Height"]); Lk(bo.outputs["Normal"], ouro.inputs["Normal"])
    for b_ in (seda, ouro): b_.inputs["Alpha"].default_value = 1.0
    # direção da faixa (para o brilho de cetim e dos fios escorrer ao longo dela), do objeto para o mundo
    atn = node("ShaderNodeAttribute", attribute_name="tan")
    vt = node("ShaderNodeVectorTransform", vector_type="VECTOR", convert_from="OBJECT", convert_to="WORLD")
    Lk(atn.outputs["Vector"], vt.inputs[0])
    for b_ in (seda, ouro): Lk(vt.outputs[0], b_.inputs["Tangent"])
    Lk(ALFA_FINA if ENV.get("FINA") else alpha, ouro.inputs["Alpha"])
    mx_ = node("ShaderNodeMixShader")
    Lk(G, mx_.inputs[0]); Lk(seda.outputs[0], mx_.inputs[1]); Lk(ouro.outputs[0], mx_.inputs[2])
    Lk(mx_.outputs[0], out.inputs["Surface"])
    if ENV.get("DEBUG"):  # mostra os atributos: vermelho = "u" (ao longo), verde = listras de "fio" (de borda a borda)
        cc = node("ShaderNodeCombineColor")
        Lk(au, cc.inputs[0]); Lk(math_("ABSOLUTE", math_("SINE", math_("MULTIPLY", af, 4 * math.pi))), cc.inputs[1])
        em = node("ShaderNodeEmission"); Lk(cc.outputs[0], em.inputs[0]); Lk(em.outputs[0], out.inputs["Surface"])
    ob.data.materials.clear(); ob.data.materials.append(m)
    # fundo escuro e quente (fica transparente no alfa, mas ilumina)
    if ENV.get("ESCURO"):
        sce.world.node_tree.nodes["Background"].inputs[0].default_value = (0.06, 0.035, 0.03, 1)
        for lk in list(sce.world.node_tree.links): sce.world.node_tree.links.remove(lk)
        sce.world.node_tree.links.new(sce.world.node_tree.nodes["Background"].outputs[0], sce.world.node_tree.nodes["World Output"].inputs[0])

TEC = float(ENV.get("TECIDO", "0"))   # amplitude das ondas de tecido (fração do tamanho)
CUR = {"t": float(ENV.get("T", "0")), "s": 0.0}
if TEC:
    TEC *= 2 * 964 / 1254
    rr = np.linalg.norm(R, axis=1)
    sl2 = (near * 180 // len(Cd)).astype(int)
    mx2 = np.zeros(180)
    np.maximum.at(mx2, sl2, rr)
    W2 = (rr / (mx2[sl2] + 1e-9)) ** 2                                   # 1 nas bordas da faixa, ~0 no meio
    U0_ = float(ENV.get("U0", "0.15"))
    DUV = np.abs(U - U0_); DUV = np.minimum(DUV, 1 - DUV) * 2
else:
    TEC = 0

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
    if TEC:
        tt = CUR["s"]
        Gv = np.clip((CUR["t"] * 1.35 - DUV) * 6, 0, 1)
        ph1 = 2 * np.pi * (U * 7 - tt * 0.35) + FIO * np.pi * 1.0
        ph2 = 2 * np.pi * (U * 11 + tt * 0.22) - FIO * np.pi * 1.6
        ph3 = 2 * np.pi * (U * 3 - tt * 0.15)
        amp = TEC * (0.25 + 0.75 * W2) * (1 - 0.85 * Gv)
        disp = amp * (np.sin(ph1) + 0.5 * np.sin(ph2) + 0.6 * np.sin(ph3))
        Rn = V - Cv; Rn /= (np.linalg.norm(Rn, axis=1, keepdims=True) + 1e-9)
        Nf = np.cross(Tv, Rn); Nf /= (np.linalg.norm(Nf, axis=1, keepdims=True) + 1e-9)   # fora do plano da faixa
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
def tcurva(fr):  # T ao longo do vídeo: seda parada no começo, transformação no meio, ouro no fim
    a, b = float(ENV.get("TA", "0.25")), float(ENV.get("TB", "0.8"))
    x = min(1, max(0, (fr - a) / (b - a)))
    return x * x * (3 - 2 * x)

if MODE == "teste":  # TLIST: "angulo:T,angulo:T,..."
    for item in ENV.get("TLIST", "30:0,30:0.5,30:1").split(","):
        a, t = (float(v) for v in item.split(":"))
        if TNODE: TNODE.outputs[0].default_value = t
        CUR["t"], CUR["s"] = t, a / 72.0
        pose(a)
        sce.render.filepath = f"{OUT}-{int(a)}-{int(t * 100):03d}.png"
        bpy.ops.render.render(write_still=True)
elif MODE == "transforma":  # FRAMES quadros; VOLTA quadros por volta (giro) ; T sobe pela tcurva
    n, nv = int(ENV.get("FRAMES", "240")), int(ENV.get("VOLTA", "120"))
    for f in range(n):
        if os.path.exists(f"{OUT}/{f:04d}.png"): continue
        if TNODE: TNODE.outputs[0].default_value = tcurva(f / (n - 1))
        CUR["t"], CUR["s"] = tcurva(f / (n - 1)), f / 24.0
        pose(360 * f / nv)
        sce.render.filepath = f"{OUT}/{f:04d}.png"
        bpy.ops.render.render(write_still=True)
elif MODE == "volta":
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
