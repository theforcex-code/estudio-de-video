// Apagar, quadro a quadro, a Forma (o anel de metal) que se mexe num vídeo de ondas da parede branca:
// em cada quadro, o contorno dela vira branco liso, com borda suave. Usado pelo Compor antes de pôr
// o logo girando por cima, quando o vídeo de fundo foi gerado com a Forma girando.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function videoSize(ff, file) {
  try {
    await execFileP(ff, ["-hide_banner", "-i", file]);
  } catch (e) {
    const m = /Video:.*?\b(\d{2,5})x(\d{2,5})\b/.exec(String(e.stderr));
    const fps = /(\d+(?:\.\d+)?) fps/.exec(String(e.stderr));
    if (m) return { w: Number(m[1]), h: Number(m[2]), fps: fps ? Number(fps[1]) : 24 };
  }
  throw new Error("Não consegui ler o vídeo de fundo");
}

// Um quadro: o metal (pixels escuros na direita, onde fica a Forma) define o contorno; tudo dentro
// do contorno, mais uma margem pequena, vira branco.
function eraseFrame(px, W, H) {
  const X0 = Math.round(W * 0.72), GROW = Math.max(3, Math.round(W * 0.004));
  const pts = [];
  for (let y = 0; y < H; y++) for (let x = X0; x < W; x++) {
    const i = (y * W + x) * 3;
    if (0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2] < 150) pts.push([x, y]);
  }
  if (pts.length < 20) return px; // nenhuma Forma neste quadro
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), p) <= 0) lo.pop(); lo.push(p); }
  for (const p of [...pts].reverse()) { while (up.length >= 2 && cross(up.at(-2), up.at(-1), p) <= 0) up.pop(); up.push(p); }
  const hull = lo.slice(0, -1).concat(up.slice(0, -1));
  const seg = (x, y, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
  };
  const xs = hull.map((p) => p[0]), ys = hull.map((p) => p[1]);
  const o = Buffer.from(px);
  for (let y = Math.max(0, Math.min(...ys) - GROW * 2); y <= Math.min(H - 1, Math.max(...ys) + GROW * 2); y++)
    for (let x = Math.max(0, Math.min(...xs) - GROW * 2); x <= Math.min(W - 1, Math.max(...xs) + GROW * 2); x++) {
      let inside = true;
      for (let k = 0; k < hull.length; k++) if (cross(hull[k], hull[(k + 1) % hull.length], [x, y]) < 0) { inside = false; break; }
      let m = 1;
      if (!inside) {
        let d = Infinity;
        for (let k = 0; k < hull.length; k++) d = Math.min(d, seg(x, y, hull[k], hull[(k + 1) % hull.length]));
        m = d <= GROW ? 1 : d <= GROW * 2 ? 1 - (d - GROW) / GROW : 0;
      }
      if (!m) continue;
      const i = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) o[i + c] = Math.round(px[i + c] * (1 - m) + 255 * m);
    }
  return o;
}

export async function eraseMovingForm(ff, src, out) {
  const { w, h, fps } = await videoSize(ff, src);
  const dec = spawn(ff, ["-hide_banner", "-loglevel", "error", "-i", src, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const enc = spawn(ff, ["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-r", String(fps), "-i", "-",
    "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { stdio: ["pipe", "ignore", "pipe"] });
  const errs = [];
  for (const p of [dec, enc]) p.stderr.on("data", (d) => errs.push(String(d)));
  const done = (p) => new Promise((ok, bad) => p.on("close", (c) => (c ? bad(new Error(errs.join(" ").trim().split("\n").pop() || `ffmpeg saiu com ${c}`)) : ok())));
  const F = w * h * 3;
  let buf = Buffer.alloc(0), frames = 0;
  dec.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= F) {
      enc.stdin.write(eraseFrame(buf.subarray(0, F), w, h));
      buf = buf.subarray(F);
      frames++;
    }
  });
  await done(dec);
  enc.stdin.end();
  await done(enc);
  return { frames };
}
