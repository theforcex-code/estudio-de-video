#!/usr/bin/env node
// Estúdio de vídeo local: serve a interface de nodes e conversa com o ArgoLink.
// A chave fica só aqui no servidor: variável ARGOLINK_API_KEY ou CHAVE-ARGOLINK.txt
// (na pasta do estúdio ou na pasta acima dela).
//
//   node estudio/server.mjs   →   http://localhost:4321

import { createServer } from "node:http";
import { cutout, cutoutImage } from "./cutout.mjs";
import { eraseMovingForm } from "./forma-movel.mjs";
import { rifeInfo, rifeSlow } from "./rife.mjs";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, createReadStream, createWriteStream, rmSync, renameSync, readdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import { resolve, dirname, extname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { MODELS } from "./public/models.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PUBLIC = join(HERE, "public");
const UPLOADS = join(HERE, "uploads");
// Vídeos gerados: ESTUDIO_VIDEOS, ou a pasta videos-gerados ao lado do estúdio (se já existir), ou dentro dele.
const VIDEOS = process.env.ESTUDIO_VIDEOS
  || (existsSync(join(ROOT, "videos-gerados")) ? join(ROOT, "videos-gerados") : join(HERE, "videos-gerados"));
const logoTasks = new Map(); // tarefas do nó Logo 3D: id -> { status, progress, total, file, error }
const JOBS_FILE = join(HERE, "jobs.json");
const PORT = Number(process.env.PORT) || 4321;
const BASE = "https://argolink.io";
const execFileP = promisify(execFile);

mkdirSync(UPLOADS, { recursive: true });
mkdirSync(VIDEOS, { recursive: true });

function loadKey() {
  if (process.env.ARGOLINK_API_KEY) return process.env.ARGOLINK_API_KEY;
  for (const keyFile of [join(HERE, "CHAVE-ARGOLINK.txt"), join(ROOT, "CHAVE-ARGOLINK.txt")]) {
    if (!existsSync(keyFile)) continue;
    const k = readFileSync(keyFile, "utf8").split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("sk-"));
    if (k) return k;
  }
  return null;
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".svg": "image/svg+xml",
};

// ---------- ArgoLink ----------

async function argo(path, init = {}) {
  const key = loadKey();
  if (!key) throw Object.assign(new Error("Chave não encontrada em CHAVE-ARGOLINK.txt"), { status: 401 });
  const res = await fetch(BASE + path, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j.message || j.error?.message || text;
    } catch {
      // Página de erro em HTML (Cloudflare, servidor fora do ar): vira uma frase curta.
      if (/^\s*</.test(text)) {
        msg = res.status >= 500
          ? `O ArgoLink está com instabilidade agora (erro ${res.status}). Nada foi gerado nem cobrado; tente de novo em alguns minutos.`
          : `O ArgoLink recusou o pedido (erro ${res.status}).`;
      }
    }
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return res;
}

// Imagem local → media_url do ArgoLink. Vale 7 dias; reenviamos depois de 6.
const mediaCache = new Map();
async function mediaUrl(model, file) {
  // Imagens e vídeos de referência: em uploads/; um vídeo pronto ligado por fio está em videos-gerados/.
  const up = join(UPLOADS, basename(file));
  const path = existsSync(up) ? up : join(VIDEOS, basename(file));
  // A data do arquivo entra na chave: uma imagem trocada com o mesmo nome é enviada de novo.
  const cacheKey = `${model}:${file}:${existsSync(path) ? statSync(path).mtimeMs : 0}`;
  const hit = mediaCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 6 * 864e5) return hit.url;
  const ext = extname(path).toLowerCase();
  const video = ext === ".mp4" || ext === ".mov";  // vídeo de referência (movimento)
  const contentType = video ? (ext === ".mov" ? "video/quicktime" : "video/mp4") : ext === ".png" ? "image/png" : "image/jpeg";
  const ticket = await (await argo("/v1/media/uploads", {
    method: "POST",
    body: JSON.stringify({ model, type: video ? "video" : "image", content_type: contentType, size_bytes: statSync(path).size }),
  })).json();
  const put = await fetch(ticket.upload_url, { method: "PUT", headers: { "Content-Type": contentType }, body: readFileSync(path) });
  if (!put.ok) throw new Error(`Upload ${video ? "do vídeo" : "da imagem"} falhou (${put.status})`);
  mediaCache.set(cacheKey, { url: ticket.media_url, at: Date.now() });
  return ticket.media_url;
}

// URL de uma imagem para o pedido. O Grok também aceita a imagem embutida (data URL): se o
// envio para o ArgoLink não servir para esse modelo, ela vai embutida no próprio pedido.
async function imageRef(m, model, file) {
  try {
    // O Grok não tem envio de mídia no ArgoLink ("not supported for this platform"), mas lê
    // qualquer link HTTPS público: sobe pelo envio do Seedance e passa só o link (pedido pequeno).
    // Embutir as imagens no pedido deixava ele com ~6 MB e o ArgoLink caía com 502.
    return await mediaUrl(m.api === "grok" ? "seedance-2.0" : model, file);
  } catch (e) {
    if (m.api !== "grok") throw e;
    const path = join(UPLOADS, basename(file));
    const type = extname(path).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
    return `data:${type};base64,${readFileSync(path).toString("base64")}`;
  }
}

// ---------- Tarefas ----------

let jobs = existsSync(JOBS_FILE) ? JSON.parse(readFileSync(JOBS_FILE, "utf8")) : [];
const saveJobs = () => writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
const recent = new Map(); // pedidos recentes, para barrar duplicados

// Envio interrompido numa execução anterior: as partes registradas seguem; sem nenhuma, o pedido falhou.
for (const j of jobs) {
  if (!j.submitting) continue;
  delete j.submitting;
  if (!j.parts?.length) {
    j.status = "failed";
    j.error = "O envio foi interrompido antes de começar; nada foi cobrado.";
  } else if (j.parts.length < (j.tiles?.length || 0) && j.status === "pending") {
    j.status = "failed";
    j.error = `O envio foi interrompido: ${j.parts.length} de ${j.tiles.length} partes chegaram a ser enviadas. Use "Refazer só as partes que falharam".`;
    for (let i = j.parts.length; i < j.tiles.length; i++) j.parts.push({ id: null, model: j.model, resolution: j.resolution, duration: j.duration, created: j.created, status: "failed", progress: 0, file: null, error: "não enviada", billed: null });
  }
}

// Pedidos sendo enviados ao ArgoLink agora. Ao desligar (Ctrl+C), o servidor espera eles
// terminarem, para nenhuma cobrança ficar sem registro.
let inflight = 0;
const tracked = async (fn) => {
  inflight++;
  try {
    return await fn();
  } finally {
    inflight--;
  }
};
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (!inflight) {
      saveJobs();
      process.exit(0);
    }
    console.log("Esperando os pedidos em envio serem registrados antes de desligar…");
    const t0 = Date.now();
    const wait = setInterval(() => {
      if (inflight && Date.now() - t0 < 90000) return;
      clearInterval(wait);
      saveJobs();
      process.exit(0);
    }, 200);
  });
}

const fail400 = (msg) => Object.assign(new Error(msg), { status: 400 });

// Monta o corpo do pedido e envia uma tarefa ao ArgoLink; devolve o request_id.
// "@image1", "@Image 2"… no prompt são citações de imagens de referência para o ArgoLink, que
// recusa o pedido se não houver nenhuma. O estúdio usa first/last frame, então troca pelo nome certo.
const cleanPrompt = (text) => text
  .replace(/@\s*image\s*1\b/gi, "the first frame")
  .replace(/@\s*image\s*2\b/gi, "the last frame")
  .replace(/@\s*(image|imagem|video|vídeo|audio|áudio)\s*\d+/gi, "the image");

const GROK_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"];
const VIEW_NAMES = ["front", "right side", "back", "left side"];

// Frase que aponta o modelo para as imagens de referência (no Grok, citadas como <IMAGE_0>…).
function refsSentence(n) {
  const tags = Array.from({ length: n }, (_, i) => `<IMAGE_${i}>`);
  const views = n === 4 ? `, which show it from the ${VIEW_NAMES.join(", ")}` : "";
  return `The logo ring must look exactly like the reference images ${tags.join(", ")}${views}: keep its exact shape, thickness and twist from every angle, and never deform it.`;
}

async function submit(m, input, start, end, aspect, refs = []) {
  if (m.api === "grok") {
    // Grok: image / last_frame / reference_images, e pode juntar quadros com referências.
    const body = { model: input.model, prompt: cleanPrompt(input.prompt), duration: input.duration, resolution: input.resolution, generate_audio: false };
    const step = async (name, fn) => {
      try {
        return await fn();
      } catch (e) {
        throw Object.assign(new Error(`${name}: ${e.message}`), { status: e.status });
      }
    };
    await step("Ao enviar as imagens", async () => {
      if (start) {
        body.image = { url: await imageRef(m, input.model, start) };
        if (end) body.last_frame = { url: await imageRef(m, input.model, end) };
      } else if (GROK_RATIOS.includes(aspect)) {
        body.aspect_ratio = aspect;
      }
      if (refs.length) {
        body.reference_images = await Promise.all(refs.map(async (f) => ({ url: await imageRef(m, input.model, f) })));
        body.prompt = `${body.prompt}\n\n${refsSentence(refs.length)}`;
      }
    });
    const kb = Math.round(JSON.stringify(body).length / 1024);
    console.log(`Grok: pedido com ${refs.length} referências, ${kb} KB`);
    const res = await step("Ao criar o vídeo no Grok", async () => (await argo("/v1/videos/generations", { method: "POST", body: JSON.stringify(body) })).json());
    return { id: res.request_id, aspect: body.aspect_ratio || "do frame" };
  }
  const body = { model: input.model, prompt: cleanPrompt(input.prompt), duration: input.duration, resolution: input.resolution };
  // Referências (Seedance 2.0): imagem = o que é a cena, vídeo = o movimento. Não combinam com first/last frame.
  if (input.refVideos?.length || input.refImages?.length) {
    if (input.refImages?.length) body.reference_images = await Promise.all(input.refImages.map(async (f) => ({ url: await mediaUrl(input.model, f) })));
    if (input.refVideos?.length) body.reference_videos = await Promise.all(input.refVideos.map(async (f) => ({ url: await mediaUrl(input.model, f) })));
    if (aspect && aspect !== "adaptive") body.aspect_ratio = aspect;
    if (!m.alwaysAudio) body.generate_audio = false;
    console.log(`Seedance: pedido com ${input.refImages?.length || 0} imagem(ns) e ${input.refVideos?.length || 0} vídeo(s) de referência`);
    const res = await (await argo("/v1/videos/generations", { method: "POST", body: JSON.stringify(body) })).json();
    return { id: res.request_id, aspect: body.aspect_ratio || "16:9" };
  }
  if (start) {
    body.start_image = { url: await mediaUrl(input.model, start) };
    if (end) body.end_image = { url: await mediaUrl(input.model, end) };
    // Com quadros, 2.5 e H3 só aceitam "adaptive"; os outros podem cortar numa proporção fixa.
    body.aspect_ratio = m.framesAdaptiveOnly || !aspect ? "adaptive" : aspect;
  } else if (aspect && aspect !== "adaptive") {
    body.aspect_ratio = aspect;
  }
  // Nada sai com som: o projeto não usa áudio, e o som gerado ainda pode ser barrado por direitos autorais.
  if (!m.alwaysAudio) body.generate_audio = false;
  const res = await (await argo("/v1/videos/generations", { method: "POST", body: JSON.stringify(body) })).json();
  return { id: res.request_id, aspect: body.aspect_ratio || "16:9" };
}

