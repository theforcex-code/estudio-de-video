// Tirar o fundo branco de um vídeo (ex.: o logo girando no branco) e gravar com transparência.
//
// Fundo = áreas grandes de branco liso. O miolo do anel também é fundo, mesmo cercado pelo metal,
// porque é uma área branca grande; os reflexos brancos do metal são pequenos e ficam.
// Na borda, a transparência é suave e a cor é "descontaminada" do branco, para não sobrar
// contorno claro quando o logo vai por cima de outra imagem.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function probe(ff, file) {
  try {
    await execFileP(ff, ["-hide_banner", "-i", file]);
  } catch (e) {
    const err = String(e.stderr);
    const size = /Video:.*?\b(\d{2,5})x(\d{2,5})\b/.exec(err);
    const fps = /(\d+(?:\.\d+)?) fps/.exec(err);
    if (size) return { w: Number(size[1]), h: Number(size[2]), fps: fps ? Number(fps[1]) : 24 };
  }
  throw new Error("Não consegui ler o vídeo");
}

// Máscara de um quadro: 1 = logo, 0 = fundo, com borda suave.
function matte(px, w, h) {
  const n = w * h;
  const white = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = px[i * 3], g = px[i * 3 + 1], b = px[i * 3 + 2];
    const lo = Math.min(r, g, b), hi = Math.max(r, g, b);
    if (lo >= 228 && hi - lo <= 14) white[i] = 1;
  }
  // Manchas brancas grandes (ou que tocam a borda) são fundo; pequenas são reflexo do metal.
  const bg = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const minArea = n * 0.004;
  const stack = [], comp = [];
  for (let s = 0; s < n; s++) {
    if (!white[s] || seen[s]) continue;
    comp.length = 0;
    let edge = false;
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const p = stack.pop();
      comp.push(p);
      const x = p % w, y = (p / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      if (x > 0 && white[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < w - 1 && white[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && white[p - w] && !seen[p - w]) { seen[p - w] = 1; stack.push(p - w); }
      if (y < h - 1 && white[p + w] && !seen[p + w]) { seen[p + w] = 1; stack.push(p + w); }
    }
    if (edge || comp.length >= minArea) for (const p of comp) bg[p] = 1;
  }
  // Borda: perto do fundo, a transparência segue o quanto o pixel ainda é branco.
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (bg[i]) { a[i] = 0; continue; }
    // Borda do quadro: o Seedance costuma deixar uma linha cinza de 1–2 px em cima e embaixo, que viraria
    // um risco no Compor. Uma faixa fina em volta do quadro é sempre transparente.
    { const x = i % w, y = (i / w) | 0, m = Math.max(3, Math.round(Math.min(w, h) * 0.006));
      if (x < m || y < m || x >= w - m || y >= h - m) { a[i] = 0; continue; } }
    const x = i % w, y = (i / w) | 0;
    let near = false;
    for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && bg[yy * w + xx]) { near = true; break; }
    }
    if (!near) { a[i] = 1; continue; }
    const lo = Math.min(px[i * 3], px[i * 3 + 1], px[i * 3 + 2]);
    a[i] = Math.min(1, Math.max(0, (252 - lo) / 70));
  }
  return a;
}

// Uma imagem (ex.: o logo de frente no branco) -> PNG com transparência, com a mesma regra do vídeo.
export async function cutoutImage(ff, src, outPng) {
  // Imagem que já tem transparência (PNG com fundo transparente): usa como está, sem recortar.
  const head = await execFileP(ff, ["-hide_banner", "-i", src]).catch((e) => ({ stderr: String(e.stderr) }));
  if (/Video:.*\b(rgba|ya8|ya16|rgba64|pal8)\b/.test(String(head.stderr))) {
    await execFileP(ff, ["-y", "-hide_banner", "-loglevel", "error", "-i", src, "-frames:v", "1", "-pix_fmt", "rgba", outPng]);
    return;
  }
  const { w, h } = await probe(ff, src);
  const px = await new Promise((ok, bad) => {
    const p = spawn(ff, ["-hide_banner", "-loglevel", "error", "-i", src, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    const parts = [];
    p.stdout.on("data", (d) => parts.push(d));
    p.on("close", (c) => (c ? bad(new Error("Não consegui ler a imagem do logo")) : ok(Buffer.concat(parts))));
  });
  const a = matte(px, w, h);
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const al = a[i];
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.max(0, Math.min(255, Math.round(al > 0.02 ? (px[i * 3 + c] - (1 - al) * 255) / al : 0)));
    out[i * 4 + 3] = Math.round(al * 255);
  }
  await new Promise((ok, bad) => {
    const p = spawn(ff, ["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-i", "-", outPng]);
    p.on("close", (c) => (c ? bad(new Error("Não consegui gravar o logo sem fundo")) : ok()));
    p.stdin.end(out);
  });
}

// Gera <saida>.mov (ProRes 4444 com transparência, para a edição) e <saida>.webm (prévia no navegador).
// maxSec: só os primeiros segundos (o Compor só usa a duração do vídeo de fundo).
export async function cutout(ff, src, outMov, outWebm, maxSec = 0, startSec = 0) {
  const { w, h, fps } = await probe(ff, src);
  const dec = spawn(ff, ["-hide_banner", "-loglevel", "error", ...(startSec > 0 ? ["-ss", String(startSec)] : []), "-i", src, ...(maxSec > 0 ? ["-t", String(maxSec)] : []), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const enc = (args) => spawn(ff, ["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-r", String(fps), "-i", "-", ...args], { stdio: ["pipe", "ignore", "pipe"] });
  const mov = enc(["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0", outMov]);
  const webm = enc(["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "34", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-auto-alt-ref", "0", "-vf", "scale=min(iw\\,640):-2", outWebm]); // prévia leve e rápida (o .mov é o de verdade)
  const errs = [];
  for (const p of [dec, mov, webm]) p.stderr.on("data", (d) => errs.push(String(d)));
  const done = (p) => new Promise((ok, bad) => p.on("close", (c) => (c ? bad(new Error(errs.join(" ").trim().split("\n").pop() || `ffmpeg saiu com ${c}`)) : ok())));
  const write = (p, buf) => new Promise((ok) => (p.stdin.write(buf) ? ok() : p.stdin.once("drain", ok)));

  const FRAME = w * h * 3;
  let buf = Buffer.alloc(0), frames = 0, chain = Promise.resolve();
  dec.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= FRAME) {
      const px = Buffer.from(buf.subarray(0, FRAME));
      buf = buf.subarray(FRAME);
      frames++;
      chain = chain.then(async () => {
        const a = matte(px, w, h);
        const out = Buffer.alloc(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          const al = a[i];
          for (let c = 0; c < 3; c++) {
            // Tira o branco que vazou na borda: cor = (cor - (1 - a) * branco) / a.
            const v = al > 0.02 ? (px[i * 3 + c] - (1 - al) * 255) / al : 0;
            out[i * 4 + c] = Math.max(0, Math.min(255, Math.round(v)));
          }
          out[i * 4 + 3] = Math.round(al * 255);
        }
        await write(mov, out);
        await write(webm, out);
      });
    }
  });
  await done(dec);
  await chain;
  mov.stdin.end();
  webm.stdin.end();
  await Promise.all([done(mov), done(webm)]);
  return { frames, w, h };
}
