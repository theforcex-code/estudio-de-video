// Câmera lenta com o RIFE (interpolação de quadros por IA, na placa de vídeo).
//
// O vídeo vira quadros e o RIFE cria quadros do meio (o dobro do necessário). O Seedance não anda
// por igual: a cada 3 ou 4 quadros dá um pulo maior, e na câmera lenta esse pulo vira um tranco.
// Por isso, dos quadros do RIFE, ficam os que dão passos de movimento iguais (medidos quadro a quadro,
// em relação à média do trecho): some o tranco e o ritmo geral do movimento continua o mesmo.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readdirSync, rmSync, renameSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "ferramentas");

// Acha o rife-ncnn-vulkan.exe e o modelo (o mais novo da família v4, que aceita qualquer número de quadros).
export function rifeInfo() {
  if (!existsSync(ROOT)) return null;
  const dir = readdirSync(ROOT, { withFileTypes: true }).find((d) => d.isDirectory() && /^rife-ncnn-vulkan/i.test(d.name));
  if (!dir) return null;
  const base = join(ROOT, dir.name);
  const exe = join(base, "rife-ncnn-vulkan.exe");
  if (!existsSync(exe)) return null;
  const models = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && /^rife-v4/.test(d.name)).map((d) => d.name);
  const order = (m) => Number((/v4\.?(\d+)?/.exec(m) || [])[1] || 0);
  models.sort((a, b) => order(b) - order(a));
  return models.length ? { exe, model: join(base, models[0]), modelName: models[0] } : null;
}

// Quanto a imagem muda de um quadro para o próximo (média em tons de cinza, em miniatura).
function motion(ff, pattern) {
  return new Promise((ok, bad) => {
    const W = 128, H = 128;
    const p = spawn(ff, ["-hide_banner", "-loglevel", "error", "-i", pattern, "-vf", `scale=${W}:${H},format=gray`, "-f", "rawvideo", "-"]);
    let buf = Buffer.alloc(0), prev = null;
    const d = [];
    p.stdout.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= W * H) {
        const f = buf.subarray(0, W * H);
        if (prev) { let s = 0; for (let i = 0; i < f.length; i++) s += Math.abs(f[i] - prev[i]); d.push(s / f.length); }
        prev = Buffer.from(f);
        buf = buf.subarray(W * H);
      }
    });
    p.on("close", (c) => (c ? bad(new Error("não consegui medir o movimento")) : ok(d)));
  });
}

// Escolhe `count` quadros de `diffs.length + 1` para que cada passo tenha o mesmo movimento em
// relação à média do trecho em volta (janela `win`): tira os trancos sem mudar o ritmo geral.
function evenSteps(diffs, count, win) {
  const n = diffs.length;
  const avg = diffs.map((_, i) => {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - win); k <= Math.min(n - 1, i + win); k++) { s += diffs[k]; c++; }
    return s / c;
  });
  const cum = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i] + (avg[i] > 0.02 ? diffs[i] / avg[i] : 1));
  const total = cum[n], pick = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const target = (total * k) / (count - 1);
    while (j < n && cum[j + 1] < target) j++;
    pick.push(j < n && target - cum[j] > cum[j + 1] - target ? j + 1 : j);
  }
  return pick;
}

// src -> out (mp4, 24 fps), com a velocidade `speed` (0,1 a 1) e o filtro `vf` (cor, desfoque…) no fim.
export async function rifeSlow(ff, src, out, speed, vf) {
  const info = rifeInfo();
  if (!info) throw new Error("RIFE não instalado");
  const work = join(dirname(out), `.rife-${Date.now().toString(36)}`);
  const inDir = join(work, "in"), midDir = join(work, "mid"), outDir = join(work, "out");
  for (const d of [inDir, midDir, outDir]) mkdirSync(d, { recursive: true });
  try {
    await execFileP(ff, ["-hide_banner", "-loglevel", "error", "-i", src, "-vsync", "0", join(inDir, "%08d.png")], { maxBuffer: 1 << 24 });
    const frames = readdirSync(inDir).length;
    if (frames < 2) throw new Error("vídeo curto demais para a câmera lenta");
    const target = Math.round(frames / speed);
    const over = target * 2; // o dobro, para ter de onde escolher
    await execFileP(info.exe, ["-i", inDir, "-o", midDir, "-n", String(over), "-m", info.model, "-g", "0", "-j", "2:4:2"],
      { maxBuffer: 1 << 24, cwd: dirname(info.exe), timeout: 60 * 60 * 1000 });
    const mids = readdirSync(midDir).filter((f) => /\.png$/i.test(f)).sort();
    if (mids.length < 2) throw new Error("o RIFE não gerou os quadros");
    const diffs = await motion(ff, join(midDir, "%08d.png"));
    const pick = evenSteps(diffs, target, 24);
    // Os escolhidos viram a sequência final (um quadro repetido, se houver, é copiado de novo).
    let last = -1;
    pick.forEach((idx, k) => {
      const to = join(outDir, `${String(k + 1).padStart(8, "0")}.png`);
      if (idx !== last) renameSync(join(midDir, mids[Math.min(idx, mids.length - 1)]), to);
      else copyFileSync(join(outDir, `${String(k).padStart(8, "0")}.png`), to);
      last = idx;
    });
    await execFileP(ff, ["-y", "-hide_banner", "-loglevel", "error", "-framerate", "24", "-i", join(outDir, "%08d.png"),
      ...(vf ? ["-vf", vf] : []), "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { maxBuffer: 1 << 24 });
    return { frames, target, model: info.modelName };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