async function createJob(input) {
  const m = MODELS[input.model];
  if (!m) throw fail400(`Modelo desconhecido: ${input.model}`);
  // Prompt por parte (panorâmica): vazio usa o principal; o principal só pode faltar se todas tiverem o seu.
  const partPrompts = input.pano?.prompts?.map((t) => (typeof t === "string" ? t.trim() : "")) || [];
  const allParts = input.pano && partPrompts.length === input.pano.tiles?.length && partPrompts.every(Boolean);
  if (!input.prompt?.trim() && !allParts) throw fail400("Escreva um prompt");
  if (!input.prompt?.trim()) input.prompt = partPrompts.join(" | ");
  input.duration = Number(input.duration) || 5;
  input.resolution = input.resolution || m.resolutions[0];

  const job = {
    group: input.group || randomUUID(),
    node: input.node || null,
    lockBlack: input.lockBlack === true && Boolean(input.start),
    // Imagens de referência (vistas do logo): só em modelos que aceitam junto com os quadros.
    refs: m.acceptsRefs && Array.isArray(input.refs) ? input.refs.filter((f) => typeof f === "string").slice(0, 9) : [],
    refsParts: Array.isArray(input.refsParts) ? input.refsParts.map(Number) : null,
    // Vídeo com referências (imagem + vídeo de movimento), sem first frame: arquivos de uploads/.
    refImages: Array.isArray(input.refImages) ? input.refImages.filter((f) => typeof f === "string").slice(0, 9) : [],
    refVideos: Array.isArray(input.refVideos) ? input.refVideos.filter((f) => typeof f === "string").slice(0, 3) : [],
    model: input.model,
    prompt: input.prompt,
    duration: input.duration,
    resolution: input.resolution,
    // Vídeo único: o envio usa a faixa 21:9; o pedido guarda a panorâmica original (trava dos pratos, prévia).
    start: (input.band && input.origStart) || input.start || null,
    end: (input.band && input.origEnd) || input.end || null,
    band: input.band && !input.pano ? bandOf(input.band) : null,
    status: "pending",
    progress: 0,
    eta: null,
    file: null,
    error: null,
    billed: null,
    created: new Date().toISOString(),
  };

  if (input.pano) {
    const p = input.pano;
    if (!Array.isArray(p.tiles) || p.tiles.length < 2) throw fail400("Panorâmica sem partes");
    job.id = `pano-${randomUUID().slice(0, 8)}`;
    job.aspect_ratio = `${(p.w / p.h).toFixed(2)}:1`;
    job.pano = { w: p.w, h: p.h, tileW: p.tileW, xs: p.xs };
    // Guardadas para "refazer só as partes que falharam".
    job.tiles = p.tiles;
    job.endTiles = p.endTiles || null;
    job.partPrompts = partPrompts.some(Boolean) ? partPrompts : null;
    job.parts = [];
    // O pedido entra no histórico antes do primeiro envio e é salvo a cada parte enviada:
    // assim nenhuma parte cobrada fica sem registro, mesmo se o servidor cair no meio.
    job.submitting = true;
    jobs.unshift(job);
    saveJobs();
    for (let i = 0; i < p.tiles.length; i++) {
      try {
        // As referências vão só para as partes marcadas como "com o logo" (as outras poderiam inventar um).
        const refs = !job.refsParts || job.refsParts.includes(i + 1) ? job.refs : [];
        const { id } = await submit(m, { ...input, prompt: partPrompts[i] || input.prompt }, p.tiles[i], p.endTiles?.[i], "21:9", refs);
        job.parts.push({ id, model: job.model, resolution: job.resolution, duration: job.duration, created: job.created, status: "pending", progress: 0, file: null, error: null, billed: null });
        saveJobs();
      } catch (e) {
        if (!job.parts.length) {
          jobs = jobs.filter((x) => x !== job);
          saveJobs();
          throw e;
        }
        job.status = "failed";
        job.error = `Parte ${i + 1} recusada: ${e.message}. As ${job.parts.length} anteriores já foram enviadas e serão cobradas.`;
        break;
      }
    }
    delete job.submitting;
    saveJobs();
    return job;
  } else {
    const { id, aspect } = await submit(m, input, input.start, input.end, input.aspect_ratio, job.refs);
    job.id = id;
    job.aspect_ratio = job.band ? `${job.band.ratio.toFixed(2)}:1` : aspect;
  }
  jobs.unshift(job);
  saveJobs();
  return job;
}

async function pollJob(job) {
  try {
    const s = await (await argo(`/v1/videos/${job.id}`)).json();
    job.progress = s.progress ?? job.progress;
    job.eta = s.estimated_seconds_remaining ?? null;
    if (s.status === "done") {
      const video = await argo(`/v1/videos/${job.id}/content`);
      const name = `${job.created.slice(0, 10)}-${job.model}-${job.resolution}-${job.id.slice(0, 8)}.mp4`;
      const raw = join(VIDEOS, `_${name}`);
      writeFileSync(raw, Buffer.from(await video.arrayBuffer()));
      // Tira a faixa de som (o H3 sempre gera uma), sem recodificar o vídeo.
      try {
        await execFileP(ffmpeg.path, ["-y", "-hide_banner", "-loglevel", "error", "-i", raw, "-map", "0:v", "-c", "copy", "-movflags", "+faststart", join(VIDEOS, name)]);
        rmSync(raw, { force: true });
      } catch {
        renameSync(raw, join(VIDEOS, name));
      }
      job.file = name;
      job.billed = s.usage?.billed_seconds ?? job.duration;
      if (job.band) await cropBand(job);
      if (job.lockBlack) await lockBlackSafe(job);
      job.status = "done";
      job.progress = 100;
    } else if (s.status !== "pending") {
      job.status = s.status;
      job.error = s.error?.message || s.error?.code || s.status;
    }
  } catch (e) {
    // 404 = a tarefa sumiu; outros erros (rede, 5xx) tentam de novo no próximo ciclo.
    if (e.status === 404) {
      job.status = "failed";
      job.error = e.message;
    }
  }
}

// Faixa da parede dentro do quadro 21:9 (frações da altura) e proporção final.
function bandOf(b) {
  const y = Number(b.y), h = Number(b.h), ratio = Number(b.ratio);
  if (!(y >= 0 && h > 0 && y + h <= 1.001 && ratio > 1)) throw fail400("Faixa do vídeo único inválida");
  return { y, h, ratio };
}

// Corta do vídeo 21:9 só a faixa da parede (as bordas desfocadas saem), na proporção da panorâmica.
async function cropBand(job) {
  const src = join(VIDEOS, job.file);
  const name = job.file.replace(/\.mp4$/, "-parede.mp4");
  const { y, h, ratio } = job.band;
  try {
    await execFileP(ffmpeg.path, ["-y", "-hide_banner", "-loglevel", "error", "-i", src, "-an",
      // fillborders: só 1 linha de cada lado. Com as faixas desfocadas o modelo desenhava uma linha na divisa e eram
      // 3–4 linhas copiadas; com a borda espelhada (bandImage) não há divisa, e copiar mais linhas fazia riscos verticais
      // onde uma fita cruza a borda.
      "-vf", `crop=iw:trunc(ih*${h}/2)*2:0:trunc(ih*${y}),fillborders=top=1:bottom=1:mode=smear,scale=trunc(ih*${ratio}/2)*2:ih:flags=lanczos,setsar=1`,
      "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(VIDEOS, name)]);
    job.fileFull = job.file; // o quadro 21:9 inteiro fica guardado
    job.file = name;
  } catch (e) {
    job.cropError = `Não consegui recortar a faixa (${e.message}); ficou o quadro 21:9 inteiro.`;
  }
}

async function pollPano(job) {
  await Promise.all(job.parts.filter((p) => p.status === "pending").map(pollJob));
  job.billed = job.parts.reduce((s, p) => s + (p.billed || 0), 0) || null;
  if (job.status !== "pending" || job.submitting) return;
  job.progress = Math.round((job.parts.reduce((s, p) => s + (p.progress || 0), 0) / job.parts.length) * 0.95);
  const bad = job.parts.findIndex((p) => p.status !== "pending" && p.status !== "done");
  if (bad >= 0) {
    job.status = "failed";
    job.error = `Parte ${bad + 1} falhou: ${job.parts[bad].error}`;
  } else if (job.parts.every((p) => p.status === "done")) {
    runStitch(job);
  }
}

function runStitch(job) {
  job.status = "stitching";
  stitch(job)
    .then(async (name) => {
      job.file = name;
      if (job.lockBlack) await lockBlackSafe(job);
      job.stitchedAt = Date.now();
      job.status = "done";
      job.progress = 100;
    })
    .catch((e) => {
      job.status = "failed";
      job.error = `A emenda falhou: ${e.message}. As partes estão em videos-gerados/.`;
    })
    .finally(saveJobs);
}

// ---------- Travar áreas pretas (pratos da mesa) ----------

// Cola por cima do vídeo, em todos os frames, as áreas pretas da imagem inicial (os pratos):
// eles ficam exatamente no tamanho e no lugar da imagem, não importa o que o modelo fez.
// Uma cópia sem a trava fica guardada como "-sem-trava.mp4".
const BLACK_LEVEL = 6; // abaixo disso (0–255) é "preto de prato"; a água escura fica acima
const MIN_BLOB = 0.002; // área mínima de uma mancha preta para contar como prato (fração da imagem)

// Máscara dos pratos: manchas pretas grandes da imagem, no tamanho do vídeo. Pixels escuros
// soltos da água ficam de fora, porque são manchas pequenas.
async function plateMask(src, w, h, path) {
  const { stdout: g } = await execFileP(ffmpeg.path, ["-hide_banner", "-loglevel", "error", "-i", src, "-vf", `scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  const n = w * h;
  const label = new Int32Array(n);
  const keep = Buffer.alloc(n, 0);
  const stack = [];
  let next = 0;
  for (let i = 0; i < n; i++) {
    if (g[i] >= BLACK_LEVEL || label[i]) continue;
    const pixels = [];
    label[i] = ++next;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop();
      pixels.push(p);
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q >= 0 && q < n && !label[q] && g[q] < BLACK_LEVEL) {
          label[q] = next;
          stack.push(q);
        }
      }
    }
    if (pixels.length >= n * MIN_BLOB) for (const p of pixels) keep[p] = 255;
  }
  writeFileSync(path, Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), keep]));
}

// O vídeo travado é salvo com outro nome ("-travado"), sem sobrescrever o original: no Windows,
// um arquivo aberto pela página não pode ser trocado, e trocar no meio do envio derrubava o servidor.
// fresh: job.file acabou de ser gerado/emendado e é a versão sem trava.
async function lockBlack(job, fresh) {
  const src = join(UPLOADS, basename(job.start || ""));
  if (!job.start || !existsSync(src)) throw new Error("Não achei a imagem inicial deste vídeo");
  if (fresh || !job.fileUnlocked) {
    // Vídeos travados pela versão antiga guardavam o original como "-sem-trava".
    const legacy = job.file.replace(/\.mp4$/, "-sem-trava.mp4");
    job.fileUnlocked = !fresh && job.lockedBlack && existsSync(join(VIDEOS, legacy)) ? legacy : job.file;
  }
  const original = join(VIDEOS, job.fileUnlocked);
  const { w, h } = await videoSize(original);
  const lockedName = job.fileUnlocked.replace(/(-sem-trava)?\.mp4$/, `-travado-${Date.now().toString(36)}.mp4`);
  const tmp = join(VIDEOS, lockedName);
  const mask = join(UPLOADS, `pratos-${job.id}.pgm`);
  await plateMask(src, w, h, mask);
  try {
    await execFileP(ffmpeg.path, [
      "-y", "-hide_banner", "-loglevel", "error",
      // A máscara é uma imagem: repetida a 24 q/s só pela duração do vídeo, senão o ffmpeg espera para sempre.
      "-i", original, "-i", src, "-framerate", "24", "-loop", "1", "-t", String(job.duration || 5), "-i", mask,
      "-filter_complex",
      `[1:v]scale=${w}:${h},format=gbrp[top];` +
      `[2:v]format=gray,dilation,gblur=sigma=1.2,format=gbrp[m];` +
      `[0:v]format=gbrp[base];` +
      `[base][top][m]maskedmerge,format=yuv420p[out]`,
      "-map", "[out]", "-an", "-t", String(job.duration || 5),
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      tmp,
    ], { maxBuffer: 16 * 1024 * 1024 });
  } finally {
    rmSync(mask, { force: true });
  }
  // A versão travada anterior, se houver, sai (se estiver aberta na página, fica para depois).
  if (job.lockedBlack && job.file !== job.fileUnlocked && job.file !== lockedName) {
    try { rmSync(join(VIDEOS, job.file), { force: true }); } catch {}
  }
  job.file = lockedName;
  job.lockedBlack = true;
  job.stitchedAt = Date.now(); // muda o endereço do vídeo, para a página não mostrar o antigo
}

async function lockBlackSafe(job) {
  try {
    await lockBlack(job, true);
  } catch (e) {
    job.error = `O vídeo ficou pronto, mas a trava dos pretos falhou: ${String(e.stderr || e.message).trim().split("\n").pop()}`;
  }
}

setInterval(async () => {
  const work = jobs.filter((j) => (j.parts ? j.status === "pending" || j.parts.some((p) => p.status === "pending") : j.status === "pending"));
  if (!work.length) return;
  await Promise.all(work.map((j) => (j.parts ? pollPano(j) : pollJob(j))));
  saveJobs();
}, 10000);

// ---------- Emenda panorâmica ----------

// Altura de saída por resolução pedida; as partes são reescaladas para ela.
const OUT_HEIGHT = { "480p": 480, "720p": 720, "768p": 768, "1080p": 1080, "2k": 1440, "4k": 2160 };
const MAX_WIDTH = 8192; // limite prático do H.264
const even = (v) => Math.max(2, Math.round(v / 2) * 2);

const SAMPLES = 8; // frames comparados por emenda
const MAX_SHIFT = 16; // deslocamento residual procurado entre partes vizinhas, em px de saída
const EDGE_WEIGHT = 0.6; // quanto a costura evita contornos (bordas das esferas, horizonte)

// Halo branco atrás do logo: a silhueta do logo, alargada e desfocada, em branco, com o logo por cima.
// O quadro do logo ganha uma margem transparente para o halo não ser cortado na borda.
function glowChain(g) {
  if (!(g > 0)) return "";
  const r = Math.min(250, g), pad = Math.ceil(r * 2.5);
  return `,pad=iw+${pad * 2}:ih+${pad * 2}:${pad}:${pad}:color=black@0,split[gm][gl];` +
    `[gl]alphaextract,gblur=sigma=${r},lut=y='min(255\\,val*1.6)'[ga];` +
    `[gm]split[gm1][gm2];[gm2]format=yuv444p,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill[gw];[gw][ga]alphamerge[gh];` +
    `[gh][gm1]overlay=0:0:format=yuv444,format=yuva444p`;
}

// Duração de um vídeo, em segundos (lida da saída do ffmpeg); 0 se não der.
// Cor do Ajuste com a mesma conta da prévia ao vivo (filtros CSS do navegador: brightness, contrast,
// saturate, sepia / hue-rotate), para o vídeo gravado sair com a cor que se viu na tela.
function cssLook(br, ct, sa, wa) {
  const mul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  const satM = (s) => [[0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s], [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s], [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s]];
  const sepiaM = (a) => { const k = 1 - a; return [[0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k], [0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k], [0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k]]; };
  const hueM = (deg) => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    return [[0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928], [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283], [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072]]; };
  const mix = (M) => { const f = (v) => v.toFixed(4); return `colorchannelmixer=rr=${f(M[0][0])}:rg=${f(M[0][1])}:rb=${f(M[0][2])}:gr=${f(M[1][0])}:gg=${f(M[1][1])}:gb=${f(M[1][2])}:br=${f(M[2][0])}:bg=${f(M[2][1])}:bb=${f(M[2][2])}`; };
  const parts = [];
  if (br) { const k = (1 + br * 1.6).toFixed(4); parts.push(`colorchannelmixer=rr=${k}:gg=${k}:bb=${k}`); }
  if (ct !== 1) { const e = `clip((val-127.5)*${ct}+127.5\\,0\\,255)`; parts.push(`lutrgb=r='${e}':g='${e}':b='${e}'`); }
  // Na ordem do CSS: saturate, depois o "calor" (sepia se quente; hue-rotate + saturate se frio).
  let M = null;
  if (sa !== 1) M = satM(sa);
  if (wa > 0) M = M ? mul(sepiaM(wa * 0.35), M) : sepiaM(wa * 0.35);
  if (wa < 0) { const W = mul(satM(1 - wa * 0.15), hueM(wa * 18)); M = M ? mul(W, M) : W; }
  if (M) parts.push(mix(M));
  return parts.length ? ["format=gbrp", ...parts].join(",") : "null";
}

async function mediaDuration(file) {
  try { await execFileP(ffmpeg.path, ["-hide_banner", "-i", file]); } catch (e) {
    const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(String(e.stderr));
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return 0;
}

// Tirar fundo de um vídeo: grava em arquivos temporários e só troca no fim, para quem estiver
// lendo o .mov (o Compor) nunca pegar um arquivo pela metade. Dois pedidos do mesmo vídeo ao
// mesmo tempo usam o mesmo trabalho.
// Nome dos recortes sem fundo. "2" = versão sem o risco da borda (os antigos são refeitos sozinhos).
const CUT_SUFFIX = "-sem-fundo2";
const cutting = new Map();
// maxSec > 0: só os primeiros segundos, num arquivo à parte ("…-sem-fundo2-12s.mov").
function cutoutSafe(src, maxSec = 0, startSec = 0) {
  const key = src + "|" + maxSec + "|" + startSec;
  if (cutting.has(key)) return cutting.get(key);
  const base = join(VIDEOS, basename(src).replace(/\.mp4$/i, "") + CUT_SUFFIX + (startSec > 0 ? `-a${startSec}` : "") + (maxSec > 0 ? `-${maxSec}s` : ""));
  const tmp = `${base}-${Date.now().toString(36)}.tmp`;
  const job = (async () => {
    const r = await cutout(ffmpeg.path, src, `${tmp}.mov`, `${tmp}.webm`, maxSec, startSec);
    for (const ext of [".mov", ".webm"]) {
      try {
        rmSync(base + ext, { force: true });
        renameSync(tmp + ext, base + ext);
      } catch {
        // No Windows, um arquivo aberto (ex.: tocando na página) não pode ser trocado: fica o antigo.
        rmSync(tmp + ext, { force: true });
      }
    }
    console.log(`Fundo tirado de ${basename(src)}${maxSec > 0 ? ` (só os primeiros ${maxSec} s)` : ""} (${r.frames} quadros)`);
    return r;
  })().finally(() => cutting.delete(key));
  cutting.set(key, job);
  return job;
}

// Tamanho real do vídeo, lido da saída do próprio ffmpeg (o instalador não traz ffprobe).
async function videoSize(file) {
  try {
    await execFileP(ffmpeg.path, ["-hide_banner", "-i", file]);
  } catch (e) {
    const m = /Video:.*?\b(\d{2,5})x(\d{2,5})\b/.exec(String(e.stderr));
    if (m) return { w: Number(m[1]), h: Number(m[2]) };
  }
  throw new Error(`Não consegui ler o tamanho de ${basename(file)}`);
}

// Onde cada parte cai na saída. O modelo não devolve a parte exatamente na proporção pedida
// (o "21:9" do Seedance sai 992×432, um pouco mais estreito): ele corta o centro. Então cada
// parte é escalada por igual e centralizada sobre o pedaço da imagem que ela representa.
async function placeParts(job) {
  const { w, h, tileW, xs } = job.pano;
  let outH = OUT_HEIGHT[job.resolution] || 720;
  if ((w * outH) / h > MAX_WIDTH) outH = Math.floor((MAX_WIDTH * h) / w);
  outH = even(outH);
  const k = outH / h;
  const tw = tileW * k;
  const P = [];
  for (let i = 0; i < job.parts.length; i++) {
    const file = join(VIDEOS, job.parts[i].file);
    const v = await videoSize(file);
    if (v.w / v.h <= tileW / h) {
      const pw = even((v.w * outH) / v.h);
      P.push({ file, pw, ph: outH, px: Math.round(xs[i] * k + (tw - pw) / 2), py: 0 });
    } else {
      const pw = even(tw), ph = even((v.h * pw) / v.w);
      P.push({ file, pw, ph, px: Math.round(xs[i] * k), py: Math.round((outH - ph) / 2) });
    }
  }
  return { outH, W: even(w * k), P };
}

// Frames em tons de cinza de uma faixa da parte, já na posição e escala de saída.
async function grayStrip(p, duration, outH, x, width) {
  const { stdout } = await execFileP(ffmpeg.path, [
    "-hide_banner", "-loglevel", "error", "-i", p.file,
    "-vf", `fps=${SAMPLES / duration},scale=${p.pw}:${p.ph},crop=${width}:${outH}:${x}:${-p.py},format=gray`,
    "-frames:v", String(SAMPLES), "-f", "rawvideo", "-",
  ], { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 });
  return stdout;
}

const overlapOf = (a, b) => ({ x: b.px - a.px, ov: a.px + a.pw - b.px });

function meanFrame(buf, size) {
  const n = Math.floor(buf.length / size);
  const m = new Float32Array(size);
  for (let f = 0; f < n; f++) for (let i = 0; i < size; i++) m[i] += buf[f * size + i];
  for (let i = 0; i < size; i++) m[i] /= n;
  return { m, n };
}

// Ajuste fino na horizontal: quanto a parte da direita ainda está fora do lugar.
async function residualShift(a, b, duration, outH) {
  const { x, ov } = overlapOf(a, b);
  if (ov < 4 * MAX_SHIFT) return 0;
  const [A, B] = await Promise.all([grayStrip(a, duration, outH, x, ov), grayStrip(b, duration, outH, 0, ov)]);
  const mA = meanFrame(A, ov * outH).m, mB = meanFrame(B, ov * outH).m;
  let best = 0, bestErr = Infinity, zeroErr = Infinity;
  for (let s = -MAX_SHIFT; s <= MAX_SHIFT; s++) {
    let err = 0, c = 0;
    for (let y = 8; y < outH - 8; y += 2) {
      for (let bx = MAX_SHIFT; bx < ov - MAX_SHIFT; bx += 2) {
        err += Math.abs(mA[y * ov + bx + s] - mB[y * ov + bx]);
        c++;
      }
    }
    if (s === 0) zeroErr = err / c;
    if (err / c < bestErr) { bestErr = err / c; best = s; }
  }
  // Em área lisa (céu, água) qualquer deslocamento parece igual: só aceita se melhorar de verdade
  // e não cair no limite da busca, que é sinal de que não achou um encaixe.
  if (Math.abs(best) >= MAX_SHIFT || bestErr > zeroErr * 0.9) return 0;
  return best;
}

// Costura: na sobreposição, um caminho de cima a baixo por onde as duas partes mais se parecem
// ao longo do vídeo e que foge de contornos fortes. A transição é estreita, só ali.
async function findSeam(a, b, duration, outH, feather) {
  const { x, ov } = overlapOf(a, b);
  const [A, B] = await Promise.all([grayStrip(a, duration, outH, x, ov), grayStrip(b, duration, outH, 0, ov)]);
  const size = ov * outH;
  const frames = Math.floor(Math.min(A.length, B.length) / size);
  const diff = new Float32Array(size);
  for (let f = 0; f < frames; f++) for (let i = 0; i < size; i++) diff[i] += Math.abs(A[f * size + i] - B[f * size + i]);
  const mA = meanFrame(A, size).m, mB = meanFrame(B, size).m;
  const cost = new Float32Array(size);
  for (let y = 0; y < outH; y++) {
    for (let xx = 0; xx < ov; xx++) {
      const i = y * ov + xx;
      const l = y * ov + Math.max(0, xx - 1), r = y * ov + Math.min(ov - 1, xx + 1);
      const u = Math.max(0, y - 1) * ov + xx, d = Math.min(outH - 1, y + 1) * ov + xx;
      const edge = Math.abs(mA[r] - mA[l]) + Math.abs(mA[d] - mA[u]) + Math.abs(mB[r] - mB[l]) + Math.abs(mB[d] - mB[u]);
      cost[i] = diff[i] / frames + EDGE_WEIGHT * edge;
    }
  }
  // Borra na horizontal para a faixa inteira da transição cair em área parecida.
  const rad = Math.max(1, feather >> 1);
  const blur = new Float32Array(size);
  const sum = new Float64Array(ov + 1);
  for (let y = 0; y < outH; y++) {
    const row = y * ov;
    for (let xx = 0; xx < ov; xx++) sum[xx + 1] = sum[xx] + cost[row + xx];
    for (let xx = 0; xx < ov; xx++) blur[row + xx] = sum[Math.min(ov, xx + rad + 1)] - sum[Math.max(0, xx - rad)];
  }
  // Caminho de menor custo, andando no máximo 2 px por linha, longe das bordas da sobreposição.
  const lo = feather, hi = ov - feather - 1;
  const M = new Float64Array(size).fill(Infinity);
  const from = new Int16Array(size);
  for (let xx = lo; xx <= hi; xx++) M[xx] = blur[xx];
  for (let y = 1; y < outH; y++) {
    for (let xx = lo; xx <= hi; xx++) {
      let best = Infinity, bx = xx;
      for (let dd = -2; dd <= 2; dd++) {
        const px = xx + dd;
        if (px < lo || px > hi) continue;
        const v = M[(y - 1) * ov + px];
        if (v < best) { best = v; bx = px; }
      }
      M[y * ov + xx] = best + blur[y * ov + xx];
      from[y * ov + xx] = bx;
    }
  }
  let sx = lo;
  for (let c = lo; c <= hi; c++) if (M[(outH - 1) * ov + c] < M[(outH - 1) * ov + sx]) sx = c;
  const seam = new Int32Array(outH);
  for (let y = outH - 1; y >= 0; y--) {
    seam[y] = sx;
    sx = from[y * ov + sx];
  }
  return seam;
}

// Máscara da parte da direita, no tamanho dela: transparente até a costura, rampa curta, opaca depois.
// PGM é o formato mais simples que o ffmpeg lê.
function writeMask(path, p, outH, seam, feather) {
  const data = Buffer.alloc(p.pw * p.ph, 255);
  for (let r = 0; r < p.ph; r++) {
    const s = seam[Math.min(outH - 1, Math.max(0, r + p.py))];
    for (let x = 0; x < Math.min(p.pw, s + feather); x++) {
      data[r * p.pw + x] = x < s - feather ? 0 : Math.round((255 * (x - (s - feather))) / (2 * feather));
    }
  }
  writeFileSync(path, Buffer.concat([Buffer.from(`P5\n${p.pw} ${p.ph}\n255\n`), data]));
}

async function stitch(job) {
  const { outH, W, P } = await placeParts(job);
  const n = P.length;
  const feather = Math.max(6, Math.round(outH / 40));

  const masks = [];
  try {
    for (let i = 1; i < n; i++) {
      const s = await residualShift(P[i - 1], P[i], job.duration, outH);
      P[i].px += s;
      console.log(`Emenda ${job.id}, parte ${i + 1}: ${P[i].pw}×${P[i].ph}, ajuste fino ${s} px`);
      const seam = await findSeam(P[i - 1], P[i], job.duration, outH, feather);
      const mask = join(UPLOADS, `mask-${job.id}-${i}.pgm`);
      writeMask(mask, P[i], outH, seam, feather);
      masks.push(mask);
    }

    // As partes vêm com as bordas externas um pouco cortadas: enquadra só a área coberta e
    // volta à largura da panorâmica (diferença de menos de 1%).
    const x0 = Math.max(0, P[0].px), x1 = P[n - 1].px + P[n - 1].pw;
    const baseW = even(Math.max(W, x1));
    const f = [`color=c=black:s=${baseW}x${outH}:r=24[base]`];
    for (let i = 0; i < n; i++) {
      const v = `[${i}:v]scale=${P[i].pw}:${P[i].ph},setsar=1,fps=24`;
      if (i === 0) f.push(`${v}[v0]`);
      else f.push(`${v},format=yuva420p[c${i}]`, `[${n + i - 1}:v]format=gray[m${i}]`, `[c${i}][m${i}]alphamerge[v${i}]`);
    }
    let last = "base";
    for (let i = 0; i < n; i++) {
      f.push(`[${last}][v${i}]overlay=x=${P[i].px}:y=${P[i].py}:shortest=1[o${i}]`);
      last = `o${i}`;
    }
    f.push(`[${last}]crop=${even(x1 - x0)}:${outH}:${x0}:0,scale=${W}:${outH},setsar=1,format=yuv420p[out]`);

    const name = `${job.created.slice(0, 10)}-${job.model}-${job.resolution}-panoramico-${job.id.slice(5)}.mp4`;
    await execFileP(ffmpeg.path, [
      "-y", "-hide_banner", "-loglevel", "error",
      ...P.flatMap((p) => ["-i", p.file]),
      ...masks.flatMap((m) => ["-loop", "1", "-i", m]),
      "-filter_complex", f.join(";"),
      "-map", "[out]", "-an",
      "-t", String(job.duration),
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      join(VIDEOS, name),
    ], { maxBuffer: 16 * 1024 * 1024 });
    return name;
  } catch (e) {
    throw new Error(String(e.stderr || e.message).trim().split("\n").slice(-3).join(" "));
  } finally {
    for (const m of masks) rmSync(m, { force: true });
  }
}

// ---------- HTTP ----------

const json = (res, status, data) => {
  // Se a resposta já começou (um vídeo sendo enviado, por exemplo), não dá para mandar outra: só fecha.
  if (res.headersSent) return res.destroy();
  if (status >= 400 && status !== 404) console.error(`Recusado (${status}): ${data?.error || ""}`);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
};

const readBody = (req) =>
  new Promise((ok, fail) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });

// Arquivos com suporte a Range, para o <video> conseguir avançar e voltar.
function sendFile(req, res, path, download = false) {
  if (!existsSync(path) || !statSync(path).isFile()) return json(res, 404, { error: "Não encontrado" });
  const size = statSync(path).size;
  const type = TYPES[extname(path).toLowerCase()] || "application/octet-stream";
  // Se o arquivo for trocado no meio do envio (emenda refeita, pratos travados), a leitura falha:
  // fecha só essa conexão, sem derrubar o servidor.
  const stream = (opts) => createReadStream(path, opts).on("error", () => res.destroy()).pipe(res);
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
    // Pedido de um trecho que não existe mais (o arquivo ficou menor): avisa o navegador para pedir de novo.
    if (start >= size || end < start) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1, "Cache-Control": "no-store" });
    return stream({ start, end });
  }
  const headers = { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  if (download) headers["Content-Disposition"] = `attachment; filename="${basename(path)}"`;
  res.writeHead(200, headers);
  stream();
}

// "Versão" da página: a data do arquivo mais novo da interface. A página compara com a dela
// e avisa para recarregar quando o estúdio foi atualizado.
const pageBuild = () => Math.max(...readdirSync(PUBLIC).map((f) => statSync(join(PUBLIC, f)).mtimeMs));

// Só nomes simples: nada de "../" escapando das pastas.
const safe = (name) => basename(decodeURIComponent(name));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    if (p === "/api/status" && req.method === "GET") {
      const build = pageBuild();
      if (!loadKey()) return json(res, 200, { key: false, build });
      try {
        const b = await (await argo("/v1/account/balance")).json();
        return json(res, 200, { key: true, available: b.available, held: b.held, build });
      } catch (e) {
        return json(res, 200, { key: true, error: e.message, build });
      }
    }

    if (p === "/api/upload" && req.method === "POST") {
      const ext = { "image/png": ".png", "image/jpeg": ".jpg" }[req.headers["content-type"]];
      if (!ext) return json(res, 400, { error: "Use PNG ou JPG" });
      const data = await readBody(req);
      if (data.length > 20 * 1024 * 1024) return json(res, 400, { error: "Imagem acima de 20 MB" });
      const name = `${Date.now()}-${randomUUID().slice(0, 6)}${ext}`;
      writeFileSync(join(UPLOADS, name), data);
      return json(res, 200, { file: name, url: `/uploads/${name}` });
    }

    // Vídeo pronto (do computador), para juntar, ajustar ou compor. Grava direto no disco (sem limite de
    // tamanho); o que não for .mp4 ganha uma cópia em .mp4 para a página conseguir mostrar.
    if (p === "/api/upload-video" && req.method === "POST") {
      const orig = String(req.headers["x-name"] ? decodeURIComponent(req.headers["x-name"]) : "video.mp4");
      const ext = (extname(orig).toLowerCase() || ".mp4");
      if (![".mp4", ".mov", ".webm", ".m4v", ".mkv", ".avi"].includes(ext)) return json(res, 400, { error: "Use MP4, MOV, WEBM, M4V, MKV ou AVI" });
      const base = `${new Date().toISOString().slice(0, 10)}-pronto-${basename(orig, extname(orig)).replace(/[^\w-]+/g, "-").slice(0, 50)}-${Date.now().toString(36)}`;
      const raw = join(VIDEOS, base + ext);
      try {
        await pipeline(req, createWriteStream(raw));
        let file = base + ext;
        if (ext !== ".mp4") {
          file = base + ".mp4";
          await execFileP(ffmpeg.path, ["-y", "-hide_banner", "-loglevel", "error", "-i", raw, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-movflags", "+faststart", join(VIDEOS, file)]);
        }
        const { w, h } = await videoSize(join(VIDEOS, file));
        const duration = await mediaDuration(join(VIDEOS, file));
        console.log(`Vídeo pronto recebido: ${orig} -> ${file} (${w}×${h}, ${duration.toFixed(1)} s)`);
        return json(res, 200, { file, w, h, duration, original: base + ext });
      } catch (e) {
        rmSync(raw, { force: true });
        return json(res, 500, { error: `Não consegui receber o vídeo: ${String(e.stderr || e.message).trim().split("\n").pop()}` });
      }
    }

    if (p === "/api/generate" && req.method === "POST") {
      const input = JSON.parse((await readBody(req)).toString("utf8"));
      // Trava de cobrança: só gera o que passou pela janela de confirmação da página.
      if (input.confirmed !== true) return json(res, 400, { error: "A página do estúdio está desatualizada. Recarregue com F5 (ou Ctrl+F5) e tente de novo. Nada foi cobrado.", stale: true });
      // Duplo clique ou pedido repetido em sequência: o mesmo pedido em menos de 30 s é recusado.
      const key = JSON.stringify([input.model, input.resolution, input.duration, input.prompt, input.start, input.end, input.pano?.tiles, input.pano?.prompts, input.refs]);
      const last = recent.get(key);
      if (last && Date.now() - last < 30000) return json(res, 409, { error: "Pedido idêntico enviado há poucos segundos; não gerei de novo para não cobrar duas vezes" });
      recent.set(key, Date.now());
      try {
        return json(res, 200, await tracked(() => createJob(input)));
      } catch (e) {
        recent.delete(key); // falhou no envio: nada foi cobrado, pode tentar de novo
        throw e;
      }
    }

    if (p === "/api/jobs" && req.method === "GET") return json(res, 200, jobs);

    // Refaz só as partes de uma panorâmica que falharam; as prontas ficam (e não são cobradas de novo).
    if (p === "/api/retry" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      if (body.confirmed !== true) return json(res, 400, { error: "A página do estúdio está desatualizada. Recarregue com F5 (ou Ctrl+F5) e tente de novo. Nada foi cobrado.", stale: true });
      const job = jobs.find((j) => j.id === body.id);
      if (!job?.parts) return json(res, 400, { error: "Esse vídeo não é panorâmico" });
      if (job.status === "pending") return json(res, 409, { error: "Esse vídeo ainda está gerando" });
      // Pedidos antigos não guardavam as imagens das partes: a página manda as do nó.
      const tiles = job.tiles || body.tiles;
      const endTiles = job.tiles ? job.endTiles : body.endTiles;
      if (!tiles || tiles.length !== job.parts.length) return json(res, 400, { error: "Não achei as imagens das partes. Gere de novo pelo botão Gerar." });
      const m = MODELS[job.model];
      const input = { model: job.model, prompt: job.prompt, duration: job.duration, resolution: job.resolution };
      let sent = 0;
      job.tiles = tiles;
      job.endTiles = endTiles || null;
      await tracked(async () => {
        for (let i = 0; i < job.parts.length; i++) {
          const part = job.parts[i];
          if (part.status === "done" || part.status === "pending") continue;
          const refs = job.refs?.length && (!job.refsParts || job.refsParts.includes(i + 1)) ? job.refs : [];
          const { id } = await submit(m, { ...input, prompt: job.partPrompts?.[i] || job.prompt }, tiles[i], endTiles?.[i], "21:9", refs);
          Object.assign(part, { id, status: "pending", progress: 0, error: null, file: null, billed: null });
          saveJobs(); // cada parte reenviada fica registrada na hora
          sent++;
        }
      });
      if (!sent) return json(res, 400, { error: "Nenhuma parte com falha para refazer" });
      job.endTiles = endTiles || null;
      job.status = "pending";
      job.error = null;
      saveJobs();
      return json(res, 200, job);
    }

    // Refaz só a emenda de uma panorâmica com as partes já baixadas: não gera nada nem cobra.
    // Trava (ou destrava) os pretos de um vídeo pronto: não gera nada nem cobra.
    if (p === "/api/lock" && req.method === "POST") {
      const { id, on } = JSON.parse((await readBody(req)).toString("utf8"));
      const job = jobs.find((j) => j.id === id);
      if (!job || job.status !== "done" || !job.file) return json(res, 400, { error: "Esse vídeo ainda não está pronto" });
      if (on === false) {
        // Volta para o arquivo original, que nunca foi sobrescrito.
        const legacy = job.file.replace(/\.mp4$/, "-sem-trava.mp4");
        if (job.fileUnlocked && existsSync(join(VIDEOS, job.fileUnlocked))) job.file = job.fileUnlocked;
        else if (existsSync(join(VIDEOS, legacy))) job.file = legacy;
        job.lockBlack = false;
        job.lockedBlack = false;
        job.stitchedAt = Date.now();
      } else {
        await lockBlack(job, !job.lockedBlack);
        job.lockBlack = true;
      }
      saveJobs();
      return json(res, 200, job);
    }

    // Tirar fundo: o fundo branco liso some e o vídeo sai com transparência (.mov para a edição,
    // .webm para a prévia). Feito aqui no computador, sem custo.
    if (p === "/api/cutout" && req.method === "POST") {
      const { file } = JSON.parse((await readBody(req)).toString("utf8"));
      const src = join(VIDEOS, safe(String(file || "")));
      if (!file || !existsSync(src)) return json(res, 400, { error: "Não achei esse vídeo em videos-gerados/" });
      const base = basename(src).replace(/\.mp4$/i, "") + CUT_SUFFIX;
      try {
        await cutoutSafe(src);
      } catch (e) {
        return json(res, 500, { error: `Não consegui tirar o fundo: ${e.message}` });
      }
      // Fica guardado no pedido: o nó do vídeo passa a mostrar "Ver sem fundo" e "Baixar .mov".
      const done = { mov: `${base}.mov`, webm: `${base}.webm` };
      for (const j of jobs) if (j.file === basename(src)) j.cutout = done;
      saveJobs();
      return json(res, 200, done);
    }

    // Compor: põe o logo (já sem fundo) por cima do vídeo de fundo, no lugar e tamanho pedidos, e
    // exporta. x e y são o centro do logo (fração da largura e da altura); size é o lado do quadrado
    // do vídeo do logo, como fração da largura. O logo repete em laço até o fundo acabar.
    if (p === "/api/compose" && req.method === "POST") {
      const { bg: bgVideo, bgImage, logo: logoVideo, logoImage, x, y, size, final, erase, feather, glow, eraseSoft, eraseGrow, stillDur, logoStart } = JSON.parse((await readBody(req)).toString("utf8"));
      // Fundo pode ser um vídeo (videos-gerados/) ou uma imagem parada (uploads/): com imagem,
      // o vídeo final dura uma volta do logo.
      const still = !bgVideo && Boolean(bgImage);
      const bg = still ? bgImage : bgVideo;
      // erase: "movel" = a Forma do fundo se mexe e é apagada quadro a quadro; outro valor = máscara
      // (em uploads/) da Forma parada, que vira branco liso antes do logo.
      const moving = erase === "movel" && !still;
      const maskPath = erase && !moving ? join(UPLOADS, safe(String(erase))) : null;
      if (maskPath && !existsSync(maskPath)) return json(res, 400, { error: "Não achei a máscara da Forma em uploads/" });
      let bgPath = join(still ? UPLOADS : VIDEOS, safe(String(bg || "")));
      // Logo: vídeo (o logo girando) ou imagem (o logo parado no lugar).
      const logoStill = !logoVideo && Boolean(logoImage);
      const logo = logoStill ? logoImage : logoVideo;
      const logoPath = join(logoStill ? UPLOADS : VIDEOS, safe(String(logo || "")));
      if (!bg || !existsSync(bgPath)) return json(res, 400, { error: still ? "Não achei a imagem de fundo em uploads/" : "Não achei o vídeo de fundo em videos-gerados/" });
      if (!logo || !existsSync(logoPath)) return json(res, 400, { error: logoStill ? "Não achei a imagem do logo em uploads/" : "Não achei o vídeo do logo em videos-gerados/" });
      const fx = Number(x), fy = Number(y), fs = Number(size);
      if (!(fx >= 0 && fx <= 1 && fy >= -0.5 && fy <= 1.5 && fs > 0 && fs <= 1)) return json(res, 400, { error: "Posição ou tamanho do logo inválidos" });
      // O logo precisa estar sem fundo: usa o .mov já feito ou tira o fundo agora.
      let cut = logoPath;
      let logoSeek = 0; // onde o vídeo do logo começa (s)
      if (logoStill) {
        // Imagem do logo: tira o fundo branco uma vez (e de novo se a imagem mudar).
        cut = join(UPLOADS, basename(logoPath).replace(/\.(png|jpe?g|webp)$/i, "") + CUT_SUFFIX + ".png");
        if (!existsSync(cut) || statSync(cut).mtimeMs < statSync(logoPath).mtimeMs) await cutoutImage(ffmpeg.path, logoPath, cut);
      } else if (!/\.mov$/i.test(logoPath)) {
        // Logo em vídeo: se ele é mais longo que o fundo (ex.: câmera lenta), só o trecho usado perde o fundo.
        const full = logoPath.replace(/\.mp4$/i, "") + CUT_SUFFIX + ".mov";
        const need = still ? (Number(stillDur) > 0 ? Math.ceil(Number(stillDur) + 1) : 0) : Math.ceil((await mediaDuration(bgPath)) + 1);
        const logoDur = await mediaDuration(logoPath);
        // Começo do logo: dá a volta se passar do fim (o giro é um laço).
        const st = logoDur > 0 ? Math.round(((Number(logoStart) || 0) % logoDur) * 100) / 100 : 0;
        // Com começo: o recorte vai do 0 até começo + duração usada (ou é o logo inteiro), e o Compor pula
        // até o começo; quando o vídeo do logo acaba, o laço volta ao início do giro.
        logoSeek = st;
        const reach = need ? Math.ceil(st + need) : 0;
        if (existsSync(full) && !cutting.has(logoPath + "|0|0")) cut = full;
        else if (st > 0 && reach && logoDur > reach + 1) {
          cut = logoPath.replace(/\.mp4$/i, "") + CUT_SUFFIX + `-${reach}s.mov`;
          if (cutting.has(logoPath + "|" + reach + "|0") || !existsSync(cut)) await cutoutSafe(logoPath, reach);
        } else if (st > 0) { await cutoutSafe(logoPath); cut = full; }
        else if (!need || !logoDur || logoDur <= need + 1) { await cutoutSafe(logoPath); cut = full; }
        else {
          cut = logoPath.replace(/\.mp4$/i, "") + CUT_SUFFIX + `-${need}s.mov`;
          // Espera um "Tirar fundo" em andamento do mesmo trecho, para não ler o .mov pela metade.
          if (cutting.has(logoPath + "|" + need + "|0") || !existsSync(cut)) await cutoutSafe(logoPath, need);
        }
      }
      const bgName = basename(bgPath);
      if (moving) {
        // Fica guardado: compor de novo o mesmo fundo não refaz o apagamento.
        const erased = join(VIDEOS, bgName.replace(/\.mp4$/i, "") + "-forma-apagada.mp4");
        if (!existsSync(erased)) {
          const tmp = erased.replace(/\.mp4$/, `-${Date.now().toString(36)}.tmp.mp4`);
          await eraseMovingForm(ffmpeg.path, bgPath, tmp);
          renameSync(tmp, erased);
        }
        bgPath = erased;
      }
      const size0 = await videoSize(bgPath);
      const even = (v) => Math.max(2, Math.round(v / 2) * 2);
      const W = final === "parede" ? 6410 : even(size0.w), H = final === "parede" ? 1150 : even(size0.h);
      const S = even(fs * W);
      const X = Math.round(fx * W - S / 2), Y = Math.round(fy * H - S / 2);
      let bgIn = ["-i", bgPath];
      if (still && logoStill) {
        bgIn = ["-loop", "1", "-framerate", "24", "-t", "10", "-i", bgPath]; // fundo e logo parados: 10 s
      } else if (still) {
        let dur = 0;
        try { await execFileP(ffmpeg.path, ["-hide_banner", "-i", cut]); } catch (e) {
          const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(String(e.stderr));
          if (m) dur = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        }
        if (!dur) return json(res, 400, { error: "Não consegui ler a duração do vídeo do logo" });
        // Duração pedida no nó (o logo em câmera lenta pode ter minutos; a parede não precisa durar tudo).
        if (Number(stillDur) > 0) dur = Math.min(dur, Number(stillDur));
        bgIn = ["-loop", "1", "-framerate", "24", "-t", dur.toFixed(3), "-i", bgPath];
      }
      const out = `${bgName.replace(/\.(mp4|png|jpe?g)$/i, "")}-com-logo-${final === "parede" ? "6410" : W}-${Date.now().toString(36)}.mp4`;
      try {
        const eraseIn = maskPath ? ["-loop", "1", ...(still ? [] : ["-t", String(await mediaDuration(bgPath) || 30)]), "-i", maskPath] : [];
        const px = (v, max) => Math.min(max, Math.max(0, Number(v) || 0)) * (W / 6410); // px da parede -> px do vídeo
        // Tamanho em que o apagar é feito: o do fundo, até 1600 de largura (desfocar a parede de 6410 é lento).
        const EW = even(Math.min(size0.w, 1600)), EH = even((EW * H) / W);
        const pe = (v, max) => Math.min(max, Math.max(0, Number(v) || 0)) * (EW / 6410); // px da parede -> px do apagar
        const soft = pe(eraseSoft, 600), grow = Math.max(pe(eraseGrow, 400), 24 * (EW / 6410));
        const fea = px(feather, 120), glo = px(glow, 400);
        const cx = Math.round(fx * W), cy = Math.round(fy * H);
        const at = `x=${cx}-overlay_w/2:y=${cy}-overlay_h/2`;
        const parts = [];
        // O Seedance deixa uma linha cinza de 1–2 px em cima e embaixo do vídeo: corta antes de ampliar.
        const edge = still ? "" : "crop=iw:ih-4:0:2,";
        // Fundo; com a máscara, a Forma parada vira branco (com "branco suave", um branco desfocado e mais largo).
        if (maskPath) {
          // 1) A Forma parada vira branco (área da máscara, borda dura).
          parts.push(`[0:v]${edge}scale=${EW}:${EH}:flags=lanczos,setsar=1,format=yuv444p${soft > 0 ? ",split[b0][b0c]" : "[b0c]"}`);
          parts.push(`[2:v]scale=${EW}:${EH},format=gray${grow > 0 ? `,gblur=sigma=${(grow / 2).toFixed(2)},lut=y='if(gt(val\\,6)\\,255\\,0)'` : ""}${soft > 0 ? ",split[mh][ms0]" : "[mh]"}`);
          parts.push(`color=white:s=${EW}x${EH},format=yuv444p[w]`, "[w][mh]alphamerge[wa]", "[b0c][wa]overlay=0:0:shortest=1:format=yuv444[filled]");
          if (soft > 0) {
            // 2) Com "branco suave": esse quadro é desfocado, e entra só numa área um pouco maior que a
            //    Forma, com borda bem suave. O miolo fica branco e as bordas pegam os tons das ondas
            //    em volta, então não sobra contorno marcado.
            parts.push(`[filled]gblur=sigma=${soft.toFixed(2)}[fb]`);
            parts.push(`[ms0]gblur=sigma=${(soft * 0.8).toFixed(2)},lut=y='min(255\\,val*2.2)'[ms]`);
            parts.push("[fb][ms]alphamerge[fba]", "[b0][fba]overlay=0:0:shortest=1:format=yuv444[be]");
          } else parts.push("[filled]null[be]");
          // 3) Só então a parede vai para o tamanho final.
          parts.push(`[be]scale=${W}:${H}:flags=lanczos,setsar=1,format=yuv444p[b1]`);
        } else parts.push(`[0:v]${edge}scale=${W}:${H}:flags=lanczos,setsar=1,format=yuv444p[b1]`);
        // Logo (com borda suave, se pedida, que desfoca só o contorno dele).
        parts.push(`[1:v]scale=${S}:-2:flags=lanczos,format=yuva444p${fea > 0 ? `,split[l0][l1];[l1]alphaextract,gblur=sigma=${fea.toFixed(2)}[la];[l0][la]alphamerge` : ""}[lg]`);
        // Brilho branco: camada à parte, embaixo do logo — a silhueta dele em branco, alargada e desfocada.
        if (glo > 0) {
          const pad = Math.ceil(glo * 2.5);
          parts.push("[lg]split[l][lh]");
          parts.push(`[lh]pad=iw+${pad * 2}:ih+${pad * 2}:${pad}:${pad}:color=black@0,split[hm][ha]`);
          parts.push(`[ha]alphaextract,gblur=sigma=${glo.toFixed(2)},lut=y='min(255\\,val*1.6)'[hal]`);
          parts.push("[hm]format=yuv444p,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill[hw]", "[hw][hal]alphamerge[halo]");
          parts.push(`[b1][halo]overlay=${at}:shortest=1:format=yuv444[b]`);
        } else parts.push("[lg]null[l]", "[b1]null[b]");
        parts.push(`[b][l]overlay=${at}:shortest=1:format=yuv444,format=yuv420p[out]`);
        await execFileP(ffmpeg.path, ["-y", "-hide_banner", "-loglevel", "error", ...bgIn, ...(logoStill ? ["-loop", "1", "-i", cut] : ["-stream_loop", "-1", ...(logoSeek > 0 ? ["-ss", String(logoSeek)] : []), "-i", cut]), ...eraseIn,
          "-filter_complex", parts.join(";"),
          "-map", "[out]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-movflags", "+faststart", join(VIDEOS, out)]);
      } catch (e) {
        return json(res, 500, { error: `Não consegui compor: ${String(e.stderr || e.message).trim().split("\n").pop()}` });
      }
      console.log(`Compus ${basename(logoPath)} sobre ${basename(bgPath)} em ${out} (${W}×${H}, logo ${S}px em ${X},${Y})`);
      return json(res, 200, { file: out, w: W, h: H });
    }

    // Ajuste: desfoque, brilho, contraste, saturação e cor (quente/fria) num vídeo ou numa imagem.
    // Grátis, aqui no computador. O resultado é um arquivo novo; o original fica como estava.
    if (p === "/api/adjust" && req.method === "POST") {
      const { file, kind, blur, brightness, contrast, saturation, warmth, speed } = JSON.parse((await readBody(req)).toString("utf8"));
      const image = kind === "image";
      const dir = image ? UPLOADS : VIDEOS;
      const src = join(dir, safe(String(file || "")));
      if (!file || !existsSync(src)) return json(res, 400, { error: image ? "Não achei a imagem em uploads/" : "Não achei o vídeo em videos-gerados/" });
      const num = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : d));
      const b = num(blur, 0, 0, 100), br = num(brightness, 0, -1, 1), ct = num(contrast, 1, 0, 3), sa = num(saturation, 1, 0, 3), wa = num(warmth, 0, -1, 1);
      // Velocidade < 1: estica o tempo e cria os quadros que faltam por interpolação de movimento,
      // em vez de repetir quadros (que deixaria travado).
      const sp = image ? 1 : num(speed, 1, 0.1, 1);
      const look = [cssLook(br, ct, sa, wa), b ? `gblur=sigma=${b}` : null].filter(Boolean).join(",");
      const ffSlow = sp < 1 ? `setpts=PTS/${sp},minterpolate=fps=24:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1` : null;
      const chain = [ffSlow, look].filter(Boolean).join(",");
      const base = basename(src).replace(/\.(mp4|mov|png|jpe?g|webp)$/i, "");
      const out = `${base}-ajuste-${Date.now().toString(36)}${image ? ".png" : ".mp4"}`;
      let how = chain;
      try {
        // Câmera lenta: o RIFE (na placa de vídeo) cria os quadros do meio; sem ele, a interpolação do ffmpeg.
        let done = false;
        if (sp < 1 && rifeInfo()) {
          try {
            const r = await rifeSlow(ffmpeg.path, src, join(dir, out), sp, look);
            how = `RIFE ${r.model}: ${r.frames} -> ${r.target} quadros, ${look}`;
            done = true;
          } catch (e) {
            console.log(`RIFE falhou (${String(e.stderr || e.message).trim().split("\n").pop()}); usando a interpolação do ffmpeg`);
          }
        }
        if (!done) await execFileP(ffmpeg.path, ["-y", "-hide_banner", "-loglevel", "error", "-i", src, "-vf", chain,
          ...(image ? ["-frames:v", "1"] : ["-an", "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]), join(dir, out)]);
      } catch (e) {
        return json(res, 500, { error: `Não consegui aplicar o ajuste: ${String(e.stderr || e.message).trim().split("\n").pop()}` });
      }
      console.log(`Ajuste em ${basename(src)}: ${how} -> ${out}`);
      return json(res, 200, { file: out, url: image ? `/uploads/${encodeURIComponent(out)}` : `/videos/${encodeURIComponent(out)}` });
    }

    // Logo 3D: põe o logo girando (render do Blender) por cima de um vídeo, aqui no computador (sem custo).
    // Demora minutos: o pedido começa a tarefa e o nó pergunta o andamento em /api/logo3d/<id>.
    if (p === "/api/logo3d" && req.method === "POST") {
      const { file, preset, name, ajustes } = JSON.parse((await readBody(req)).toString("utf8"));
      if (!["gel", "perola", "salada", "risoto", "prato", "couvert"].includes(preset)) return json(res, 400, { error: "Escolha o logo: gel, pérola, salada, risoto, prato ou couvert" });
      const src = join(VIDEOS, safe(String(file || "")));
      if (!file || !existsSync(src)) return json(res, 400, { error: "Ligue um vídeo pronto na entrada" });
      const out = `${basename(src, ".mp4").slice(0, 60)}-logo-3d-${Date.now().toString(36)}.mp4`;
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const task = { status: "running", progress: 0, total: 0, file: null, error: null };
      logoTasks.set(id, task);
      const py = join(HERE, "ferramentas", "py", "Scripts", "python.exe");
      const proc = spawn(py, [join(HERE, "ferramentas", "logo3d", "logo3d.py"), preset, src, join(VIDEOS, out), JSON.stringify(ajustes || {})], { windowsHide: true });
      let errTxt = "";
      proc.stdout.on("data", (b) => {
        for (const m of String(b).matchAll(/progresso (\d+) (\d+)/g)) { task.progress = +m[1]; task.total = +m[2]; }
      });
      proc.stderr.on("data", (b) => { errTxt = (errTxt + b).slice(-800); });
      proc.on("close", (code) => {
        if (code === 0 && existsSync(join(VIDEOS, out))) {
          Object.assign(task, { status: "done", file: out });
          console.log(`Logo 3D (${preset}) em ${basename(src)} -> ${out}`);
        } else Object.assign(task, { status: "failed", error: `O script do logo falhou (${code}): ${errTxt.split(/\r?\n/).filter(Boolean).pop() || ""}` });
      });
      return json(res, 200, { id, name: name || null });
    }
    // Travar fundo: o cenário vem do fundo limpo do ato (imagem parada, com vento na grama ou água, se pedido) e do
    // vídeo só entram os elementos, seguidos pelo SAM2 a partir das camadas do começo e do fim. Aqui no computador.
    if (p === "/api/travar" && req.method === "POST") {
      const { file, fundo, inicio, fim, movimento, indice, total, largura, name } = JSON.parse((await readBody(req)).toString("utf8"));
      const src = join(VIDEOS, safe(String(file || "")));
      if (!file || !existsSync(src)) return json(res, 400, { error: "Ligue um vídeo pronto na entrada" });
      const img = (f) => (f ? join(UPLOADS, safe(String(f))) : null);
      for (const [nome, f] of [["o fundo limpo", fundo], ["os elementos do começo", inicio], ["os elementos do fim", fim]]) {
        if (!f || !existsSync(img(f))) return json(res, 400, { error: `Ligue ${nome} (imagem)` });
      }
      const out = `${basename(src, ".mp4").slice(0, 60)}-travado-${Date.now().toString(36)}.mp4`;
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const task = { status: "running", progress: 0, total: 0, file: null, error: null };
      logoTasks.set(id, task);
      const py = join(HERE, "ferramentas", "py", "Scripts", "python.exe");
      const args = { video: src, fundo: img(fundo), inicio: img(inicio), fim: img(fim), saida: join(VIDEOS, out),
        movimento: ["grama", "agua", "nenhum"].includes(movimento) ? movimento : "nenhum",
        indice: Number(indice) || 0, total: Number(total) || 1, largura: Number(largura) || 6410 };
      const proc = spawn(py, [join(HERE, "ferramentas", "travar", "travar.py"), JSON.stringify(args)], { windowsHide: true });
      let errTxt = "";
      proc.stdout.on("data", (b) => {
        for (const m of String(b).matchAll(/progresso (\d+) (\d+)/g)) { task.progress = +m[1]; task.total = +m[2]; }
      });
      proc.stderr.on("data", (b) => { errTxt = (errTxt + b).slice(-800); });
      proc.on("close", (code) => {
        if (code === 0 && existsSync(join(VIDEOS, out))) {
          Object.assign(task, { status: "done", file: out });
          console.log(`Fundo travado (${args.movimento}) em ${basename(src)} -> ${out}`);
        } else Object.assign(task, { status: "failed", error: `O travamento falhou (${code}): ${errTxt.split(/\r?\n/).filter(Boolean).pop() || ""}` });
      });
      return json(res, 200, { id, name: name || null });
    }
    if (p.startsWith("/api/travar/") && req.method === "GET") {
      const task = logoTasks.get(p.slice("/api/travar/".length));
      return task ? json(res, 200, task) : json(res, 404, { error: "Tarefa não encontrada (o estúdio foi reiniciado?)" });
    }
    if (p.startsWith("/api/logo3d/") && req.method === "GET") {
      const task = logoTasks.get(p.slice("/api/logo3d/".length));
      return task ? json(res, 200, task) : json(res, 404, { error: "Tarefa do logo não encontrada (o estúdio foi reiniciado?)" });
    }

    // Juntar: emenda vídeos já gerados num só, aqui no computador (sem custo). Todos saem no tamanho
    // do primeiro; do segundo em diante sai o primeiro quadro, que repete o último do anterior.
    if (p === "/api/join" && req.method === "POST") {
      const { files, name, wall, fade, loop } = JSON.parse((await readBody(req)).toString("utf8"));
      if (!Array.isArray(files) || files.length < (loop ? 1 : 2) || files.length > 8) return json(res, 400, { error: loop ? "Ligue de 1 a 8 vídeos" : "Ligue de 2 a 8 vídeos para juntar" });
      const paths = files.map((f) => join(VIDEOS, safe(String(f))));
      const lost = paths.find((f) => !existsSync(f));
      if (lost) return json(res, 400, { error: `Não achei ${basename(lost)} em videos-gerados/` });
      // wall: sai no tamanho da parede (6410 × 1150); senão, no tamanho do primeiro vídeo.
      const { w, h } = wall ? { w: 6410, h: 1150 } : await videoSize(paths[0]);
      // Emenda suave: o fim de cada trecho se dissolve no começo do próximo em F segundos (o Seedance nunca
      // termina igual ao começo do próximo, e o corte seco dá salto). Laço perfeito: o fim do último se
      // dissolve no começo do primeiro, e essa mistura abre o vídeo; ao repetir, não há salto.
      // Cada pedaço entra recortado direto do arquivo (-ss/-t), sem guardar o vídeo na memória.
      const durs = await Promise.all(paths.map((f) => mediaDuration(f)));
      const minD = Math.min(...durs);
      const F = Math.min(Math.max(0, Number(fade) || 0), 3, minD / 3);
      const L = loop ? Math.min(Math.max(F, 0.6), minD / 3) : 0;
      const out = `${new Date().toISOString().slice(0, 10)}-${String(name || "juntado").replace(/[^\w-]+/g, "-").slice(0, 40)}-${Date.now().toString(36)}.mp4`;
      const enc = ["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
      const n = paths.length;
      let args, graphStr;
      if (!F && !L) {
        const chains = paths.map((_, i) => `[${i}:v]${i ? "trim=start_frame=1,setpts=PTS-STARTPTS," : ""}scale=${w}:${h}:flags=lanczos,setsar=1,fps=24,format=yuv420p[v${i}]`);
        graphStr = `${chains.join(";")};${paths.map((_, i) => `[v${i}]`).join("")}concat=n=${n}:v=1:a=0[out]`;
        args = paths.flatMap((f) => ["-i", f]);
      } else {
        const inputs = [], chains = [], segs = [];
        const norm = `scale=${w}:${h}:flags=lanczos,setsar=1,fps=24,format=yuv420p,setpts=PTS-STARTPTS`;
        const piece = (i, from, len) => { inputs.push("-ss", from.toFixed(3), "-t", len.toFixed(3), "-i", paths[i]); return inputs.filter((x) => x === "-i").length - 1; };
        const mix = (a, b, D) => {
          const ia = piece(a, durs[a] - D, D), ib = piece(b, 0, D), k = segs.length;
          chains.push(`[${ia}:v]${norm}[a${k}];[${ib}:v]${norm}[b${k}];[a${k}][b${k}]blend=all_expr='A*(1-min(1\,T/${D.toFixed(3)}))+B*min(1\,T/${D.toFixed(3)})'[s${k}]`);
          segs.push(`[s${k}]`);
        };
        const body = (i, from, to) => { if (to - from < 0.05) return; const ii = piece(i, from, to - from), k = segs.length; chains.push(`[${ii}:v]${norm}[s${k}]`); segs.push(`[s${k}]`); };
        if (L) mix(n - 1, 0, L);
        for (let i = 0; i < n; i++) {
          const start = i > 0 ? F : L, end = i < n - 1 ? durs[i] - F : durs[i] - L;
          body(i, start, end);
          if (i < n - 1 && F) mix(i, i + 1, F);
          else if (i < n - 1) { /* corte seco entre estes dois */ }
        }
        graphStr = `${chains.join(";")};${segs.join("")}concat=n=${segs.length}:v=1:a=0[out]`;
        args = inputs;
      }
      try {
        await execFileP(ffmpeg.path, ["-y", "-hide_banner", "-loglevel", "error", ...args, "-filter_complex", graphStr, "-map", "[out]", ...enc, join(VIDEOS, out)]);
      } catch (e) {
        return json(res, 500, { error: `Não consegui juntar: ${String(e.stderr || e.message).trim().split("\n").pop()}` });
      }
      let duration = 0;
      try {
        await execFileP(ffmpeg.path, ["-hide_banner", "-i", join(VIDEOS, out)]);
      } catch (e) {
        const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(String(e.stderr));
        if (m) duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      }
      console.log(`Juntei ${paths.length} vídeos em ${out}`);
      return json(res, 200, { file: out, duration });
    }

    if (p === "/api/restitch" && req.method === "POST") {
      const { id } = JSON.parse((await readBody(req)).toString("utf8"));
      const job = jobs.find((j) => j.id === id);
      if (!job?.parts || !job.parts.every((x) => x.status === "done" && existsSync(join(VIDEOS, x.file)))) {
        return json(res, 400, { error: "As partes desse vídeo não estão todas salvas" });
      }
      if (job.status === "stitching") return json(res, 409, { error: "A emenda já está em andamento" });
      job.error = null;
      runStitch(job);
      saveJobs();
      return json(res, 200, job);
    }

    // Um frame do vídeo vira imagem em uploads/, pronta para ser first/last frame ou salva.
    if (p === "/api/frame" && req.method === "POST") {
      const { file, t } = JSON.parse((await readBody(req)).toString("utf8"));
      const src = join(VIDEOS, safe(file));
      if (!existsSync(src)) return json(res, 404, { error: "Vídeo não encontrado" });
      const name = `${Date.now()}-frame-${randomUUID().slice(0, 6)}.jpg`;
      const seek = typeof t === "number" && t > 0 ? ["-ss", String(t)] : ["-sseof", "-0.1"];
      await execFileP(ffmpeg.path, ["-y", "-hide_banner", "-loglevel", "error", ...seek, "-i", src, "-frames:v", "1", "-q:v", "2", join(UPLOADS, name)]);
      if (!existsSync(join(UPLOADS, name))) return json(res, 500, { error: "Não consegui extrair o frame" });
      return json(res, 200, { file: name, url: `/uploads/${name}` });
    }

    if (p.startsWith("/videos/")) return sendFile(req, res, join(VIDEOS, safe(p.slice(8))), url.searchParams.has("download"));
    if (p.startsWith("/uploads/") && url.searchParams.has("download")) return sendFile(req, res, join(UPLOADS, safe(p.slice(9))), true);
    if (p.startsWith("/uploads/")) return sendFile(req, res, join(UPLOADS, safe(p.slice(9))));
    return sendFile(req, res, join(PUBLIC, p === "/" ? "index.html" : safe(p)));
  } catch (e) {
    // Fica registrado no terminal também: o aviso na página some em segundos.
    console.error(`Erro em ${req.method} ${p}: ${e.message}`);
    json(res, e.status && e.status < 600 ? e.status : 500, { error: e.message });
  }
});

// Última rede de proteção: um erro inesperado numa requisição vira uma linha no terminal,
// não a queda do estúdio inteiro (e das gerações que ele está acompanhando).
process.on("uncaughtException", (e) => console.error("Erro inesperado (o estúdio continua rodando):", e.message));
process.on("unhandledRejection", (e) => console.error("Erro inesperado (o estúdio continua rodando):", e?.message || e));

server.listen(PORT, () => {
  console.log(`Estúdio rodando em http://localhost:${PORT}`);
  // Uma emenda interrompida (servidor fechado no meio) recomeça ao ligar.
  for (const j of jobs) if (j.status === "stitching") runStitch(j);
  if (!loadKey()) console.log("Aviso: cole a chave do ArgoLink em CHAVE-ARGOLINK.txt");
});
