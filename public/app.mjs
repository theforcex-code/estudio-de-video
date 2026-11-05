import { MODELS, STAGES, RATIOS, PRESETS, COMPARE, DURATIONS } from "./models.mjs";

// ---------- Estado ----------

const STORE = "estudio-grafo-v1";
const DEFS = {
  prompt: { tag: "Texto", out: "text" },
  logo: { tag: "Logo", out: "logo" },
  note: { tag: "Nota" },
  group: { tag: "Grupo" },
  clip: { tag: "Vídeo pronto", out: "video" },
  logo3d: { tag: "Logo 3D", out: "video" },
  travar: { tag: "Travar fundo", out: "video" },
  removebg: { tag: "Remover fundo", out: "video" },
  image: { tag: "Imagem", out: "image" },
  generator: {
    tag: "Vídeo",
    out: "video",
    inputs: [
      { id: "prompt", type: "text", label: "Prompt" },
      { id: "first", type: "image", label: "First frame" },
      { id: "last", type: "image", label: "Last frame" },
      { id: "logo", type: "logo", label: "Logo" },
      // Só Seedance 2.0: com vídeo de movimento ligado, gera por referência (sem first/last frame).
      { id: "refimg", type: "image", label: "Imagem ref." },
      { id: "refvid", type: "video", label: "Vídeo de movimento" },
    ],
  },
  result: { tag: "Saída", in: "video" },
  join: { tag: "Juntar", out: "video" },
  final: { tag: "Composição final", out: "video" },
  compose: { tag: "Compor", out: "video" },
  adjust: { tag: "Ajuste", out: "any" },
};

const uid = () => Math.random().toString(36).slice(2, 9);
const money = (v) => "US$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function defaultGraph() {
  const n = {
    p: { id: uid(), type: "prompt", x: 40, y: 40, data: { text: "" } },
    f: { id: uid(), type: "image", x: 40, y: 330, data: { label: "First frame" } },
    l: { id: uid(), type: "image", x: 40, y: 620, data: { label: "Last frame" } },
    g: { id: uid(), type: "generator", x: 440, y: 80, data: genDefaults() },
  };
  return {
    nodes: Object.values(n),
    edges: [
      { from: n.p.id, to: n.g.id, port: "prompt" },
      { from: n.f.id, to: n.g.id, port: "first" },
      { from: n.l.id, to: n.g.id, port: "last" },
    ],
    view: { x: 40, y: 30, k: 0.9 },
  };
}

function genDefaults(model = "seedance-2.0", resolution = "480p") {
  return { model, resolution, duration: 5, ratio: "16:9", prompt: "" };
}

let graph;
try {
  graph = JSON.parse(localStorage.getItem(STORE)) || defaultGraph();
} catch {
  graph = defaultGraph();
}

// Geradores da versão com "etapas": a etapa vira o modelo e a resolução do próprio nó.
for (const n of graph.nodes) {
  if (n.type !== "generator" || !n.data.stage) continue;
  const run = STAGES[n.data.stage]?.runs?.[0];
  if (run) Object.assign(n.data, run);
  delete n.data.stage;
}
// Duas abas do estúdio abertas: a de trás salvava o quadro dela por cima (o Ajuste perdia o vídeo pronto, o Logo 3D
// ficava esperando, comandos sumiam). Quando outra aba salva, esta fica "desatualizada": não salva nem lê comandos,
// e ao voltar para ela a página recarrega com o quadro novo.
let desatualizada = false;
addEventListener("storage", (e) => { if (e.key === STORE) desatualizada = true; });
const acordar = () => { if (desatualizada && !document.hidden) location.reload(); };
addEventListener("focus", acordar);
document.addEventListener("visibilitychange", acordar);
let saveTimer;
const save = () => {
  if (desatualizada) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(graph));
    } catch {}
  }, 200);
};

let jobs = [];
let jobsLoaded = false; // só depois de ler /api/jobs dá para saber se um nó já gerou
const sel = new Set(); // nós selecionados
let selected = null; // o último selecionado (alvo do Ctrl+V de imagem)
const els = new Map(); // id do nó → { root, update() }

const $ = (sel, root = document) => root.querySelector(sel);
const canvas = $("#canvas");
const world = $("#world");
const wires = $("#wires");
const node = (id) => graph.nodes.find((n) => n.id === id);
const edgeTo = (id, port) => graph.edges.find((e) => e.to === id && e.port === port);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

function toast(msg, bad = false) {
  const t = h("div", { class: "toast" + (bad ? " bad" : "") }, msg);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), bad ? 7000 : 3500);
}

// ---------- Visão (pan e zoom) ----------

function applyView() {
  const { x, y, k } = graph.view;
  world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  canvas.style.backgroundPosition = `${x}px ${y}px`;
  canvas.style.backgroundSize = `${22 * k}px ${22 * k}px`;
}

function toWorld(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return { x: (clientX - r.left - graph.view.x) / graph.view.k, y: (clientY - r.top - graph.view.y) / graph.view.k };
}

canvas.addEventListener("wheel", (e) => {
  if (e.target.closest("textarea, .results, select")) return;
  e.preventDefault();
  const before = toWorld(e.clientX, e.clientY);
  const k = Math.min(1.8, Math.max(0.04, graph.view.k * Math.exp(-e.deltaY * 0.0015)));
  const r = canvas.getBoundingClientRect();
  graph.view = { k, x: e.clientX - r.left - before.x * k, y: e.clientY - r.top - before.y * k };
  applyView();
  save();
}, { passive: false });

// Fundo: botão esquerdo seleciona com uma caixa; botão do meio, botão direito ou Espaço + arrastar movem o quadro.
// Um toque rápido no Espaço, sem arrastar, volta para o último nó em que você mexeu.
let spaceHeld = false;
let spaceDown = 0, spacePanned = false;
let lastTouched = null; // id do último nó clicado, arrastado ou editado (guardado entre recargas)
try { lastTouched = localStorage.getItem("estudio-ultimo-no"); } catch {}
const typing = (e) => e.target.closest?.("input:not([readonly]), textarea, select");
addEventListener("keydown", (e) => {
  if (e.code === "Space" && !typing(e)) {
    e.preventDefault();
    if (!spaceHeld) { spaceDown = performance.now(); spacePanned = false; }
    spaceHeld = true;
    canvas.classList.add("space");
  }
});
addEventListener("keyup", (e) => {
  if (e.code === "Space") {
    const tap = spaceHeld && !spacePanned && performance.now() - spaceDown < 350 && !typing(e);
    spaceHeld = false;
    canvas.classList.remove("space");
    if (tap) goToLastNode();
  }
});
function goToLastNode() {
  const n = lastTouched && node(lastTouched);
  if (!n) return toast("Clique num nó primeiro: o Espaço volta para o último nó em que você mexeu.");
  const b = nodeBox(n);
  const r = canvas.getBoundingClientRect();
  const k = Math.max(graph.view.k, 0.6); // de muito longe, aproxima um pouco para dar para ler
  const to = { x: r.width / 2 - (b.x + b.w / 2) * k, y: r.height / 2 - (b.y + b.h / 2) * k };
  const from = { ...graph.view }, t0 = performance.now();
  const step = () => {
    const p = Math.min(1, (performance.now() - t0) / 320), q = 1 - (1 - p) ** 3;
    graph.view.x = from.x + (to.x - from.x) * q;
    graph.view.y = from.y + (to.y - from.y) * q;
    graph.view.k = from.k + (k - from.k) * q;
    applyView();
    drawWires();
    if (p < 1) setTimeout(step, 16);
    else save();
  };
  step();
  select(n.id);
}
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

let pointer = null; // última posição do mouse no quadro (onde o Ctrl+V cola)
canvas.addEventListener("pointermove", (e) => (pointer = { x: e.clientX, y: e.clientY }));
canvas.addEventListener("pointerleave", () => (pointer = null));

canvas.addEventListener("pointerdown", (e) => {
  const onBackground = e.target === canvas || e.target === world || e.target === wires;
  const pan = e.button === 1 || e.button === 2 || (e.button === 0 && spaceHeld);
  if (pan && spaceHeld) spacePanned = true;
  if (pan) {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, vx: graph.view.x, vy: graph.view.y };
    canvas.classList.add("panning");
    const move = (ev) => {
      graph.view.x = start.vx + ev.clientX - start.x;
      graph.view.y = start.vy + ev.clientY - start.y;
      applyView();
    };
    const up = () => {
      canvas.classList.remove("panning");
      removeEventListener("pointermove", move);
      save();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up, { once: true });
    return;
  }
  if (!onBackground || e.button !== 0) return;
  marquee(e);
});

function marquee(e) {
  const cr = canvas.getBoundingClientRect();
  const start = { x: e.clientX, y: e.clientY };
  const base = e.shiftKey || e.ctrlKey || e.metaKey ? new Set(sel) : new Set();
  const box = h("div", { class: "marquee" });
  let moved = false;
  const move = (ev) => {
    const x0 = Math.min(start.x, ev.clientX), y0 = Math.min(start.y, ev.clientY);
    const x1 = Math.max(start.x, ev.clientX), y1 = Math.max(start.y, ev.clientY);
    if (!moved && x1 - x0 < 4 && y1 - y0 < 4) return;
    if (!moved) canvas.append(box);
    moved = true;
    Object.assign(box.style, { left: x0 - cr.left + "px", top: y0 - cr.top + "px", width: x1 - x0 + "px", height: y1 - y0 + "px" });
    sel.clear();
    for (const id of base) sel.add(id);
    for (const [id, { root }] of els) {
      const r = root.getBoundingClientRect();
      if (r.right > x0 && r.left < x1 && r.bottom > y0 && r.top < y1) sel.add(id);
    }
    selected = [...sel].at(-1) || null;
    paintSelection();
  };
  const up = () => {
    removeEventListener("pointermove", move);
    box.remove();
    if (!moved && !base.size) select(null);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up, { once: true });
}

$("#fit").addEventListener("click", () => fit());
// Enquadra os nós dados (todos, por padrão) na tela.
function fit(list = graph.nodes) {
  if (!list.length) return;
  const boxes = list.map((n) => {
    const el = els.get(n.id).root;
    return { x: n.x, y: n.y, r: n.x + el.offsetWidth, b: n.y + el.offsetHeight };
  });
  const minX = Math.min(...boxes.map((b) => b.x)), minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.r)), maxY = Math.max(...boxes.map((b) => b.b));
  const r = canvas.getBoundingClientRect();
  const k = Math.min(list === graph.nodes ? 1.2 : graph.view.k, Math.max(0.04, Math.min((r.width - 80) / (maxX - minX), (r.height - 80) / (maxY - minY))));
  graph.view = { k, x: (r.width - (maxX - minX) * k) / 2 - minX * k, y: (r.height - (maxY - minY) * k) / 2 - minY * k };
  applyView();
  save();
}

// ---------- Fios ----------

function portCenter(id, port) {
  const el = els.get(id)?.root.querySelector(`.port[data-port="${port}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return toWorld(r.left + r.width / 2, r.top + r.height / 2);
}

function curve(a, b) {
  const dx = Math.max(60, Math.abs(b.x - a.x) / 2);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

function outTypeOf(n, seen = new Set()) {
  if (!n) return "video";
  if (n.type !== "adjust") return DEFS[n.type].out;
  if (seen.has(n.id)) return "video";
  seen.add(n.id);
  const e = graph.edges.find((x) => x.to === n.id && x.port === "in");
  return e ? outTypeOf(node(e.from), seen) : n.data.kind || "video";
}
const portColor = (type) => getComputedStyle(document.documentElement).getPropertyValue(`--${type}-port`).trim();

function drawWires(temp) {
  wires.replaceChildren();
  for (const e of graph.edges) {
    const a = portCenter(e.from, "out");
    const b = portCenter(e.to, e.port);
    if (!a || !b) continue;
    const d = curve(a, b);
    const color = portColor(outTypeOf(node(e.from)));
    const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hit.setAttribute("d", d);
    hit.setAttribute("class", "hit");
    hit.edgeRef = e;
    hit.addEventListener("click", () => {
      graph.edges = graph.edges.filter((x) => x !== e);
      refreshAll();
    });
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("class", "wire");
    path.setAttribute("stroke", color);
    wires.append(hit, path);
  }
  if (temp) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", curve(temp.a, temp.b));
    path.setAttribute("class", "wire temp");
    path.setAttribute("stroke", portColor(temp.type));
    wires.append(path);
  }
  for (const p of world.querySelectorAll(".port:not(.frame)")) {
    const id = p.closest(".node").dataset.id;
    const on = p.classList.contains("out")
      ? graph.edges.some((e) => e.from === id)
      : graph.edges.some((e) => e.to === id && e.port === p.dataset.port);
    p.classList.toggle("on", on);
  }
}

// Arrastar de uma saída até uma entrada do mesmo tipo. Puxar uma entrada já ligada solta o fio dela.
// Encaixar no fio: um nó Ajuste sem ligações, solto com o ponteiro em cima de um fio, entra no meio:
// origem → Ajuste → destino. Só se o tipo do fio servir (qualquer um serve para o Ajuste).
function dropOnWire(n, pt) {
  if (n.type !== "adjust" || graph.edges.some((e) => e.from === n.id || e.to === n.id)) return;
  const el = els.get(n.id)?.root;
  if (el) el.style.pointerEvents = "none"; // para achar o fio que está embaixo do nó
  const hit = document.elementsFromPoint(pt.x, pt.y).find((x) => x.edgeRef);
  if (el) el.style.pointerEvents = "";
  const e = hit?.edgeRef;
  if (!e || e.from === n.id || e.to === n.id) return;
  graph.edges = graph.edges.filter((x) => x !== e);
  graph.edges.push({ from: e.from, to: n.id, port: "in" }, { from: n.id, to: e.to, port: e.port });
  refreshAll();
  toast("Ajuste encaixado no fio. Ajuste os valores e clique em Aplicar.");
}

function startWire(e, fromId, type, existing) {
  e.stopPropagation();
  e.preventDefault();
  if (existing) graph.edges = graph.edges.filter((x) => x !== existing);
  const a = portCenter(fromId, "out");
  const move = (ev) => drawWires({ a, b: toWorld(ev.clientX, ev.clientY), type });
  const up = (ev) => {
    removeEventListener("pointermove", move);
    const hit = document.elementFromPoint(ev.clientX, ev.clientY);
    const target = hit?.closest(".port.in");
    if (target && (target.dataset.type === type || target.dataset.type === "any")) {
      const to = target.closest(".node").dataset.id;
      if (to !== fromId) {
        graph.edges = graph.edges.filter((x) => !(x.to === to && x.port === target.dataset.port));
        graph.edges.push({ from: fromId, to, port: target.dataset.port });
      }
    } else if (type === "video" && target?.dataset.type === "image") {
      // Saída de vídeo numa entrada de imagem: o último frame do vídeo mostrado vira a imagem.
      frameInto(fromId, target);
    } else if (!existing && hit && !hit.closest(".node") && canvas.contains(hit)) {
      // Soltou no fundo: abre a lista de nós que aceitam essa saída, já ligando. Para vídeo, a lista
      // tem "Imagem do último frame", "Continuar" e "Ajuste (desfoque, cor…)".
      nodePicker(ev.clientX, ev.clientY, { from: fromId, type });
    }
    refreshAll();
  };
  const cancel = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    refreshAll();
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up, { once: true });
  addEventListener("pointercancel", cancel, { once: true });
  move(e);
}

function outPort(n) {
  return h("span", {
    class: "port out", "data-port": "out", "data-type": DEFS[n.type].out,
    onpointerdown: (e) => startWire(e, n.id, outTypeOf(n)),
  });
}

function inPort(n, port, type) {
  return h("span", {
    class: "port in", "data-port": port, "data-type": type,
    onpointerdown: (e) => {
      const existing = edgeTo(n.id, port);
      if (existing) startWire(e, existing.from, type, existing);
      else e.stopPropagation();
    },
  });
}

// ---------- Nós ----------

// select(id) seleciona só ele; select(id, true) soma ou tira da seleção; select(null) limpa.
function select(id, add = false) {
  if (!add) sel.clear();
  if (id) {
    if (add && sel.has(id)) sel.delete(id);
    else sel.add(id);
  }
  selected = [...sel].at(-1) || null;
  paintSelection();
}

function paintSelection() {
  for (const [nid, { root }] of els) root.classList.toggle("selected", sel.has(nid));
}

function shell(n, titleEl, body, { inPortEl } = {}) {
  // Título editável só com duplo clique; no resto do tempo ele faz parte da alça de arrastar.
  if (titleEl instanceof HTMLInputElement) {
    titleEl.readOnly = true;
    titleEl.title = "Duplo clique para renomear";
    titleEl.addEventListener("dblclick", () => {
      titleEl.readOnly = false;
      titleEl.focus();
      titleEl.select();
    });
    const done = () => { titleEl.readOnly = true; titleEl.blur(); };
    titleEl.addEventListener("blur", () => (titleEl.readOnly = true));
    titleEl.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === "Escape") && done());
  }
  const head = h("div", { class: "node-head" },
    inPortEl,
    h("div", { class: "node-title" }, titleEl),
    h("span", { class: "tag" }, DEFS[n.type].tag),
    h("button", { class: "node-x", title: "Remover", onclick: () => removeNode(n.id) }, "×"),
    DEFS[n.type].out ? outPort(n) : null,
  );
  const root = h("div", { class: `node ${n.type}`, "data-id": n.id }, head, body);
  root.style.left = n.x + "px";
  root.style.top = n.y + "px";
  // Arrasta o nó por qualquer área que não seja um controle. Só começa a mover depois de 3 px,
  // para um clique comum não deslocar nada.
  root.addEventListener("pointerdown", (e) => {
    if (e.button === 0 && !spaceHeld) { lastTouched = n.id; try { localStorage.setItem("estudio-ultimo-no", n.id); } catch {} }
    if (e.button !== 0 || spaceHeld) return;
    const control = e.target.closest(INTERACTIVE);
    // Shift ou Ctrl + clique soma (ou tira) da seleção sem arrastar.
    if (!control && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      select(n.id, true);
      return;
    }
    if (!sel.has(n.id)) select(n.id);
    if (control) return;
    e.preventDefault();
    // Arrasta todos os selecionados juntos; um Grupo leva também os nós que estão dentro dele.
    const moving_ = new Set(sel);
    for (const id of sel) { const m = node(id); if (m?.type === "group") for (const k of insideGroup(m)) moving_.add(k.id); }
    const group = [...moving_].map(node).filter(Boolean).map((m) => ({ m, x: m.x, y: m.y, el: els.get(m.id).root }));
    const start = { x: e.clientX, y: e.clientY };
    let moving = false;
    let lastPointer = start;
    const move = (ev) => {
      lastPointer = { x: ev.clientX, y: ev.clientY };
      if (!moving && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return;
      moving = true;
      const dx = (ev.clientX - start.x) / graph.view.k, dy = (ev.clientY - start.y) / graph.view.k;
      for (const g of group) {
        g.m.x = g.x + dx;
        g.m.y = g.y + dy;
        g.el.style.left = g.m.x + "px";
        g.el.style.top = g.m.y + "px";
        g.el.classList.add("dragging");
      }
      drawWires();
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointercancel", up);
      for (const g of group) g.el.classList.remove("dragging");
      if (moving && group.length === 1) dropOnWire(group[0].m, lastPointer);
      if (moving) save();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up, { once: true });
    addEventListener("pointercancel", up, { once: true });
  });
  return root;
}

// O que dentro de um nó é controle (não serve para arrastar o nó).
const INTERACTIVE = "button, input:not([readonly]), textarea, select, a, video, .port, .drop, .results, .linked-prompt";

// ---------- Posição de nós novos ----------

const nodeBox = (n) => {
  const el = els.get(n.id)?.root;
  return { x: n.x, y: n.y, w: el?.offsetWidth || 360, h: el?.offsetHeight || 400 };
};

// Primeiro lugar livre perto de (x, y), procurando em espiral para não cobrir outro nó.
function freeSpot(x, y, w = 380, h = 420) {
  const boxes = graph.nodes.filter((n) => n.type !== "group").map(nodeBox);
  const free = (px, py) => boxes.every((b) => px + w + 24 <= b.x || px >= b.x + b.w + 24 || py + h + 24 <= b.y || py >= b.y + b.h + 24);
  if (free(x, y)) return { x, y };
  for (let r = 1; r < 40; r++) {
    for (let a = 0; a < 8 * r; a++) {
      const t = (a / (8 * r)) * Math.PI * 2;
      const px = x + Math.cos(t) * r * 80, py = y + Math.sin(t) * r * 80;
      if (free(px, py)) return { x: px, y: py };
    }
  }
  return { x, y };
}

// Centro do que está na tela, em coordenadas do quadro.
function viewCenter() {
  const r = canvas.getBoundingClientRect();
  return toWorld(r.left + r.width / 2, r.top + r.height / 2);
}

// Se o nó ficou fora da tela, desliza o quadro até ele aparecer.
// Timers em vez de requestAnimationFrame: abas em segundo plano pausam o rAF.
function reveal(n) {
  setTimeout(() => {
    const b = nodeBox(n);
    const r = canvas.getBoundingClientRect();
    const { x, y, k } = graph.view;
    const left = b.x * k + x, top = b.y * k + y, right = left + b.w * k, bottom = top + b.h * k;
    let dx = 0, dy = 0;
    if (right > r.width - 20) dx = r.width - 20 - right;
    if (left + dx < 20) dx = 20 - left;
    if (bottom > r.height - 20) dy = r.height - 20 - bottom;
    if (top + dy < 20) dy = 20 - top;
    if (!dx && !dy) return;
    const from = { x, y }, t0 = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / 280), e = 1 - (1 - p) ** 3;
      graph.view.x = from.x + dx * e;
      graph.view.y = from.y + dy * e;
      applyView();
      drawWires();
      if (p < 1) setTimeout(step, 16);
      else save();
    };
    step();
  }, 0);
}

// Texto do giro do logo (as 4 vistas: frente, lado direito, costas, lado esquerdo). Escrito com
// "se estiver no quadro", porque vai para todas as partes da panorâmica, inclusive as sem logo.
const LOGO_DEFAULT = "If the logo ring is in view, it is alive like a ribbon of liquid glass, and it clearly moves the whole time in two ways at once. First, and most visibly, its band rolls continuously around its own core, like a smoke ring or a vortex ring: its surface keeps turning over on itself, the inner face rolling outward and the outer face rolling inward, and the twist in the band travels slowly along the loop, so its faces turn over one after another all the way around, like a living ribbon of liquid glass flowing in place; highlights and refractions travel around the thickness of the band as it rolls. Second, while it keeps rolling, the whole ring slowly turns exactly one full turn, never more, around a perfectly vertical axis straight through its centre, like a sculpture on a level turntable, at a constant speed taking the whole clip, so it shows its back only at the halfway point; it keeps the same tilt the whole time and never wobbles, tumbles or flips: front view, side seen edge-on, back, other side, and back to its front, ending in exactly the same pose as at the start, its reflection on the water turning with it. The rolling of the faces never stops, also while the ring turns. The ring keeps its loop shape, size and position; it never twists into a figure eight, never knots, never breaks, melts, tilts, rises or drifts.";

// Nó Logo: um texto fixo sobre o logo que entra sozinho no fim do prompt de cada vídeo ligado.
function buildLogo(n) {
  if (n.data.text == null) n.data.text = LOGO_DEFAULT;
  const ta = h("textarea", {
    rows: 8,
    oninput: (e) => {
      n.data.text = e.target.value;
      save();
      refreshGenerators();
    },
  });
  ta.value = n.data.text;
  const tools = h("div", { class: "prompt-tools" },
    h("button", { onclick: () => { n.data.text = ta.value = LOGO_DEFAULT; save(); refreshGenerators(); }, title: "Volta ao texto do giro de 360° das 4 vistas" }, "Texto padrão"),
    h("button", { onclick: () => copyText(n.data.text?.trim()) }, "Copiar texto"));
  const title = h("input", { value: n.data.label || "Logo (giro)", oninput: (e) => { n.data.label = e.target.value; save(); } });

  // Vistas do logo como referência (frente, lado direito, costas, lado esquerdo). Só os modelos
  // que aceitam referências junto com first/last frame usam (hoje, o Grok Imagine).
  if (!Array.isArray(n.data.refs)) n.data.refs = [];
  if (!Array.isArray(n.data.refsParts)) n.data.refsParts = [3];
  const views = h("div", { class: "logo-views" });
  const partsRow = h("div", { class: "logo-parts" });
  const picker = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true });
  const NAMES = ["frente", "lado direito", "costas", "lado esquerdo"];

  function renderViews() {
    views.replaceChildren(
      ...n.data.refs.map((r, i) => h("div", { class: "logo-view" },
        h("img", { src: r.url, alt: "", onclick: () => viewer({ image: r.url }) }),
        h("small", {}, NAMES[i] || `vista ${i + 1}`),
        h("button", { title: "Remover", onclick: () => { n.data.refs.splice(i, 1); save(); renderViews(); refreshGenerators(); } }, "×"))),
      n.data.refs.length < 9 ? h("button", { class: "logo-add", onclick: () => picker.click() }, "+ vistas") : null,
    );
    partsRow.replaceChildren(
      h("small", {}, "Na panorâmica, o logo aparece nas partes:"),
      ...[1, 2, 3].map((p) => h("button", {
        class: n.data.refsParts.includes(p) ? "on" : "",
        onclick: () => {
          const set = new Set(n.data.refsParts);
          set.has(p) ? set.delete(p) : set.add(p);
          n.data.refsParts = [...set].sort();
          save();
          renderViews();
          refreshGenerators();
        },
      }, String(p))),
    );
  }

  async function addViews(files) {
    for (const f of [...files].filter((x) => x.type.startsWith("image/"))) {
      try {
        const { blob } = await prepareImage(f);
        const j = await sendImage(blob);
        n.data.refs.push({ file: j.file, url: j.url });
        save();
        renderViews();
      } catch (e) {
        toast(e.message, true);
      }
    }
    refreshGenerators();
  }
  picker.addEventListener("change", () => { addViews(picker.files); picker.value = ""; });
  views.addEventListener("dragover", (e) => e.preventDefault());
  views.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); addViews(e.dataTransfer.files); });
  renderViews();

  return { root: shell(n, title, h("div", { class: "node-body" },
    h("div", { class: "meta" }, "Ligue na entrada Logo dos vídeos: este texto entra sozinho no fim do prompt (e de cada parte)."),
    ta, tools,
    h("div", { class: "meta" }, "Vistas do logo (usadas só pelo Grok Imagine, que aceita referências com first/last frame). Solte as imagens aqui na ordem: frente, lado direito, costas, lado esquerdo."),
    views, partsRow, picker)) };
}

function buildPrompt(n) {
  const ta = h("textarea", {
    placeholder: "Descreva a cena: câmera, ação, clima, luz…\nCom first frame, descreva o que acontece a partir dele.",
    rows: 7,
    oninput: (e) => {
      n.data.text = e.target.value;
      save();
      refreshGenerators();
    },
  });
  ta.value = n.data.text || "";
  const tools = h("div", { class: "prompt-tools" },
    h("button", { onclick: () => copyText(n.data.text?.trim()), title: "Copia só o texto, para colar em qualquer lugar" }, "Copiar texto"));
  return { root: shell(n, "Prompt", h("div", { class: "node-body" }, ta, tools)) };
}

// Grupo: moldura colorida com nome, atrás dos nós. Arrasta-se pela barra do nome (leva junto os nós que
// estão dentro); o canto de baixo muda o tamanho; as bolinhas mudam a cor. O meio deixa passar os cliques,
// então dentro dele dá para selecionar arrastando e adicionar nós com duplo clique, como no fundo.
const GROUP_COLORS = ["#5aa9ff", "#c6f432", "#ff9a3c", "#ff5c8a", "#a78bfa", "#34d399", "#9ca3af"];
const hexA = (hex, a) => { const v = parseInt(hex.slice(1), 16); return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${a})`; };
// Nós (fora outros grupos) com o centro dentro do grupo.
function insideGroup(g) {
  const b = nodeBox(g);
  return graph.nodes.filter((m) => {
    if (m.id === g.id || m.type === "group") return false;
    const k = nodeBox(m), cx = k.x + k.w / 2, cy = k.y + k.h / 2;
    return cx > b.x && cx < b.x + b.w && cy > b.y && cy < b.y + b.h;
  });
}
function buildGroup(n) {
  const d = n.data;
  d.w ??= 900; d.h ??= 560; d.color ??= GROUP_COLORS[0];
  // d.big: o nome também aparece enorme dentro do quadro (os quadros dos atos), para ler com o quadro afastado.
  const big = d.big ? h("div", { class: "group-big" }, d.label || "") : null;
  const title = h("input", { value: d.label || "Grupo", oninput: (e) => { d.label = e.target.value; if (big) big.textContent = d.label; save(); } });
  const paint = () => {
    if (big) { big.style.fontSize = d.big + "px"; big.style.color = hexA(d.color, 0.75); root.style.borderWidth = Math.round(d.big / 40) + "px"; }
    root.style.width = d.w + "px";
    root.style.height = d.h + "px";
    root.style.borderColor = hexA(d.color, 0.7);
    root.style.background = hexA(d.color, d.big ? 0.1 : 0.06);
    root.querySelector(".node-head").style.background = hexA(d.color, 0.22);
    for (const s of swatches.children) s.classList.toggle("on", s.dataset.c === d.color);
  };
  const swatches = h("span", { class: "group-colors" }, ...GROUP_COLORS.map((c) => h("button", { class: "group-color", "data-c": c, title: "Cor do grupo", style: `background:${c}`, onclick: () => { d.color = c; paint(); save(); } })));
  const grip = h("button", { class: "group-resize", title: "Arraste para mudar o tamanho" });
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const s = { x: e.clientX, y: e.clientY, w: d.w, h: d.h };
    const move = (ev) => {
      d.w = Math.max(240, Math.round(s.w + (ev.clientX - s.x) / graph.view.k));
      d.h = Math.max(140, Math.round(s.h + (ev.clientY - s.y) / graph.view.k));
      paint();
    };
    const up = () => { removeEventListener("pointermove", move); save(); };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up, { once: true });
  });
  const root = shell(n, title, h("div", { class: "group-body" }, ...(big ? [big] : []), grip));
  root.querySelector(".node-head").insertBefore(swatches, root.querySelector(".node-head .tag"));
  paint();
  return { root };
}

// Vídeo pronto: um vídeo do computador (mp4, mov…), para ligar no Juntar, num Ajuste ou no Compor. Grátis.
function buildClip(n) {
  const d = n.data;
  const file = h("input", { type: "file", accept: "video/*,.mov,.mkv,.avi,.m4v", hidden: true });
  const drop = h("div", { class: "drop clip-drop" });
  const title = h("input", { value: d.label || "Vídeo pronto", oninput: (e) => { d.label = e.target.value; save(); refreshAll(); } });
  const render = () => {
    drop.replaceChildren();
    if (d.file) {
      const v = h("video", { src: `/videos/${encodeURIComponent(d.file)}`, controls: true, loop: true, muted: true, playsinline: true, preload: "metadata" });
      v.addEventListener("dblclick", (e) => { e.preventDefault(); viewer({ video: d.file, time: v.currentTime }); });
      drop.append(v,
        h("div", { class: "meta" }, `${d.w || "?"} × ${d.h || "?"} · ${(d.duration || 0).toFixed(1).replace(".", ",")} s`),
        h("div", { class: "clear" }, h("button", { onclick: (e) => { e.stopPropagation(); file.click(); } }, "trocar"),
          h("button", { onclick: (e) => { e.stopPropagation(); Object.assign(d, { file: null, w: null, h: null, duration: null }); save(); render(); refreshAll(); } }, "remover")));
    } else {
      drop.append(h("div", {}, "Solte um vídeo aqui", h("br"), h("span", { class: "meta" }, "clique para escolher · MP4, MOV, WEBM")));
    }
  };
  async function upload(f) {
    if (!f) return;
    if (!/^video\//.test(f.type) && !/\.(mp4|mov|webm|m4v|mkv|avi)$/i.test(f.name)) return toast("Escolha um arquivo de vídeo", true);
    const t0 = Date.now();
    const tick = setInterval(() => drop.replaceChildren(h("div", { class: "meta" }, `Enviando ${f.name} (${(f.size / 1048576).toFixed(0)} MB)… ${Math.round((Date.now() - t0) / 1000)} s`)), 500);
    try {
      const res = await fetch("/api/upload-video", { method: "POST", headers: { "x-name": encodeURIComponent(f.name), "Content-Type": "application/octet-stream" }, body: f });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error);
      Object.assign(d, { file: r.file, w: r.w, h: r.h, duration: r.duration });
      if (!d.label || d.label === "Vídeo pronto") d.label = f.name.replace(/\.[^.]+$/, "");
      title.value = d.label;
      save();
      refreshAll();
      toast(`Vídeo pronto: ${r.w} × ${r.h}, ${r.duration.toFixed(1).replace(".", ",")} s. Ligue a saída no Juntar.`);
    } catch (e) {
      toast(e.message, true);
    }
    clearInterval(tick);
    render();
  }
  drop.addEventListener("click", (e) => { if (!d.file && !e.target.closest("button")) file.click(); });
  file.addEventListener("change", () => { upload(file.files[0]); file.value = ""; });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove("over"); upload(e.dataTransfer.files[0]); });
  render();
  return { root: shell(n, title, h("div", { class: "node-body" }, drop, file)) };
}

// Nota: um lembrete no quadro (o que aquele vídeo pede), sem ligação com nada.
function buildNote(n) {
  const title = h("input", { value: n.data.label || "Nota", oninput: (e) => { n.data.label = e.target.value; save(); } });
  const ta = h("textarea", { rows: 3, placeholder: "Escreva uma nota…", oninput: (e) => { n.data.text = e.target.value; save(); } });
  ta.value = n.data.text || "";
  const root = shell(n, title, h("div", { class: "node-body" }, ta));
  if (n.data.w) root.style.width = n.data.w + "px";
  return { root };
}

function buildImage(n) {
  const file = h("input", { type: "file", accept: "image/*", hidden: true });
  const drop = h("div", { class: "drop" });
  const title = h("input", { value: n.data.label || "Imagem", oninput: (e) => { n.data.label = e.target.value; save(); refreshGenerators(); } });

  const render = () => {
    drop.replaceChildren();
    if (n.data.url) {
      const p = n.data.pano;
      const img = h("img", { src: n.data.url, alt: n.data.label || "" });
      // Imagem enviada antes do modo panorâmico (ou do vídeo único): se for larga demais, refaz o
      // envio já dividida e com a faixa 21:9.
      if (!p || !p.band) {
        img.addEventListener("load", async () => {
          if (img.naturalWidth / img.naturalHeight <= MAX_RATIO || n.data.pano?.band) return;
          const blob = await (await fetch(n.data.url)).blob();
          upload(new File([blob], n.data.file, { type: blob.type }));
        }, { once: true });
      }
      drop.append(
        img,
        p ? h("span", { class: "pano-badge" }, `Panorâmica ${(p.w / p.h).toFixed(2).replace(".", ",")}:1 · ${p.tiles.length} partes`) : "", // "" e não null: append escreveria "null"
        h("div", { class: "clear" },
          h("button", { onclick: (e) => { e.stopPropagation(); file.click(); } }, "trocar"),
          h("button", { onclick: (e) => { e.stopPropagation(); n.data.url = n.data.file = n.data.pano = null; save(); render(); refreshGenerators(); } }, "remover"),
        ),
      );
    } else {
      drop.append(h("div", {}, "Solte uma imagem aqui", h("br"), h("span", { class: "meta" }, "clique para escolher ou Ctrl+V para colar")));
    }
  };

  async function upload(f) {
    if (!f) return;
    drop.replaceChildren(h("div", { class: "meta" }, "Enviando…"));
    try {
      const { blob: img, note, pano } = await prepareImage(f);
      if (note) toast(note + " Se o corte não ficar bom, ajuste a imagem e troque.");
      const j = await sendImage(img);
      n.data.file = j.file;
      n.data.url = j.url;
      n.data.pano = null;
      if (pano) {
        const tiles = [];
        for (const t of pano.tiles) tiles.push((await sendImage(t)).file);
        const band = await sendImage(pano.band.blob);
        n.data.pano = { w: pano.w, h: pano.h, tileW: pano.tileW, xs: pano.xs, tiles, band: { file: band.file, y: pano.band.y, h: pano.band.h } };
        toast(`Imagem panorâmica: pode ser gerada em ${tiles.length} partes ou num vídeo único (sem emendas).`);
      }
      save();
      refreshGenerators();
    } catch (e) {
      toast(e.message, true);
    }
    render();
  }

  drop.addEventListener("click", () => (n.data.url ? viewer({ image: n.data.url }) : file.click()));
  file.addEventListener("change", () => {
    upload(file.files[0]);
    file.value = "";
  });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); upload(e.dataTransfer.files[0]); });
  render();
  return { root: shell(n, title, h("div", { class: "node-body" }, drop, file)), upload };
}

async function sendImage(blob) {
  let res;
  try {
    res = await fetch("/api/upload", { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
  } catch {
    throw new Error("O servidor do estúdio está desligado. Abra o Abrir estudio.bat e recarregue a página.");
  }
  const j = await res.json();
  if (!res.ok) throw new Error(j.error);
  return j;
}

// Os modelos só aceitam PNG ou JPG com 300–6000 px por lado e proporção entre 0,4 e 2,5.
// Mais larga que isso vira panorâmica: partes 21:9 sobrepostas, geradas uma a uma e emendadas.
// Alta demais é cortada no centro em 9:16; fora do tamanho, redimensionada.
const MIN_SIDE = 300, MAX_SIDE = 6000, MIN_RATIO = 0.4, MAX_RATIO = 2.5;
const TILE_RATIO = 21 / 9;
const MIN_OVERLAP = 0.3; // sobreposição mínima entre partes, em alturas da imagem

const toJpeg = (canvas) => new Promise((ok) => canvas.toBlob(ok, "image/jpeg", 0.92));

function fitCanvas(src, sx, sy, sw, sh) {
  const scale = Math.max(sw, sh) > MAX_SIDE ? MAX_SIDE / Math.max(sw, sh)
    : Math.min(sw, sh) < MIN_SIDE ? MIN_SIDE / Math.min(sw, sh) : 1;
  const c = document.createElement("canvas");
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  c.getContext("2d").drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

async function panorama(bmp) {
  const { width: w, height: h } = bmp;
  let n = 2;
  while (n * TILE_RATIO - w / h < (n - 1) * MIN_OVERLAP) n++;
  const tileW = Math.round(h * TILE_RATIO);
  const xs = Array.from({ length: n }, (_, i) => Math.round((i * (w - tileW)) / (n - 1)));
  const tiles = [];
  for (const x of xs) tiles.push(await toJpeg(fitCanvas(bmp, x, 0, tileW, h)));
  // A original vai só como prévia e referência da emenda; até 8000 px de largura basta.
  const k = Math.min(1, 8000 / w);
  const prev = document.createElement("canvas");
  prev.width = Math.round(w * k);
  prev.height = Math.round(h * k);
  prev.getContext("2d").drawImage(bmp, 0, 0, prev.width, prev.height);
  return { blob: await toJpeg(prev), pano: { w, h, tileW, xs, tiles, band: await bandImage(bmp) } };
}

// Modo "vídeo único": a parede inteira numa faixa no meio de um quadro 21:9, com faixas lisas
// e desfocadas em cima e embaixo. Um vídeo só, sem emendas; depois o servidor recorta a faixa.
// Mesma proporção do quadro que o modelo devolve em "21:9" (992×432): nada da parede é cortado nas laterais.
const BAND_W = 2480, BAND_H = 1080;
const WALL_RATIO = 6410 / 1150;
async function bandImage(bmp, plate = null) {
  const c = document.createElement("canvas");
  c.width = BAND_W;
  c.height = BAND_H;
  const ctx = c.getContext("2d");
  // Paredes quase da mesma proporção (a 1 é 2172×383, as outras 6410×1150) usam a mesma faixa:
  // assim first e last frame de uma troca entre paredes ficam na mesma altura.
  const r = bmp.width / bmp.height;
  const bh = Math.round(BAND_W / (Math.abs(r / WALL_RATIO - 1) < 0.03 ? WALL_RATIO : r));
  const y = Math.round((BAND_H - bh) / 2);
  // Em cima e embaixo, a própria parede espelhada (um pouco macia): o que cruza a borda (fitas, esculturas)
  // continua do outro lado, o modelo anima tudo junto e o recorte da faixa não fica com emenda nem riscos.
  // (Antes eram faixas desfocadas paradas: nas paredes com fitas na borda, a borda saía com riscos.)
  if (plate) {
    // Com o fundo limpo do ato: em cima, o céu dele (os 30% de cima) espelhado em vaivém; embaixo, o chão (os 40%
    // de baixo). O quadro vira uma foto só, com um horizonte só — o espelho da parede inteira repetia o horizonte e
    // o metal, e o Seedance desenhava divisas e fitas em V nas margens, que apareciam no recorte.
    const pc = document.createElement("canvas");
    pc.width = BAND_W; pc.height = bh;
    pc.getContext("2d").drawImage(plate, 0, 0, BAND_W, bh);
    const fill = (top, s) => {
      const src = top ? 0 : bh - s, room = top ? y : BAND_H - y - bh;
      for (let k = 0, i = 0; k < room; k += s, i++) {
        const n = Math.min(s, room - k), flip = i % 2 === 0; // a 1ª cópia é espelhada: continua a borda sem emenda
        const dy = top ? y - k - n : y + bh + k;
        // pedaço da faixa que encosta na cópia anterior
        const sy = top ? (flip ? src : src + s - n) : (flip ? src + s - n : src);
        ctx.save();
        if (flip) { ctx.translate(0, dy + n); ctx.scale(1, -1); ctx.drawImage(pc, 0, sy, BAND_W, n, 0, 0, BAND_W, n); }
        else ctx.drawImage(pc, 0, sy, BAND_W, n, 0, dy, BAND_W, n);
        ctx.restore();
      }
    };
    fill(true, Math.round(bh * 0.3));
    fill(false, Math.round(bh * 0.4));
  } else {
    ctx.filter = "blur(3px)";
    ctx.save(); ctx.translate(0, y); ctx.scale(1, -1); ctx.drawImage(bmp, 0, 0, BAND_W, bh); ctx.restore();
    ctx.save(); ctx.translate(0, y + bh); ctx.scale(1, -1); ctx.drawImage(bmp, 0, -bh, BAND_W, bh); ctx.restore();
    ctx.filter = "none";
  }
  ctx.drawImage(bmp, 0, y, BAND_W, bh);
  return { blob: await toJpeg(c), y: y / BAND_H, h: bh / BAND_H };
}

async function prepareImage(f) {
  if (!f.type.startsWith("image/")) throw new Error("Esse arquivo não é uma imagem");
  let bmp;
  try {
    bmp = await createImageBitmap(f);
  } catch {
    throw new Error("O navegador não abre esse formato. Exporte a imagem como PNG ou JPG.");
  }
  const { width: w, height: h } = bmp;
  const ratio = w / h;
  const okType = f.type === "image/png" || f.type === "image/jpeg";
  const okRatio = ratio >= MIN_RATIO && ratio <= MAX_RATIO;
  const okSize = Math.min(w, h) >= MIN_SIDE && Math.max(w, h) <= MAX_SIDE;
  if (okType && okRatio && okSize) return { blob: f };
  if (ratio > MAX_RATIO) return panorama(bmp);

  let sy = 0, sh = h, note = null;
  if (!okRatio) {
    sh = Math.round(w / (9 / 16));
    sy = Math.round((h - sh) / 2);
    note = `Imagem ${w}×${h} é alta demais para o modelo: cortei o centro em 9:16.`;
  }
  const c = fitCanvas(bmp, 0, sy, w, sh);
  if (!note && !okSize) note = `Imagem redimensionada de ${w}×${h} para ${c.width}×${c.height}.`;
  return { blob: await toJpeg(c), note };
}

// Ctrl+V cola no nó de imagem selecionado, ou no primeiro que estiver vazio.
// Ctrl+V: imagem copiada vai para o nó de imagem selecionado (ou o primeiro vazio, ou um nó novo);
// nós copiados do estúdio são colados no mouse. Ctrl+Shift+V cola mantendo os fios de entrada.
let pasteKeepInputs = false;
addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") pasteKeepInputs = e.shiftKey;
});

addEventListener("paste", (e) => {
  clearTimeout(pendingPaste);
  if (e.target.closest?.("textarea, input:not([readonly])")) return;
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith("image/"));
  if (f) {
    e.preventDefault();
    const images = graph.nodes.filter((n) => n.type === "image");
    let target = images.find((n) => n.id === selected) || images.find((n) => !n.data.file);
    if (!target) {
      const at = pointer ? toWorld(pointer.x, pointer.y) : viewCenter();
      target = { id: uid(), type: "image", ...freeSpot(at.x, at.y, 300, 300), data: { label: "Imagem" } };
      graph.nodes.push(target);
      mount(target);
      select(target.id);
      refreshAll();
    }
    els.get(target.id).upload(f);
    return;
  }
  const text = e.clipboardData?.getData("text/plain") || "";
  const own = e.clipboardData?.getData(CLIP_TYPE) || "";
  let data = null;
  try {
    if (own) data = JSON.parse(own);
    else if (text.startsWith(CLIP_MARK)) data = JSON.parse(text.slice(CLIP_MARK.length));
  } catch {}
  // Alguns navegadores não guardam o tipo próprio: se o texto é o mesmo da última cópia, são os nós.
  if (!data && clip && (!text || text === clipText)) data = clip;
  e.preventDefault();
  if (data?.nodes?.length) return pasteNodes(data, pastePoint(data), pasteKeepInputs);
  // Texto vindo de fora vira um nó de Prompt com ele.
  if (text.trim()) {
    const at = pointer ? toWorld(pointer.x, pointer.y) : viewCenter();
    const n = { id: uid(), type: "prompt", ...freeSpot(at.x, at.y, 300, 260), data: { text: text.trim() } };
    graph.nodes.push(n);
    mount(n);
    select(n.id);
    refreshAll();
    reveal(n);
  }
});

// Soltar um arquivo fora da área não deve abrir a imagem no lugar do estúdio.
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => e.preventDefault());

// O que chega em cada entrada do gerador.
function inputsOf(n) {
  const src = (port) => {
    const e = edgeTo(n.id, port);
    return e ? node(e.from) : null;
  };
  const p = src("prompt"), f = src("first"), l = src("last"), lg = src("logo");
  return {
    // Prompt ligado por fio tem prioridade; sem fio, vale o texto escrito no próprio nó.
    prompt: (p ? p.data.text : n.data.prompt)?.trim() || "",
    promptLinked: Boolean(p),
    first: f?.data.file || null,
    last: l?.data.file || null,
    firstPano: (f?.data.file && f.data.pano) || null,
    // Vídeo único: a panorâmica vai inteira numa faixa 21:9, sem dividir em partes.
    single: Boolean(f?.data.file && f.data.pano && n.data.panoMode === "single"),
    lastPano: (l?.data.file && l.data.pano) || null,
    logo: lg?.data.text?.trim() || "",
    logoRefs: (lg?.data.refs || []).map((r) => r.file),
    logoParts: lg?.data.refsParts || [3],
    nodes: { prompt: p, first: f, last: l, logo: lg },
  };
}

// Quantas partes cada vídeo vai virar (1 fora do modo panorâmico).
const partsOf = (inp) => (inp.single ? 1 : inp.firstPano?.tiles.length || 1);

const modelOf = (n) => MODELS[n.data.model] || MODELS["seedance-2.0"];
const durationOf = (n) => Math.min(n.data.duration, modelOf(n).maxDuration);
// Referências do nó: ligadas por fio (Imagem ref. / Vídeo de movimento) ou guardadas no próprio nó.
function refsOf(n) {
  const e = (port) => { const x = edgeTo(n.id, port); return x ? node(x.from) : null; };
  const img = e("refimg"), vid = e("refvid");
  return {
    image: img?.data.file || n.data.refImage || null,
    video: (vid && videoFileOf(vid)) || n.data.refVideo || null,
    sec: Math.floor((vid ? vid.data.duration : n.data.refVideoSec) || 0),
    linked: Boolean(vid),
  };
}
const costOf = (n) => refsOf(n).video && modelOf(n).priceVideoInput
  ? modelOf(n).priceVideoInput[n.data.resolution] * (durationOf(n) + refsOf(n).sec)
  : modelOf(n).price[n.data.resolution] * durationOf(n) * partsOf(inputsOf(n));
const jobsOf = (n) => jobs.filter((j) => j.node === n.id);

// ---------- Menus (seletor de modelo, chips, lista de nós) ----------

let openMenu = null;
function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}
addEventListener("pointerdown", (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
}, true);
addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());

// items: { label, sub, right, on, onclick } ou { header }. Com search, filtra enquanto digita.
function menu(x, y, items, { search = false, width = 260 } = {}) {
  closeMenu();
  const list = h("div", { class: "menu-list" });
  const render = (q = "") => {
    const f = q.toLowerCase();
    const shown = items.filter((it) => it.header || !f || `${it.label} ${it.sub || ""}`.toLowerCase().includes(f));
    list.replaceChildren(...shown.map((it) => it.header
      ? h("div", { class: "menu-head" }, it.header)
      : h("button", { class: "menu-item" + (it.on ? " on" : ""), onclick: () => { closeMenu(); it.onclick(); } },
          h("span", { class: "menu-main" }, h("b", {}, it.label), it.sub ? h("small", {}, it.sub) : null),
          it.right ? h("span", { class: "menu-right mono" }, it.right) : null)));
  };
  const input = search ? h("input", { class: "menu-search", placeholder: "Buscar…", oninput: (e) => render(e.target.value) }) : null;
  openMenu = h("div", { class: "menu" }, input, list);
  openMenu.style.width = width + "px";
  document.body.append(openMenu);
  render();
  const r = openMenu.getBoundingClientRect();
  openMenu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + "px";
  openMenu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + "px";
  input?.focus();
}

const menuAt = (el) => {
  const r = el.getBoundingClientRect();
  return [r.left, r.bottom + 6];
};

// ---------- Nó de vídeo ----------

function buildGenerator(n) {
  const d = n.data;
  const rows = DEFS.generator.inputs.map((inp) => h("div", { class: "input-row" },
    inPort(n, inp.id, inp.type),
    h("b", {}, inp.label),
    h("span", { class: "state", "data-state": inp.id })));
  const preview = h("div", { class: "preview" });
  const pager = h("div", { class: "pager" });
  const acts = h("div", { class: "acts" });
  const promptBox = h("textarea", {
    class: "own-prompt", rows: 4,
    placeholder: "Descreva o vídeo: câmera, ação, clima, luz…",
    oninput: (e) => { d.prompt = e.target.value; save(); update(); },
  });
  promptBox.value = d.prompt || "";
  const linked = h("div", { class: "linked-prompt" });
  // Panorâmica: cada parte pode ter o próprio prompt (vazio = usa o principal). Evita que uma parte
  // sem esferas, por exemplo, invente esferas para obedecer um texto que fala delas.
  const partsBox = h("details", { class: "part-prompts", hidden: true });
  let partsSig = "";
  function renderParts(pano) {
    const sig = pano ? pano.tiles.join() : "";
    if (sig === partsSig) return;
    partsSig = sig;
    partsBox.hidden = !pano;
    if (!pano) return;
    d.partPrompts = Array.from({ length: pano.tiles.length }, (_, i) => d.partPrompts?.[i] || "");
    const names = pano.tiles.length === 3 ? ["esquerda", "meio", "direita"] : [];
    partsBox.replaceChildren(
      h("summary", {}, `Prompt por parte (${pano.tiles.length} partes)`, h("small", {}, d.partPrompts.some((t) => t.trim()) ? " · em uso" : " · clique para abrir")),
      h("div", { class: "meta" }, "Cada parte da panorâmica é gerada separada. Escreva aqui o que acontece só naquele pedaço; em branco, ela usa o prompt principal."),
      ...pano.tiles.map((tile, i) => {
        const ta = h("textarea", {
          rows: 3, placeholder: "Em branco: usa o prompt principal",
          oninput: (e) => {
            d.partPrompts[i] = e.target.value;
            partsBox.querySelector("summary small").textContent = d.partPrompts.some((t) => t.trim()) ? " · em uso" : " · clique para abrir";
            save();
          },
        });
        ta.value = d.partPrompts[i];
        return h("div", { class: "part-row" },
          h("div", { class: "part-head" }, h("img", { src: `/uploads/${tile}`, alt: "" }), h("b", {}, `Parte ${i + 1}${names[i] ? ` · ${names[i]}` : ""}`)),
          ta);
      }),
    );
    if (d.partPrompts.some((t) => t.trim())) partsBox.open = true;
  }
  const chips = h("div", { class: "chips" });
  const go = h("button", { class: "go", onclick: () => generate(n) }, h("span", {}, "Gerar"), h("span", { class: "cost" }));
  let shownSig = "";

  const set = (patch) => {
    Object.assign(d, patch);
    save();
    update();
  };

  function chip(label, value, onclick, title) {
    return h("button", { class: "chip-btn", title: title || "", onclick: (e) => onclick(e.currentTarget) },
      h("small", {}, label), h("b", {}, value));
  }

  function modelMenu(el) {
    const [x, y] = menuAt(el);
    menu(x, y, [
      { header: "Atalhos do fluxo" },
      ...PRESETS.map((p) => ({
        label: p.label, sub: `${MODELS[p.model].name} · ${p.resolution} — ${p.hint}`,
        right: money(MODELS[p.model].price[p.resolution] * 5) + "/5s",
        on: d.model === p.model && d.resolution === p.resolution,
        onclick: () => set({ model: p.model, resolution: p.resolution }),
      })),
      { header: "Modelos" },
      ...Object.entries(MODELS).map(([id, m]) => ({
        label: m.name, sub: m.note, right: `${money(m.price[m.resolutions[0]])}/s`, on: d.model === id,
        onclick: () => set({ model: id, resolution: m.resolutions.includes(d.resolution) ? d.resolution : m.resolutions[0] }),
      })),
    ], { width: 330 });
  }

  function update() {
    const inp = inputsOf(n);
    const m = modelOf(n);

    for (const key of ["prompt", "first", "last", "logo"]) {
      const el = rows.find((r) => r.querySelector(`[data-state="${key}"]`)).querySelector(".state");
      const src = inp.nodes[key];
      el.replaceChildren();
      if (key === "prompt") el.textContent = src ? (inp.prompt ? "ligado" : "vazio") : "escreva abaixo";
      else if (key === "logo") el.textContent = !src ? "—" : inp.logoRefs.length ? (m.acceptsRefs ? `texto + ${inp.logoRefs.length} vistas` : "texto (vistas só no Grok)") : (inp.logo ? "somado ao prompt" : "vazio");
      else if (src?.data.url) el.append(h("img", { class: "thumb", src: src.data.url, alt: "" }));
      else el.textContent = src ? "sem imagem" : "—";
    }

    // Prompt: com fio, mostra o texto que chega; sem fio, o campo do nó.
    promptBox.hidden = inp.promptLinked;
    linked.hidden = !inp.promptLinked;
    linked.textContent = inp.promptLinked ? inp.prompt || "O nó de Prompt ligado está vazio." : "";
    renderParts(inp.single ? null : inp.firstPano);

    const parts = partsOf(inp);
    const durs = DURATIONS.filter((s) => s <= m.maxDuration);
    if (d.duration > m.maxDuration) d.duration = m.maxDuration;
    const hasFrame = Boolean(inp.first);
    if (hasFrame && !d.ratioTouched) d.ratio = "adaptive";
    if (!hasFrame && d.ratio === "adaptive") d.ratio = "16:9";
    const ratioLabel = inp.firstPano ? `${(inp.firstPano.w / inp.firstPano.h).toFixed(2).replace(".", ",")}:1`
      : d.ratio === "adaptive" || (hasFrame && m.framesAdaptiveOnly) ? "do frame" : d.ratio;

    chips.replaceChildren(
      chip("Modelo", m.name, modelMenu),
      chip("Resolução", d.resolution, (el) => {
        const [x, y] = menuAt(el);
        menu(x, y, m.resolutions.map((r) => ({ label: r, right: `${money(m.price[r])}/s`, on: r === d.resolution, onclick: () => set({ resolution: r }) })), { width: 200 });
      }),
      chip("Duração", d.duration + "s", (el) => {
        const [x, y] = menuAt(el);
        menu(x, y, durs.map((s) => ({ label: s + " s", right: money(m.price[d.resolution] * s * parts), on: s === d.duration, onclick: () => set({ duration: s }) })), { width: 200 });
      }),
      inp.firstPano ? chip("Panorâmica", inp.single ? "vídeo único" : "em partes", () => {
        set({ panoMode: inp.single ? "parts" : "single" });
        toast(n.data.panoMode === "single"
          ? "Vídeo único: a parede inteira numa geração só, sem emendas (bom para gel, fitas e ondas que atravessam a parede). Sai com menos resolução: use 1080p ou 4K no final."
          : "Em partes: a parede em " + inp.firstPano.tiles.length + " partes emendadas, com mais resolução (bom para objetos separados, como esferas).");
      }, "Como gerar a panorâmica") : "",
      chip("Proporção", ratioLabel, (el) => {
        if (inp.firstPano) return toast(inp.single ? `O vídeo sai em ${ratioLabel}: a faixa da parede é recortada do quadro 21:9.` : `A imagem é panorâmica: o vídeo sai em ${ratioLabel}, gerado em ${parts} partes 21:9.`);
        if (hasFrame && m.framesAdaptiveOnly) return toast(`Com first frame, o ${m.name} sempre segue a proporção da imagem.`);
        const [x, y] = menuAt(el);
        menu(x, y, [
          ...(hasFrame ? [{ label: "Seguir o first frame", on: d.ratio === "adaptive", onclick: () => set({ ratio: "adaptive", ratioTouched: true }) }] : []),
          ...RATIOS.map((r) => ({ label: r, on: r === d.ratio, onclick: () => set({ ratio: r, ratioTouched: true }) })),
        ], { width: 200 });
      }),
      chip("Pratos", d.lockBlack ? "travados" : "livres", () => {
        if (!inp.first) return toast("Para travar os pratos, ligue a imagem da mesa no First frame.", true);
        set({ lockBlack: !d.lockBlack });
        toast(d.lockBlack ? "As áreas pretas do First frame (os pratos) vão ficar fixas no vídeo pronto." : "Pratos livres: o vídeo fica como o modelo gerar.");
      }, "Mantém as áreas pretas do First frame (pratos) exatamente no lugar e no tamanho"),
      h("button", { class: "chip-btn more", title: "Mais opções", onclick: (e) => moreMenu(e.currentTarget) }, "⋯"),
    );

    go.firstChild.textContent = parts > 1 ? `Gerar · ${parts} partes` : "Gerar";
    go.lastChild.textContent = money(costOf(n));

    // Prévia: o vídeo mais recente deste nó, com histórico ‹ ›.
    const mine = jobsOf(n);
    d.view = Math.min(d.view || 0, Math.max(0, mine.length - 1));
    const j = mine[d.view];
    const sig = JSON.stringify(j ? [j.id, j.status, j.progress, j.file, j.stitchedAt, j.parts?.map((p) => p.status).join(), mine.length] : null);
    if (sig === shownSig) return;
    shownSig = sig;
    pager.replaceChildren();
    acts.replaceChildren();
    if (!j) {
      preview.replaceChildren(h("div", { class: "empty" }, "O vídeo gerado aparece aqui"));
      return;
    }
    const { media, video } = jobMedia(j);
    preview.replaceChildren(media);
    if (mine.length > 1) {
      pager.append(
        h("button", { disabled: d.view >= mine.length - 1, onclick: () => { d.view++; save(); update(); } }, "‹"),
        h("span", {}, `${mine.length - d.view} / ${mine.length}`),
        h("button", { disabled: d.view <= 0, onclick: () => { d.view--; save(); update(); } }, "›"),
      );
    }
    acts.append(...jobInfo(j, video).filter(Boolean));
  }

  function moreMenu(el) {
    const [x, y] = menuAt(el);
    menu(x, y, [
      { label: "Comparar modelos", sub: "o mesmo pedido em outros modelos, lado a lado", onclick: () => compare(n) },
      { label: "Versão final", sub: "cópia em Seedance 2.5 · 1080p com as mesmas entradas", onclick: () => duplicate(n, { model: "seedance-2.5", resolution: "1080p", title: "Final" }) },
      { label: "Duplicar", sub: "cópia com as mesmas entradas", onclick: () => duplicate(n, {}) },
    ], { width: 300 });
  }

  const title = h("input", { value: d.title || "Vídeo", oninput: (e) => { d.title = e.target.value; save(); } });
  const body = h("div", {},
    h("div", { class: "inputs" }, rows),
    h("div", { class: "preview-wrap" }, preview, pager),
    acts,
    h("div", { class: "node-body" }, promptBox, linked, partsBox,
      h("div", { class: "prompt-tools" },
        h("button", { onclick: () => copyText(inputsOf(n).prompt), title: "Copia só o texto do prompt, para colar em qualquer lugar" }, "Copiar prompt")),
      chips, go),
  );
  const root = shell(n, title, body);
  update();
  return { root, update, go };
}

// Vídeo pronto, progresso ou falha, com a bolinha azul para puxar o frame.
function jobMedia(j) {
  if (j.status === "done") {
    const video = h("video", { src: `/videos/${encodeURIComponent(j.file)}?v=${j.stitchedAt || 0}`, controls: true, loop: true, muted: true, playsinline: true, preload: "metadata" });
    video.addEventListener("mouseenter", () => video.play().catch(() => {}));
    video.addEventListener("dblclick", (e) => { e.preventDefault(); viewer({ video: j.file, time: video.currentTime }); });
    const port = h("span", {
      class: "port out frame", "data-type": "image", "data-port": "frame", title: "Arraste para usar este frame como imagem",
      onpointerdown: (e) => startFrameDrag(e, j, video, port),
    });
    return { media: h("div", { class: "media" }, video, port), video };
  }
  if (j.status === "pending" || j.status === "stitching") {
    const bar = h("div", { class: "bar-p" });
    bar.style.width = (j.progress || 2) + "%";
    const label = j.status === "stitching" ? "Emendando as partes…"
      : j.parts ? `${j.progress || 0}% · ${j.parts.filter((p) => p.status === "done").length}/${j.parts.length} partes prontas`
      : `${j.progress || 0}%${j.eta ? ` · ~${j.eta}s` : ""}`;
    return { media: h("div", { class: "wait" }, h("span", { class: "spin" }), label, bar), video: null };
  }
  return { media: h("div", { class: "wait" }, j.parts?.some((p) => p.status === "done") ? "Falhou" : "Falhou (não cobrado)"), video: null };
}

// Tirar fundo: o servidor apaga o branco liso do vídeo e devolve um .mov com transparência
// (ProRes 4444, para a edição) e um .webm para a prévia, que abre em tela cheia.
// O resultado fica guardado: o nó passa a mostrar "Ver sem fundo" e "Baixar .mov" (ver cutoutButtons).
async function cutoutVideo(file, btn, onDone) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Tirando o fundo…";
  try {
    const res = await fetch("/api/cutout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file }) });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error);
    onDone?.(r);
    await loadJobs();
    toast("Fundo tirado. Os botões “Ver sem fundo” e “Baixar .mov” ficam neste nó.");
  } catch (e) {
    toast(e.message, true);
  }
  btn.disabled = false;
  btn.textContent = label;
}

// Botões do vídeo sem fundo já feito: ver em tela cheia (sobre xadrez) e baixar o .mov com transparência.
// Recorte válido: só os feitos depois da correção do risco na borda (nome com "-sem-fundo2").
const cutOk = (c) => Boolean(c?.mov && /-sem-fundo2./.test(c.mov));
// Botão ocupado: mostra o texto e os segundos que já passaram ("Juntando… 35 s"), até busyStop.
function busyLabel(btn, text) {
  const t0 = btn._busyT0 || Date.now();
  btn._busyT0 = t0;
  clearInterval(btn._busyTimer);
  const paint = () => { btn.textContent = `${text} ${Math.round((Date.now() - t0) / 1000)} s`; };
  paint();
  btn._busyTimer = setInterval(paint, 1000);
}
function busyStop(btn, text) {
  clearInterval(btn._busyTimer);
  btn._busyT0 = null;
  btn.textContent = text;
}

function cutoutButtons(c) {
  if (!cutOk(c)) return [];
  return [
    h("button", { class: "final", onclick: () => viewer({ video: c.webm }), title: "Mostra o vídeo sem fundo em tela cheia" }, "Ver sem fundo"),
    h("a", { href: `/videos/${encodeURIComponent(c.mov)}?download`, title: "ProRes 4444 com transparência, para a edição" }, "Baixar .mov"),
  ];
}

function jobInfo(j, video) {
  const m = MODELS[j.model];
  const cost = (m?.price[j.resolution] || 0) * (j.billed || j.duration * (j.parts?.length || 1));
  const busy = j.status === "pending" || j.status === "stitching";
  return [
    h("div", { class: "job-line" },
      h("span", {}, `${m?.name || j.model} · ${j.resolution} · ${j.duration}s${j.parts ? ` · ${j.parts.length} partes` : ""}`),
      h("span", { class: "mono" }, j.status === "done" ? money(cost) : busy ? `≈ ${money(cost)}` : j.billed ? `${money(cost)} cobrado` : "")),
    j.error ? h("div", { class: "err" }, j.error) : null,
    retryButton(j),
    j.status === "done" ? h("div", { class: "icon-row" },
      h("a", { href: `/videos/${encodeURIComponent(j.file)}?download`, title: "Baixar o vídeo" }, "Baixar"),
      h("button", { onclick: () => saveFrame(j, video), title: "Baixar o frame atual (ou o último) como imagem" }, "Frame"),
      h("button", { onclick: () => viewer({ video: j.file, time: video.currentTime }) }, "Tela cheia"),
      h("button", { onclick: () => continueFrom(j, video), title: "Novo vídeo começando no último frame deste" }, "Continuar"),
      cutOk(j.cutout) ? null : h("button", { onclick: (e) => cutoutVideo(j.file, e.currentTarget), title: "Tira o fundo branco liso e guarda o vídeo com transparência (.mov). Grátis." }, "Tirar fundo"),
      ...cutoutButtons(j.cutout),
      j.parts ? h("button", { onclick: () => restitch(j), title: "Refaz só a emenda das partes, sem gerar nem cobrar" }, "Refazer emenda") : null,
      j.start ? h("button", {
        class: j.lockedBlack ? "final" : "",
        onclick: (e) => lockBlack(j, !j.lockedBlack, e.currentTarget),
        title: "Cola por cima do vídeo os pretos da imagem inicial (os pratos), sempre no mesmo tamanho e lugar. Grátis.",
      }, j.lockedBlack ? "Pratos travados ✓" : "Travar pratos") : null,
    ) : null,
  ];
}

// Panorâmica com partes que falharam: refaz só essas, sem pagar de novo pelas prontas.
function retryButton(j) {
  if (!j.parts || j.status !== "failed") return null;
  const bad = j.parts.filter((p) => p.status !== "done" && p.status !== "pending");
  if (!bad.length) return null;
  const m = MODELS[j.model];
  const cost = (m?.price[j.resolution] || 0) * j.duration * bad.length;
  return h("div", { class: "icon-row" },
    h("button", { class: "final", onclick: (e) => retryParts(j, e.currentTarget) },
      `Refazer só ${bad.length > 1 ? `as ${bad.length} partes que falharam` : "a parte que falhou"} · ${money(cost)}`));
}

// ---------- Confirmação antes de cobrar ----------

// Mostra o que vai ser cobrado e o saldo; só resolve true se a pessoa clicar em "Gerar e cobrar".
async function confirmSpend({ title, rows, cost, warn }) {
  let status = null;
  try {
    status = await (await fetch("/api/status")).json();
  } catch {}
  const available = typeof status?.available === "number" ? status.available : null;
  const short = available !== null && cost > available;
  return new Promise((done) => {
    const close = (ok) => {
      box.remove();
      removeEventListener("keydown", onKey, true);
      done(ok);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); close(false); }
      if (e.key === "Enter" && !short) { e.preventDefault(); close(true); }
    };
    const go = h("button", { class: "go", disabled: short, onclick: () => close(true) },
      h("span", {}, "Gerar e cobrar"), h("span", { class: "cost" }, money(cost)));
    const box = h("div", { class: "confirm", onclick: (e) => e.target === box && close(false) },
      h("div", { class: "confirm-card" },
        h("b", { class: "confirm-title" }, title),
        h("div", { class: "confirm-rows" }, ...rows.map(([k, v]) => h("div", {}, h("span", {}, k), h("b", {}, v)))),
        h("div", { class: "confirm-money" },
          h("div", {}, h("span", {}, "Vai cobrar cerca de"), h("b", { class: "mono" }, money(cost))),
          h("div", {}, h("span", {}, "Saldo agora"), h("b", { class: "mono" }, available === null ? "indisponível" : money(available))),
          available !== null ? h("div", {}, h("span", {}, "Saldo depois"), h("b", { class: "mono" + (short ? " bad" : "") }, money(available - cost))) : null),
        short ? h("div", { class: "confirm-warn bad" }, "Saldo insuficiente para este pedido. Coloque créditos no ArgoLink ou escolha um modelo, resolução ou duração menor.") : null,
        warn ? h("div", { class: "confirm-warn" }, warn) : null,
        h("div", { class: "meta" }, "Vídeos que falham não são cobrados. Panorâmicas cobram cada parte."),
        h("div", { class: "confirm-actions" }, h("button", { class: "ghost", onclick: () => close(false) }, "Cancelar"), go)));
    document.body.append(box);
    addEventListener("keydown", onKey, true);
    (short ? box.querySelector(".ghost") : go).focus();
  });
}

// Já existe um pedido igual (mesmo modelo, resolução, duração, prompt e imagens)?
function sameRequest(n, inp) {
  const same = (j) => j.model === n.data.model && j.resolution === n.data.resolution && j.duration === durationOf(n)
    && j.prompt === inp.prompt && (j.start || null) === (inp.first || null) && (j.end || null) === (inp.first ? inp.last || null : null);
  const pending = jobs.find((j) => same(j) && (j.status === "pending" || j.status === "stitching"));
  if (pending) return "Já existe um vídeo exatamente igual sendo gerado agora. Gerar de novo vai cobrar duas vezes.";
  const done = jobs.find((j) => same(j) && j.status === "done");
  if (done) return `Você já gerou este mesmo pedido em ${new Date(done.created).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}. Gerar de novo cobra outra vez (o resultado sai diferente).`;
  return null;
}

async function retryParts(j, btn) {
  const bad = j.parts.filter((p) => p.status !== "done" && p.status !== "pending");
  const m = MODELS[j.model];
  const ok = await confirmSpend({
    title: "Refazer as partes que falharam",
    rows: [["Modelo", `${m?.name || j.model} · ${j.resolution} · ${j.duration}s`], ["Partes", `${bad.length} de ${j.parts.length} (as prontas não são cobradas de novo)`], ["Som", "não"]],
    cost: (m?.price[j.resolution] || 0) * j.duration * bad.length,
  });
  if (!ok) return;
  btn.disabled = true;
  const src = node(j.node);
  const inp = src ? inputsOf(src) : {};
  try {
    const res = await fetch("/api/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: j.id, tiles: inp.firstPano?.tiles, endTiles: inp.lastPano?.tiles, confirmed: true }),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error);
    toast("Partes que falharam enviadas de novo, sem som");
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
  }
  await loadJobs();
  loadBalance();
}

// Prompt do vídeo + texto do nó Logo ligado, separados por uma linha em branco.
const withLogo = (text, logo) => [text, logo].filter(Boolean).join("\n\n");

// Vídeo com referências (Seedance 2.0): a imagem diz o que é a cena e o vídeo diz o movimento.
// Nesse modo o Seedance não aceita first/last frame; a proporção vem do nó (ex.: 21:9).
async function generateWithRefs(n) {
  const m = modelOf(n);
  if (!m.priceVideoInput) return toast(`${m.name} não aceita vídeo de referência. Use o Seedance 2.0.`, true);
  const prompt = inputsOf(n).prompt;
  if (!prompt) return toast("Escreva o prompt no nó", true);
  const r = refsOf(n);
  if (!r.video) return toast("O vídeo de movimento ligado ainda não está pronto", true);
  if (r.sec < 2 || r.sec > 15) return toast(`O vídeo de movimento tem que ter de 2 a 15 s (este tem ${r.sec} s)`, true);
  const ui = els.get(n.id);
  if (ui.go.disabled) return;
  ui.go.disabled = true;
  const ok = await confirmSpend({
    title: `Gerar “${n.data.title || "vídeo"}”`,
    rows: [
      ["Modelo", m.name], ["Resolução", n.data.resolution], ["Duração", `${durationOf(n)} s`], ["Proporção", n.data.ratio || "21:9"],
      ["Imagem de referência", r.image || "nenhuma"],
      ["Vídeo de movimento", `${r.video} (${r.sec} s, também cobrados)`],
      ["Som", "não"],
      ["Prompt", prompt.length > 90 ? prompt.slice(0, 90) + "…" : prompt],
    ],
    cost: costOf(n),
  });
  if (!ok) { ui.go.disabled = false; return; }
  try {
    const res = await fetch("/api/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: n.data.model, resolution: n.data.resolution, duration: durationOf(n), prompt,
        aspect_ratio: n.data.ratio || "21:9", group: uid(), node: n.id,
        refImages: r.image ? [r.image] : [], refVideos: [r.video], confirmed: true,
      }),
    });
    const j = await res.json();
    if (j.stale) staleBanner();
    if (!res.ok) throw new Error(`${m.name}: ${j.error}`);
    n.data.view = 0;
    toast("Vídeo na fila");
  } catch (e) {
    toast(e.message, true);
  } finally {
    ui.go.disabled = false;
    await loadJobs();
    loadBalance();
  }
}

async function generate(n) {
  if (refsOf(n).video || edgeTo(n.id, "refvid")) return generateWithRefs(n);
  const inp = inputsOf(n);
  const partPrompts = inp.firstPano && !inp.single ? (n.data.partPrompts || []).slice(0, inp.firstPano.tiles.length).map((t) => t?.trim() || "") : [];
  const allParts = partPrompts.length && partPrompts.length === inp.firstPano.tiles.length && partPrompts.every(Boolean);
  if (!inp.prompt && !allParts) return toast(inp.promptLinked ? "O nó de Prompt ligado está vazio" : "Escreva o prompt no nó (ou um prompt em cada parte)", true);
  if (inp.last && !inp.first) return toast("O last frame precisa de um first frame junto", true);
  if (world.querySelector(".drop .meta")?.textContent === "Enviando…") return toast("Espere a imagem terminar de enviar", true);
  if (inp.single && (!inp.firstPano.band || (inp.last && !inp.lastPano?.band))) {
    return toast("Uma das imagens foi enviada antes do modo vídeo único. Clique em trocar nela e envie de novo.", true);
  }
  if (!inp.single && inp.firstPano && inp.last && inp.lastPano?.tiles.length !== inp.firstPano.tiles.length) {
    return toast("No modo panorâmico, o last frame também precisa ser panorâmico, com a mesma proporção do first frame. Solte o fio do last frame ou troque a imagem.", true);
  }
  if (!inp.firstPano && inp.lastPano) return toast("O last frame é panorâmico, mas o first frame não. Use imagens com a mesma proporção.", true);
  const ui = els.get(n.id);
  if (ui.go.disabled) return;
  ui.go.disabled = true;
  const m = modelOf(n);
  const parts = partsOf(inp);
  const ok = await confirmSpend({
    title: n.data.title && n.data.title !== m.name ? `Gerar “${n.data.title}”` : "Gerar vídeo",
    rows: [
      ["Modelo", m.name],
      ["Resolução", n.data.resolution],
      ["Duração", `${durationOf(n)} s`],
      ["Imagens", inp.first ? (inp.last ? "first e last frame" : "first frame") : "nenhuma (só o prompt)"],
      ...(parts > 1 ? [["Panorâmica", `${parts} partes, cada uma cobrada`]] : []),
      ["Som", "não"],
      ...(inp.logo ? [["Logo", "texto do nó Logo somado ao prompt"]] : []),
      ...(inp.logoRefs.length ? [["Vistas do logo", m.acceptsRefs ? `${inp.logoRefs.length} imagens de referência${parts > 1 ? ` nas partes ${inp.logoParts.join(", ")}` : ""}` : "não usadas (este modelo não aceita referências)"]] : []),
      ...(n.data.lockBlack && inp.first ? [["Pratos", "travados no lugar (grátis)"]] : []),
      partPrompts.some(Boolean)
        ? ["Prompt", `por parte: ${partPrompts.filter(Boolean).length} de ${partPrompts.length} com texto próprio`]
        : ["Prompt", inp.prompt.length > 90 ? inp.prompt.slice(0, 90) + "…" : inp.prompt],
    ],
    cost: costOf(n),
    warn: sameRequest(n, inp),
  });
  if (!ok) {
    ui.go.disabled = false;
    return;
  }
  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: n.data.model, resolution: n.data.resolution, duration: durationOf(n),
        prompt: withLogo(inp.prompt, inp.logo) + (inp.single ? " The frame is one single, seamless photograph from top to bottom, and anything that reaches the top or bottom simply continues beyond it. The camera framing stays fixed." : ""),
        start: inp.single ? inp.firstPano.band.file : inp.first,
        end: inp.first ? (inp.single ? inp.lastPano?.band?.file || null : inp.last) : null,
        origStart: inp.first, origEnd: inp.first ? inp.last : null,
        band: inp.single ? { y: inp.firstPano.band.y, h: inp.firstPano.band.h, ratio: inp.firstPano.w / inp.firstPano.h } : null,
        aspect_ratio: inp.single ? "21:9" : n.data.ratio, group: uid(), node: n.id, lockBlack: Boolean(n.data.lockBlack && inp.first),
        refs: m.acceptsRefs ? inp.logoRefs : [], refsParts: inp.firstPano && !inp.single ? inp.logoParts : null,
        pano: inp.firstPano && !inp.single ? { ...inp.firstPano, endTiles: inp.last ? inp.lastPano.tiles : null, prompts: partPrompts.map((t) => (t ? withLogo(t, inp.logo) : "")) } : null,
        confirmed: true,
      }),
    });
    const j = await res.json();
    if (j.stale) staleBanner();
    if (!res.ok) throw new Error(`${modelOf(n).name}: ${j.error}`);
    n.data.view = 0;
    toast("Vídeo na fila");
  } catch (e) {
    toast(e.message, true);
  } finally {
    ui.go.disabled = false;
    await loadJobs();
    loadBalance();
  }
}

// Cópia do nó (mesmas entradas, mesmo prompt) com outra configuração, posta abaixo.
function duplicate(n, patch, dx = 0, dy = null, show = true) {
  const b = nodeBox(n);
  const copy = { id: uid(), type: "generator", ...freeSpot(n.x + dx, n.y + (dy ?? b.h + 40), b.w, b.h),
    data: { ...n.data, view: 0, ...patch } };
  graph.nodes.push(copy);
  for (const e of graph.edges.filter((e) => e.to === n.id)) graph.edges.push({ ...e, to: copy.id });
  mount(copy);
  refreshAll();
  select(copy.id);
  if (show) reveal(copy);
  return copy;
}

// "Comparar modelos": um nó por modelo, lado a lado à direita, cada um gera quando você clicar.
function compare(n) {
  const w = nodeBox(n).w + 40;
  const others = COMPARE.filter((c) => c.model !== n.data.model);
  const copies = others.map((c, i) => duplicate(n, { ...c, title: MODELS[c.model].name }, w * (i + 1), 0, false));
  fit([n, ...copies]);
  toast(`${others.length} nós criados ao lado, ligados às mesmas entradas. Clique em Gerar em cada um que quiser testar.`);
}

// Legado: "Levar para final" dos nós de Resultados antigos.
function promote(job) {
  const g = node(job.node);
  if (!g) return toast("O nó desse vídeo foi removido", true);
  duplicate(g, { model: "seedance-2.5", resolution: "1080p", duration: job.duration, title: "Final" });
  toast("Nó Final criado abaixo. Confira o custo e clique em Gerar.");
}

function buildResult(n) {
  const list = h("div", { class: "results" });
  let sig = "";
  function update() {
    const e = edgeTo(n.id, "in");
    const mine = e ? jobs.filter((j) => j.node === e.from) : [];
    const next = JSON.stringify(mine.map((j) => [j.id, j.status, j.progress, j.file, j.stitchedAt, j.parts?.map((p) => p.status).join()]));
    if (next === sig) return;
    sig = next;
    const groups = [];
    for (const j of mine) {
      const g = groups.find((x) => x.id === j.group);
      g ? g.items.push(j) : groups.push({ id: j.group, items: [j] });
    }
    list.replaceChildren(...groups.flatMap((g) => [
      h("div", { class: "group-label" }, `${new Date(g.items[0].created).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })} · ${g.items[0].prompt}`),
      ...g.items.map((j) => card(j, g.items.length === 1)),
    ]));
  }
  return { root: shell(n, "Resultados", h("div", { class: "node-body" }, list), { inPortEl: inPort(n, "in", "video") }), update };
}

// Juntar: emenda os vídeos ligados (o mostrado em cada nó), na ordem 1, 2, 3, 4, num vídeo só.
// É feito no computador, sem custo. O primeiro quadro de cada trecho seguinte sai, porque repete
// o último do anterior (os trechos começam onde o outro terminou).
const JOIN_PORTS = ["v1", "v2", "v3", "v4", "v5", "v6"];
const JOIN_PORTS_4 = JOIN_PORTS;
function buildJoin(n, opt = {}) {
  // Composição final: mais partes e sempre no tamanho da parede.
  const JOIN_PORTS = opt.ports || JOIN_PORTS_4;
  const word = opt.word || "Trecho";
  const rows = JOIN_PORTS.map((p, i) => h("div", { class: "input-row" },
    inPort(n, p, "video"), h("b", {}, `${word} ${i + 1}`), h("span", { class: "state", "data-state": p })));
  const preview = h("div", { class: "preview" });
  const btn = h("button", { class: "go free", onclick: run }, "Juntar · grátis");
  // Emenda suave e laço perfeito (valem também para a Composição final).
  if (n.data.fade == null) n.data.fade = 0.6;
  if (n.data.loop == null) n.data.loop = true;
  const loopBox = h("input", { type: "checkbox", ...(n.data.loop ? { checked: true } : {}), onchange: (e) => { n.data.loop = e.target.checked; save(); } });
  const smooth = h("div", { class: "node-body" }, slider(n.data, "fade", "Emenda suave (s) · 0 = corte seco", 0, 2, 0.1, () => {}),
    h("label", { class: "slider", title: "O fim se funde no começo: o vídeo repete sem salto" }, h("span", { class: "slider-top" }, h("span", {}, "Laço perfeito (repete sem salto)"), loopBox)));
  const title = h("input", { value: n.data.label || "Juntar", oninput: (e) => { n.data.label = e.target.value; save(); } });
  const pieces = () => JOIN_PORTS.map((p) => {
    const e = edgeTo(n.id, p);
    const src = e && node(e.from);
    return { src, file: videoFileOf(src) };
  }).filter((x) => x.src);
  function update() {
    for (const p of JOIN_PORTS) {
      const e = edgeTo(n.id, p);
      const src = e && node(e.from);
      const el = rows[JOIN_PORTS.indexOf(p)].querySelector(".state");
      el.textContent = !src ? "—" : `${src.data.title || src.data.label || "Vídeo"} · ${videoFileOf(src) ? "pronto" : "sem vídeo"}`;
    }
    const want = n.data.file ? `/videos/${encodeURIComponent(n.data.file)}` : "";
    const cur = preview.querySelector("video");
    if (want && cur?.getAttribute("src") !== want) {
      const v = h("video", { src: want, controls: true, loop: true, muted: true, playsinline: true, preload: "metadata" });
      v.addEventListener("dblclick", (e) => { e.preventDefault(); viewer({ video: n.data.file, time: v.currentTime }); });
      preview.replaceChildren(v);
    } else if (!want) preview.replaceChildren(h("div", { class: "empty" }, "Ligue os trechos na ordem e clique em Juntar"));
  }
  let busy = false;
  async function run() {
    if (busy) return; // já está juntando: o clique repetido não faz outro
    busy = true;
    try { await runJoin(); } finally { busy = false; }
  }
  async function runJoin() {
    for (const p of JOIN_PORTS) { const e = edgeTo(n.id, p); if (e) await ensureApplied(node(e.from)).catch((er) => toast(er.message, true)); }
    const list = pieces();
    if (list.length < (n.data.loop ? 1 : 2)) return toast(n.data.loop ? "Ligue pelo menos 1 vídeo" : "Ligue pelo menos 2 vídeos nas entradas Trecho 1, 2…", true);
    const missing = list.find((x) => !x.file);
    if (missing) return toast(`“${missing.src.data.title || "Vídeo"}” ainda não tem vídeo pronto`, true);
    btn.disabled = true;
    busyLabel(btn, "Juntando…");
    try {
      const res = await fetch("/api/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: list.map((x) => x.file), wall: Boolean(opt.wall), fade: n.data.fade, loop: n.data.loop, name: n.data.label || "juntado" }) });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error);
      n.data.file = r.file;
      save();
      update();
      toast(`Pronto: ${list.length} trechos num vídeo de ${r.duration.toFixed(1).replace(".", ",")} s, em videos-gerados/`);
    } catch (e) {
      toast(e.message, true);
    }
    btn.disabled = false;
    busyStop(btn, "Juntar · grátis");
  }
  const down = h("button", { onclick: () => n.data.file && (location.href = `/videos/${encodeURIComponent(n.data.file)}?download=1`) }, "Baixar");
  // Sem fundo: guardado no nó (vale só para o vídeo juntado atual).
  const cutRow = h("span", { class: "icon-row" });
  const renderCut = () => cutRow.replaceChildren(...(cutOk(n.data.cutout) && n.data.cutout.src === n.data.file
    ? cutoutButtons(n.data.cutout)
    : [h("button", { onclick: (e) => (n.data.file ? cutoutVideo(n.data.file, e.currentTarget, (r) => { n.data.cutout = { ...r, src: n.data.file }; save(); renderCut(); }) : toast("Junte os trechos primeiro", true)), title: "Tira o fundo branco liso e guarda o vídeo com transparência (.mov). Grátis." }, "Tirar fundo")]));
  renderCut();
  const root = shell(n, title, h("div", {}, h("div", { class: "inputs" }, rows), smooth, h("div", { class: "node-body" }, preview, h("div", { class: "icon-row" }, down, h("button", { onclick: () => n.data.file && viewer({ video: n.data.file }) }, "Tela cheia"), cutRow), btn)));
  return { root, update, redo: run };
}

// Nós de uma entrada só (Logo 3D, Remover fundo): o vídeo ligado em "in" e a prévia do resultado.
function singleInput(n) {
  const state = h("span", { class: "state" });
  const row = h("div", { class: "input-row" }, inPort(n, "in", "video"), h("b", {}, "Vídeo"), state);
  const src = () => { const e = edgeTo(n.id, "in"); return e ? node(e.from) : null; };
  const paint = () => { const s = src(); state.textContent = !s ? "—" : `${s.data.title || s.data.label || "Vídeo"} · ${videoFileOf(s) ? "pronto" : "sem vídeo"}`; };
  return { row, src, paint };
}
function previewOf(preview, file, empty, checker) {
  const want = file ? `/videos/${encodeURIComponent(file)}` : "";
  const cur = preview.querySelector("video");
  if (want && cur?.getAttribute("src") !== want) {
    const v = h("video", { src: want, controls: true, loop: true, muted: true, playsinline: true, preload: "metadata", ...(checker ? { class: "checker" } : {}) });
    v.addEventListener("dblclick", (e) => { e.preventDefault(); viewer({ video: file, time: v.currentTime }); });
    preview.replaceChildren(v);
  } else if (!want) preview.replaceChildren(h("div", { class: "empty" }, empty));
}

// Logo 3D: o logo girando (render do Blender) por cima do vídeo ligado, no lugar da Forma.
// Gel: logo rosado atrás das fitas. Couvert: logo azul na água, com reflexo. Roda aqui no computador.
// Travar fundo: o cenário vem do fundo limpo do ato (parado, ou com vento na grama / água ondulando) e do vídeo
// ligado só entram os elementos, seguidos pelo SAM2 a partir das camadas do começo e do fim (PNG transparente do
// Codex, ou a parede inteira). "Troca n de N" faz o movimento do cenário continuar de uma troca na outra.
function buildTravar(n) {
  const d = n.data;
  if (!d.movimento) d.movimento = "nenhum";
  const vid = singleInput(n);
  const img = (port, label) => {
    const state = h("span", { class: "state" });
    const row = h("div", { class: "input-row" }, inPort(n, port, "image"), h("b", {}, label), state);
    const src = () => { const e = edgeTo(n.id, port); return e ? node(e.from) : null; };
    return { row, src, paint: () => { const s = src(); state.textContent = s?.data.file ? (s.data.label || "imagem") : "—"; } };
  };
  const fundo = img("fundo", "Fundo limpo"), ini = img("ini", "Elementos do começo"), fim = img("fim", "Elementos do fim");
  const preview = h("div", { class: "preview" });
  const btn = h("button", { class: "go free", onclick: run }, "Travar fundo · grátis");
  const movs = h("div", { class: "icon-row" });
  const paintMov = () => movs.replaceChildren(...[["nenhum", "Cenário parado"], ["grama", "Vento na grama"], ["agua", "Água ondulando"]].map(([k, t]) =>
    h("button", { class: d.movimento === k ? "final" : "", onclick: () => { d.movimento = k; save(); paintMov(); } }, t)));
  paintMov();
  const num = (k, label) => h("label", { class: "slider" }, h("span", { class: "slider-top" }, h("span", {}, label)),
    h("input", { type: "number", min: k === "indice" ? 1 : 1, value: k === "indice" ? (d.indice || 0) + 1 : d.total || 1, style: "width:60px",
      oninput: (e) => { const v = Math.max(1, Number(e.target.value) || 1); d[k] = k === "indice" ? v - 1 : v; save(); } }));
  const laco = h("div", { class: "icon-row" }, num("indice", "Troca nº"), num("total", "de (trocas no laço)"));
  const title = h("input", { value: d.label || "Travar fundo", oninput: (e) => { d.label = e.target.value; save(); } });
  function update() { [vid, fundo, ini, fim].forEach((x) => x.paint()); previewOf(preview, d.file, "Ligue o vídeo, o fundo limpo e os elementos do começo e do fim"); }
  let busy = false;
  async function run() {
    if (busy) return;
    const s = vid.src();
    if (!s) return toast("Ligue um vídeo na entrada", true);
    await ensureApplied(s).catch((er) => toast(er.message, true));
    const file = videoFileOf(s);
    if (!file) return toast("O vídeo ligado ainda não está pronto", true);
    const f = (x) => x.src()?.data.file || null;
    if (!f(fundo) || !f(ini) || !f(fim)) return toast("Ligue o fundo limpo e os elementos do começo e do fim", true);
    busy = true; btn.disabled = true; busyLabel(btn, "Travando…");
    try {
      const res = await fetch("/api/travar", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file, fundo: f(fundo), inicio: f(ini), fim: f(fim), movimento: d.movimento, indice: d.indice || 0, total: d.total || 1, name: d.label }) });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error);
      for (;;) {
        await new Promise((ok) => setTimeout(ok, 2000));
        const t = await (await fetch(`/api/travar/${r.id}`)).json();
        if (t.error && t.status !== "running") throw new Error(t.error);
        if (t.status === "done") { d.file = t.file; save(); update(); refreshAll(); toast("Pronto: fundo travado, em videos-gerados/"); break; }
        if (t.total) busyLabel(btn, `Travando… ${Math.round((t.progress / t.total) * 100)}% ·`);
      }
    } catch (e) { toast(e.message, true); }
    busy = false; btn.disabled = false; busyStop(btn, "Travar fundo · grátis");
  }
  const down = h("button", { onclick: () => d.file && (location.href = `/videos/${encodeURIComponent(d.file)}?download=1`) }, "Baixar");
  const root = shell(n, title, h("div", {}, h("div", { class: "inputs" }, vid.row, fundo.row, ini.row, fim.row), h("div", { class: "node-body" }, movs, laco, preview,
    h("div", { class: "icon-row" }, down, h("button", { onclick: () => d.file && viewer({ video: d.file }) }, "Tela cheia")), btn)));
  return { root, update, redo: run };
}

// Padrão de todos os logos: a velocidade do logo da Recepção na apresentação (uma volta a cada ~36 s; 1 = 5 s).
const LOGO_VEL = 0.138;
function buildLogo3d(n) {
  const d = n.data;
  if (!d.preset) d.preset = "gel";
  const inp = singleInput(n);
  const preview = h("div", { class: "preview" });
  const btn = h("button", { class: "go free", onclick: run }, "Pôr logo · grátis");
  const presets = h("div", { class: "icon-row" });
  const paintPresets = () => presets.replaceChildren(...[["gel", "Gel (rosado, atrás das fitas)"], ["perola", "Pérola rosé"], ["salada", "Salada (vidro, atrás das esculturas)"], ["risoto", "Risoto (fios de ouro)"], ["prato", "Prato principal (mercúrio)"], ["couvert", "Couvert (azul, na água)"]].map(([k, t]) =>
    h("button", { class: d.preset === k ? "final" : "", onclick: () => { d.preset = k; save(); paintPresets(); } }, t)));
  paintPresets();
  // Ajustes: valem no próximo "Pôr logo".
  if (!d.aj) d.aj = { velocidade: LOGO_VEL, inicio: 0, tamanho: 1, dx: 0, dy: 0 };
  const ajustes = h("div", {},
    slider(d.aj, "velocidade", "Velocidade do giro (0,14 = uma volta a cada 36 s, como a Recepção; 1 = 5 s)", 0.05, 3, 0.002, () => save()),
    slider(d.aj, "inicio", "Começo do giro (fração da volta)", 0, 1, 0.05, () => save()),
    slider(d.aj, "tamanho", "Tamanho (1 = o da Forma)", 0.5, 1.5, 0.05, () => save()),
    slider(d.aj, "dx", "Posição: esquerda ← → direita", -0.15, 0.15, 0.005, () => save()),
    slider(d.aj, "dy", "Posição: cima ↑ ↓ baixo", -0.3, 0.3, 0.01, () => save()),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!d.aj.frente, onchange: (e) => { d.aj.frente = e.target.checked; save(); } }), " Logo na frente: os elementos passam atrás dele"),
    h("button", { onclick: () => { Object.assign(d.aj, { velocidade: LOGO_VEL, inicio: 0, tamanho: 1, dx: 0, dy: 0 }); save(); els.get(n.id)?.root.remove(); els.delete(n.id); mount(n); refreshAll(); } }, "Voltar ao padrão"));
  const title = h("input", { value: d.label || "Logo 3D", oninput: (e) => { d.label = e.target.value; save(); } });
  function update() { inp.paint(); previewOf(preview, d.file, "Ligue um vídeo (ex.: o Juntar), escolha Gel ou Couvert e clique em Pôr logo"); }
  let busy = false;
  async function run() {
    if (busy) return;
    const s = inp.src();
    if (!s) return toast("Ligue um vídeo na entrada", true);
    await ensureApplied(s).catch((er) => toast(er.message, true));
    const file = videoFileOf(s);
    if (!file) return toast("O vídeo ligado ainda não está pronto", true);
    busy = true;
    btn.disabled = true;
    busyLabel(btn, "Pondo o logo…");
    try {
      const res = await fetch("/api/logo3d", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file, preset: d.preset, name: d.label, ajustes: d.aj }) });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error);
      for (;;) {
        await new Promise((ok) => setTimeout(ok, 2000));
        const t = await (await fetch(`/api/logo3d/${r.id}`)).json();
        if (t.error && t.status !== "running") throw new Error(t.error);
        if (t.status === "done") { d.file = t.file; save(); update(); refreshAll(); toast("Pronto: logo 3D girando, em videos-gerados/"); break; }
        if (t.total) busyLabel(btn, `Pondo o logo… ${Math.round((t.progress / t.total) * 100)}% ·`);
      }
    } catch (e) {
      toast(e.message, true);
    }
    busy = false;
    btn.disabled = false;
    busyStop(btn, "Pôr logo · grátis");
  }
  const down = h("button", { onclick: () => d.file && (location.href = `/videos/${encodeURIComponent(d.file)}?download=1`) }, "Baixar");
  const root = shell(n, title, h("div", {}, h("div", { class: "inputs" }, inp.row), h("div", { class: "node-body" }, presets, ajustes, preview,
    h("div", { class: "icon-row" }, down, h("button", { onclick: () => d.file && viewer({ video: d.file }) }, "Tela cheia")), btn)));
  return { root, update, redo: run };
}

// Remover fundo: tira o fundo branco liso do vídeo ligado e guarda com transparência (.webm para ver, .mov para a edição).
function buildRemoveBg(n) {
  const d = n.data;
  const inp = singleInput(n);
  const preview = h("div", { class: "preview" });
  const btn = h("button", { class: "go free" }, "Remover fundo · grátis");
  btn.onclick = async () => {
    const s = inp.src();
    if (!s) return toast("Ligue um vídeo na entrada", true);
    await ensureApplied(s).catch((er) => toast(er.message, true));
    const file = videoFileOf(s);
    if (!file) return toast("O vídeo ligado ainda não está pronto", true);
    await cutoutVideo(file, btn, (r) => { d.cutout = r; d.file = r.webm; save(); update(); refreshAll(); });
  };
  const title = h("input", { value: d.label || "Remover fundo", oninput: (e) => { d.label = e.target.value; save(); } });
  const extra = h("span", { class: "icon-row" });
  function update() {
    inp.paint();
    previewOf(preview, d.file, "Ligue um vídeo com fundo branco liso e clique em Remover fundo", true);
    extra.replaceChildren(...(d.cutout ? [
      h("a", { href: `/videos/${encodeURIComponent(d.cutout.mov)}?download`, title: "ProRes 4444 com transparência, para a edição" }, "Baixar .mov"),
      h("button", { onclick: () => viewer({ video: d.cutout.webm }) }, "Tela cheia")] : []));
  }
  const root = shell(n, title, h("div", {}, h("div", { class: "inputs" }, inp.row), h("div", { class: "node-body" }, preview, extra, btn)));
  return { root, update, redo: () => btn.click() };
}

// Vídeo que sai de um nó: o mostrado no nó de vídeo, ou o resultado do Juntar.
const videoFileOf = (src) => (!src ? null
  : src.type === "join" || src.type === "final" || src.type === "compose" || src.type === "clip" || src.type === "logo3d" || src.type === "removebg" || src.type === "travar" ? src.data.file || null
  : src.type === "adjust" ? (src.data.kind === "video" ? src.data.file || null : null)
  : shownJob(src)?.file || null);

// Controle deslizante com o valor ao lado; chama onInput a cada movimento (prévia ao vivo).
function slider(d, k, label, min, max, step, onInput) {
  const out = h("span", { class: "slider-val" }, String(d[k]));
  const input = h("input", { type: "range", min, max, step, value: d[k], oninput: (e) => {
    d[k] = Number(e.target.value);
    out.textContent = String(d[k]);
    onInput();
  }, onchange: () => save() });
  return h("label", { class: "slider" }, h("span", { class: "slider-top" }, h("span", {}, label), out), input);
}
// Mídia de prévia: vídeo (tocando, mudo, em laço) ou imagem.
const liveMedia = (url, isVideo) => (isVideo
  ? h("video", { src: url, autoplay: true, loop: true, muted: true, playsinline: true, preload: "auto" })
  : h("img", { src: url, alt: "" }));
// Escala da prévia: px na tela por px no arquivo (para o desfoque parecer igual ao do resultado).
const previewScale = (el) => {
  const natural = el?.videoWidth || el?.naturalWidth || 0;
  return natural && el.clientWidth ? el.clientWidth / natural : 0.25;
};
// Filtro do navegador parecido com o do Ajuste (desfoque em px do arquivo, vezes a escala da prévia).
function adjustCss(d, scale) {
  const parts = [];
  if (d.blur) parts.push(`blur(${(d.blur * scale).toFixed(2)}px)`);
  if (d.brightness) parts.push(`brightness(${(1 + d.brightness * 1.6).toFixed(3)})`);
  if (d.contrast != null && d.contrast !== 1) parts.push(`contrast(${d.contrast})`);
  if (d.saturation != null && d.saturation !== 1) parts.push(`saturate(${d.saturation})`);
  if (d.warmth > 0) parts.push(`sepia(${(d.warmth * 0.35).toFixed(3)})`);
  if (d.warmth < 0) parts.push(`hue-rotate(${(d.warmth * 18).toFixed(1)}deg) saturate(${(1 - d.warmth * 0.15).toFixed(3)})`);
  return parts.join(" ");
}
// O que um nó mostra ao vivo: o arquivo dele, ou (num Ajuste ainda não aplicado) a entrada dele com
// os filtros e a velocidade do Ajuste somados. Assim a prévia de um Compor já mostra os Ajustes.
function liveSourceOf(src, seen = new Set()) {
  if (!src || seen.has(src.id)) return null;
  seen.add(src.id);
  if (src.type === "adjust") {
    const e = edgeTo(src.id, "in");
    const base = e ? liveSourceOf(node(e.from), seen) : null;
    if (src.data.file && !src.data.dirty) {
      const img = src.data.kind === "image";
      return { url: img ? `/uploads/${encodeURIComponent(src.data.file)}` : `/videos/${encodeURIComponent(src.data.file)}`, video: !img, adjusts: [], rate: 1, origin: base?.origin };
    }
    if (!base) return null;
    return { ...base, adjusts: [...base.adjusts, src.data], rate: base.rate * (src.data.speed || 1) };
  }
  if (outTypeOf(src) === "image") return src.data.file ? { url: `/uploads/${encodeURIComponent(src.data.file)}`, video: false, adjusts: [], rate: 1, origin: src } : null;
  const f = videoFileOf(src);
  return f ? { url: `/videos/${encodeURIComponent(f)}`, video: true, adjusts: [], rate: 1, origin: src, file: f } : null;
}
const chainCss = (adjusts, scale) => adjusts.map((a) => adjustCss(a, scale)).filter(Boolean).join(" ");
// Antes de usar um nó num Compor ou Juntar: se ele (ou um Ajuste antes dele) está com ajuste novo,
// grava o arquivo agora. Assim não precisa clicar em Aplicar.
async function cascade(id, seen = new Set()) {
  let count = 0;
  for (const e of graph.edges.filter((x) => x.from === id)) {
    const m = node(e.to);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    const ui = els.get(m.id);
    if (ui?.redo && m.data.file) {
      await ui.redo();
      count++;
      count += await cascade(m.id, seen);
    }
  }
  return count;
}

async function ensureApplied(src, seen = new Set()) {
  if (!src || seen.has(src.id)) return;
  seen.add(src.id);
  if (src.type !== "adjust") return;
  const e = edgeTo(src.id, "in");
  if (e) await ensureApplied(node(e.from), seen);
  if (src.data.dirty || !src.data.file) await els.get(src.id)?.apply?.();
}

// Compor: o logo (sem fundo) por cima das ondas, sempre no lugar e no tamanho da Forma, exportado como
// um vídeo só. Os controles (borda suave e brilho branco) mudam a prévia ao vivo; "Compor" faz o arquivo.
const COMPOSE_DEFAULT = { x: 85.0, y: 35.7, size: 19.3, feather: 0, glow: 0, eraseSoft: 0, eraseGrow: 0, stillDur: 10, logoStart: 0 }; // centro e tamanho da Forma original
const FORMA_MASK = "forma-mascara-parede-branca.png"; // lugar da Forma na parede branca (em uploads/)
function buildCompose(n) {
  const d = n.data;
  for (const [k, v] of Object.entries(COMPOSE_DEFAULT)) if (d[k] == null) d[k] = v;
  // Fundo: um vídeo (as ondas) ou uma imagem parada (ex.: a parede branca); se os dois estiverem ligados, vale o vídeo.
  const ports = [["bg", "Fundo (vídeo)", "video"], ["bgimg", "Fundo (imagem)", "image"], ["logo", "Logo (vídeo)", "video"], ["logoimg", "Logo (imagem)", "image"]];
  const rows = ports.map(([p, label, type]) => h("div", { class: "input-row" },
    inPort(n, p, type), h("b", {}, label), h("span", { class: "state", "data-state": p })));
  const changed = () => { d.dirty = true; showLive(); };
  const sliders = h("div", { class: "sliders" },
    slider(d, "eraseGrow", "Alargar a área apagada px (some com o logo de baixo inteiro)", 0, 300, 1, () => { if (!d.erase) d.erase = d.mask || FORMA_MASK; changed(); update(); }),
    slider(d, "eraseSoft", "Apagar com branco suave px (cobre a Forma de baixo)", 0, 600, 1, () => { if (!d.erase) d.erase = d.mask || FORMA_MASK; changed(); update(); }),
    slider(d, "glow", "Brilho branco atrás do logo px", 0, 200, 1, changed),
    slider(d, "stillDur", "Duração com fundo de imagem (s)", 2, 60, 1, changed),
    slider(d, "logoStart", "Logo começa em (s) · some a duração das partes anteriores", 0, 300, 0.5, changed),
    slider(d, "feather", "Borda suave px", 0, 40, 0.5, changed));
  const finalBtn = h("button", { onclick: () => { d.final = d.final === "parede" ? "fundo" : "parede"; save(); update(); } });
  // Quando o fundo foi gerado com a Forma (as ondas saem dela), a Forma original é apagada
  // (vira branco liso) antes de pôr o logo girando: assim ela não aparece quando o logo fica de lado.
  // Três modos, em volta: não apaga → apaga a Forma parada (máscara fixa) → apaga a Forma que gira
  // (procura a Forma em cada quadro) → não apaga. A máscara da Forma parada fica guardada em d.mask.
  if (d.erase && d.erase !== "movel") d.mask = d.erase;
  const eraseBtn = h("button", { onclick: () => {
      d.erase = !d.erase ? d.mask || FORMA_MASK : d.erase === "movel" ? null : "movel";
      save(); changed(); update();
    },
    title: "Forma parada: apaga um lugar fixo. Forma que gira: acha a Forma em cada quadro do vídeo de fundo e apaga só ela. Use quando as ondas foram geradas com a Forma." });
  const preview = h("div", { class: "preview" });
  const hint = h("div", { class: "meta live-hint" });
  const btn = h("button", { class: "go free", onclick: run }, "Compor · grátis");
  const title = h("input", { value: d.label || "Compor", oninput: (e) => { d.label = e.target.value; save(); } });
  const src = (p) => { const e = edgeTo(n.id, p); return e ? node(e.from) : null; };
  const bgNode = () => (videoFileOf(src("bg")) || src("bg")?.type === "adjust" ? src("bg") : src("bgimg"));
  const logoNode = () => (videoFileOf(src("logo")) || src("logo")?.type === "adjust" ? src("logo") : src("logoimg"));
  // Para o brilho branco aparecer na prévia, o logo em vídeo precisa da versão sem fundo (.webm).
  let cutting = false;
  function logoAlphaUrl(ls) {
    if (!ls?.video || !ls.file) return null;
    const o = ls.origin;
    const c = o?.type === "join" ? o.data.cutout : o?.type === "generator" ? shownJob(o)?.cutout : null;
    if (cutOk(c) && (o.type !== "join" || c.src === ls.file)) return `/videos/${encodeURIComponent(c.webm)}`;
    if (!cutting) {
      cutting = true;
      cutoutVideo(ls.file, { textContent: "", disabled: false }, (r) => { if (o?.type === "join") { o.data.cutout = { ...r, src: ls.file }; save(); } cutting = false; live = null; showLive(); });
    }
    return null;
  }
  // Prévia ao vivo: fundo + logo + a área apagada, com os Ajustes ligados antes já aplicados na tela.
  let live = null;
  function showLive() {
    const bs = liveSourceOf(bgNode()), ls = liveSourceOf(logoNode());
    if (!bs || !ls) {
      live = null;
      preview.replaceChildren(h("div", { class: "empty" }, "Ligue o fundo e o logo (vídeo ou imagem em cada um)"));
      hint.textContent = "";
      return;
    }
    const alpha = d.glow > 0 ? logoAlphaUrl(ls) : null;
    const logoUrl = alpha || ls.url;
    const sig = bs.url + "|" + logoUrl;
    if (!live || live.sig !== sig) {
      const bgEl = liveMedia(bs.url, bs.video);
      const logoEl = liveMedia(logoUrl, ls.video);
      logoEl.className = "live-logo";
      // Logo com fundo branco (mp4) entra em Multiplicar para o branco sumir; com transparência, normal.
      logoEl.style.mixBlendMode = alpha || /\.png$/i.test(ls.url) ? "normal" : "multiply";
      // Área apagada: o desfoque fica no envoltório (para espalhar o branco além da forma); duas camadas
      // brancas somadas deixam o miolo branco cheio, como no arquivo final.
      const masks = [h("div", { class: "live-erase" }), h("div", { class: "live-erase" })];
      const erase = h("div", { class: "live-erase-wrap" }, ...masks);
      const box = h("div", { class: "live-box" }, bgEl, erase, logoEl);
      live = { sig, box, bgEl, logoEl, erase, masks, bs, ls, alpha };
      const fix = () => { box.style.aspectRatio = `${bgEl.videoWidth || bgEl.naturalWidth || 6410} / ${bgEl.videoHeight || bgEl.naturalHeight || 1150}`; place(); };
      bgEl.addEventListener(bs.video ? "loadedmetadata" : "load", fix);
      if (ls.video) logoEl.addEventListener("loadedmetadata", () => { try { logoEl.currentTime = (d.logoStart || 0) % (logoEl.duration || 1e9); } catch {} place(); });
      preview.replaceChildren(box);
    } else if (!preview.contains(live.box)) preview.replaceChildren(live.box);
    live.bs = bs;
    live.ls = ls;
    place();
  }
  function place() {
    if (!live) return;
    const { logoEl, erase, masks, box, bgEl, bs, ls } = live;
    logoEl.style.left = `${d.x}%`;
    logoEl.style.top = `${d.y}%`;
    logoEl.style.width = `${d.size}%`;
    const k = box.clientWidth / 6410; // os px dos controles são da parede inteira
    bgEl.style.filter = chainCss(bs.adjusts, previewScale(bgEl));
    if (bs.video) bgEl.playbackRate = bs.rate;
    if (ls.video) logoEl.playbackRate = ls.rate;
    const fx = [chainCss(ls.adjusts, previewScale(logoEl))];
    // Brilho branco: halo branco suave em volta do logo (por fora e dentro da abertura).
    if (d.glow > 0 && live.alpha) { const r = Math.max(1, d.glow * k); fx.push(`drop-shadow(0 0 ${r.toFixed(1)}px #fff) drop-shadow(0 0 ${(r * 0.6).toFixed(1)}px #fff)`); }
    logoEl.style.filter = fx.filter(Boolean).join(" ");
    const mask = d.erase && d.erase !== "movel" ? `url(/uploads/${encodeURIComponent(d.erase)})` : "";
    erase.style.display = mask ? "" : "none";
    // Branco suave: a área apagada desfocada (e um pouco mais forte, como no arquivo final).
    erase.style.filter = d.eraseSoft > 0 ? `blur(${(d.eraseSoft * k).toFixed(1)}px)` : "";
    const grow = 1 + ((d.eraseGrow || 0) * 2) / (6410 * (d.size / 100) * 0.7); // ~ px a mais de cada lado
    erase.style.transformOrigin = `${d.x}% ${d.y}%`;
    erase.style.transform = grow > 1 ? `scale(${grow.toFixed(3)})` : "";
    for (const m of masks) m.style.maskImage = m.style.webkitMaskImage = mask;
    hint.textContent = d.glow > 0 && ls.video && !live.alpha ? "Preparando o logo sem fundo para mostrar o brilho branco…"
      : d.erase === "movel" ? "Prévia ao vivo · a Forma que gira só é apagada no resultado (clique em Compor)."
      : "Prévia ao vivo · o branco suave e o brilho aparecem aqui; a borda suave só no resultado. Compor faz o arquivo final.";
  }
  function update() {
    for (const [p] of ports) {
      const s = src(p);
      rows[ports.findIndex((x) => x[0] === p)].querySelector(".state").textContent =
        !s ? "—" : outTypeOf(s) === "image" ? `${s.data.label || "Imagem"} · ${s.data.file ? "pronta" : "sem imagem"}`
          : `${s.data.title || s.data.label || "Vídeo"} · ${videoFileOf(s) || s.type === "adjust" ? "pronto" : "sem vídeo"}`;
    }
    finalBtn.textContent = d.final === "parede" ? "Sai em 6410 × 1150" : "Sai no tamanho do fundo";
    eraseBtn.textContent = d.erase === "movel" ? "Apaga a Forma que gira ✓" : d.erase ? "Apaga a Forma parada ✓" : "Não apaga a Forma do fundo";
    eraseBtn.className = d.erase ? "final" : "";
    if (d.file && !d.dirty) {
      const want = `/videos/${encodeURIComponent(d.file)}`;
      if (preview.querySelector(":scope > video")?.getAttribute("src") !== want) {
        const v = h("video", { src: want, controls: true, loop: true, muted: true, playsinline: true, preload: "metadata" });
        v.addEventListener("dblclick", (e) => { e.preventDefault(); viewer({ video: d.file, time: v.currentTime }); });
        preview.replaceChildren(v);
      }
      hint.textContent = "Resultado composto. Mexa em qualquer controle para voltar à prévia ao vivo.";
    } else showLive();
  }
  let busy = false;
  async function run() {
    if (busy) return; // já está compondo: o clique repetido não faz outro
    busy = true;
    try { await runCompose(); } finally { busy = false; }
  }
  async function runCompose() {
    btn.disabled = true;
    busyLabel(btn, "Preparando…");
    try {
      // Ajustes ligados antes (no fundo ou no logo) são gravados agora, sem precisar de Aplicar.
      for (const p of ["bg", "bgimg", "logo", "logoimg"]) await ensureApplied(src(p));
      const bg = videoFileOf(src("bg")), bgImage = outTypeOf(src("bgimg")) === "image" ? src("bgimg")?.data.file || null : null;
      const logo = videoFileOf(src("logo")), logoImage = outTypeOf(src("logoimg")) === "image" ? src("logoimg")?.data.file || null : null;
      if (!bg && !bgImage) throw new Error("Ligue um vídeo pronto em Fundo (vídeo) ou uma imagem em Fundo (imagem)");
      if (!logo && !logoImage) throw new Error("Ligue o logo: um vídeo em Logo (vídeo) ou uma imagem em Logo (imagem)");
      busyLabel(btn, "Compondo…");
      const res = await fetch("/api/compose", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bg, bgImage: bg ? null : bgImage, logo, logoImage: logo ? null : logoImage, x: d.x / 100, y: d.y / 100, size: d.size / 100, final: d.final || "fundo", erase: d.erase || null, feather: d.feather || 0, glow: d.glow || 0, eraseSoft: d.eraseSoft || 0, eraseGrow: d.eraseGrow || 0, stillDur: d.stillDur || 10, logoStart: d.logoStart || 0 }) });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error);
      d.file = r.file;
      d.dirty = false;
      save();
      update();
      toast(`Pronto: parede com o logo, ${r.w} × ${r.h}, em videos-gerados/`);
    } catch (e) {
      toast(e.message, true);
    }
    btn.disabled = false;
    busyStop(btn, "Compor · grátis");
  }
  const down = h("button", { onclick: () => d.file && (location.href = `/videos/${encodeURIComponent(d.file)}?download=1`) }, "Baixar");
  const root = shell(n, title, h("div", {},
    h("div", { class: "inputs" }, rows),
    h("div", { class: "node-body" },
      preview, hint, sliders,
      h("div", { class: "icon-row" }, finalBtn, eraseBtn),
      h("div", { class: "icon-row" }, down, h("button", { onclick: () => d.file && viewer({ video: d.file }) }, "Tela cheia")), btn)));
  root.classList.add("wide-node");
  return { root, update, redo: run };
}

// Ajuste: velocidade, desfoque, brilho, contraste, saturação e cor num vídeo ou imagem. Entra qualquer
// coisa (o que estiver ligado em "Entrada") e sai o resultado, do mesmo tipo, para o próximo nó.
// Os controles mudam a prévia ao vivo. O arquivo é gravado sozinho quando um Compor ou Juntar usa
// este nó, ou no botão "Aplicar" (que também refaz os nós ligados depois).
const ADJUST_DEFAULT = { speed: 1, blur: 0, brightness: 0, contrast: 1, saturation: 1, warmth: 0 };
function buildAdjust(n) {
  const d = n.data;
  for (const [k, v] of Object.entries(ADJUST_DEFAULT)) if (d[k] == null) d[k] = v;
  const row = h("div", { class: "input-row" }, inPort(n, "in", "any"), h("b", {}, "Entrada"), h("span", { class: "state" }));
  const changed = () => { d.dirty = true; showLive(); refreshCompose(); };
  // Os Compor ligados depois deste nó atualizam a prévia deles junto.
  const refreshCompose = () => { for (const e of graph.edges.filter((x) => x.from === n.id)) els.get(e.to)?.update?.(); };
  const sliders = h("div", { class: "sliders" },
    slider(d, "speed", "Velocidade (1 = normal, 0,5 = metade)", 0.1, 1, 0.05, changed),
    slider(d, "blur", "Desfoque px", 0, 60, 0.5, changed),
    slider(d, "brightness", "Brilho", -0.5, 0.5, 0.01, changed),
    slider(d, "contrast", "Contraste", 0.3, 2.5, 0.01, changed),
    slider(d, "saturation", "Saturação", 0, 2.5, 0.01, changed),
    slider(d, "warmth", "Cor (− fria, + quente)", -1, 1, 0.01, changed));
  const preview = h("div", { class: "preview" });
  const hint = h("div", { class: "meta live-hint" });
  const btn = h("button", { class: "go adjust-go", onclick: () => applyAndCascade() }, "Aplicar · grátis");
  // Aplicar: grava este ajuste e refaz, em ordem, os Compor/Juntar/Composição final ligados depois
  // (só os que já tinham um resultado), para eles passarem a usar a versão nova.
  let busy = false;
  async function applyAndCascade() {
    if (busy) return;
    busy = true;
    try {
      await run();
      const n2 = await cascade(n.id);
      toast(n2 ? `Ajuste aplicado e ${n2} nó(s) seguinte(s) refeito(s) com ele.` : "Ajuste aplicado. Os nós ligados depois já usam a versão nova.");
    } catch (e) {
      toast(e.message, true);
    } finally {
      busy = false;
    }
  }
  const title = h("input", { value: d.label || "Ajuste", oninput: (e) => { d.label = e.target.value; save(); } });
  const source = () => {
    const e = edgeTo(n.id, "in");
    const s0 = e && node(e.from);
    if (!s0) return null;
    const kind = outTypeOf(s0);
    const file = kind === "image" ? s0.data.file || null : videoFileOf(s0);
    return { node: s0, kind, file };
  };
  // Prévia ao vivo: a entrada com filtros do navegador parecidos com os do arquivo final.
  let live = null;
  function showLive() {
    const s0 = source();
    if (!s0?.file) {
      live = null;
      preview.replaceChildren(h("div", { class: "empty" }, "Ligue um vídeo ou imagem em Entrada"));
      hint.textContent = "";
      return;
    }
    const url = s0.kind === "image" ? `/uploads/${encodeURIComponent(s0.file)}` : `/videos/${encodeURIComponent(s0.file)}`;
    if (!live || live.url !== url) {
      const el = liveMedia(url, s0.kind !== "image");
      el.addEventListener(s0.kind === "image" ? "load" : "loadedmetadata", () => paint());
      live = { url, el, video: s0.kind !== "image" };
      preview.replaceChildren(el);
    } else if (!preview.contains(live.el)) preview.replaceChildren(live.el);
    paint();
  }
  function paint() {
    if (!live) return;
    live.el.style.filter = adjustCss(d, previewScale(live.el));
    if (live.video) live.el.playbackRate = d.speed || 1;
    hint.textContent = live.video && d.speed < 1
      ? "Prévia ao vivo · na tela a velocidade só desacelera; no arquivo os quadros do meio são criados para ficar suave."
      : "Prévia ao vivo · clique em Aplicar para gravar e refazer os nós ligados depois.";
  }
  function update() {
    const s0 = source();
    row.querySelector(".state").textContent = !s0 ? "— (vídeo ou imagem)" : `${s0.node.data.title || s0.node.data.label || "Entrada"} · ${s0.file ? (s0.kind === "image" ? "imagem" : "vídeo") : "sem arquivo"}`;
    const out = els.get(n.id)?.root.querySelector(".port.out");
    if (out) out.dataset.type = outTypeOf(n);
    if (d.file && !d.dirty) {
      const want = d.kind === "image" ? `/uploads/${encodeURIComponent(d.file)}` : `/videos/${encodeURIComponent(d.file)}`;
      if (preview.querySelector(":scope > video, :scope > img")?.getAttribute("src") !== want) {
        preview.replaceChildren(d.kind === "image"
          ? h("img", { src: want, alt: "" })
          : h("video", { src: want, controls: true, loop: true, muted: true, playsinline: true, preload: "metadata" }));
      }
      live = null;
      hint.textContent = "Ajuste aplicado. Mexa em qualquer controle para voltar à prévia ao vivo.";
    } else showLive();
  }
  async function run() {
    const s0 = source();
    if (!s0?.file) throw new Error(`Ligue em Entrada de “${d.label || "Ajuste"}” um vídeo pronto ou uma imagem`);
    btn.disabled = true;
    busyLabel(btn, d.speed < 1 && s0.kind !== "image" ? "Criando os quadros…" : "Aplicando…");
    try {
      const res = await fetch("/api/adjust", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: s0.file, kind: s0.kind, speed: d.speed, blur: d.blur, brightness: d.brightness, contrast: d.contrast, saturation: d.saturation, warmth: d.warmth }) });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error);
      d.file = r.file;
      d.kind = s0.kind;
      d.dirty = false;
      if (s0.kind === "image") d.url = r.url; // nós de imagem leem data.url / data.file
      save();
      refreshAll();
    } finally {
      btn.disabled = false;
      busyStop(btn, "Aplicar · grátis");
    }
  }
  const reset = h("button", { onclick: () => { Object.assign(d, ADJUST_DEFAULT); d.dirty = true; save(); els.get(n.id)?.root.remove(); els.delete(n.id); mount(n); refreshAll(); } }, "Zerar");
  const root = shell(n, title, h("div", {},
    h("div", { class: "inputs" }, row),
    h("div", { class: "node-body" },
      preview, hint, sliders,
      h("div", { class: "icon-row" }, reset, h("button", { onclick: () => d.file && (d.kind === "image" ? viewer({ image: `/uploads/${encodeURIComponent(d.file)}` }) : viewer({ video: d.file })) }, "Tela cheia")),
      btn)));
  return { root, update, apply: run };
}

function card(j, wide) {
  const { media, video } = jobMedia(j);
  const info = jobInfo(j, video);
  const canFinal = j.status === "done" && j.resolution !== "1080p" && j.resolution !== "4k";
  return h("div", { class: "card" + (wide ? " wide" : "") }, media,
    h("div", { class: "info" }, ...info, canFinal ? h("div", { class: "icon-row" }, h("button", { class: "final", onclick: () => promote(j) }, "Levar para final")) : null));
}

async function lockBlack(j, on, btn) {
  btn.disabled = true;
  btn.textContent = on ? "Travando…" : "Destravando…";
  try {
    const res = await fetch("/api/lock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: j.id, on }) });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error);
    toast(on ? "Pratos travados: eles ficam exatamente como na imagem inicial (grátis)" : "Trava removida: voltou o vídeo original");
  } catch (e) {
    toast(e.message, true);
  }
  await loadJobs();
}

async function restitch(j) {
  const res = await fetch("/api/restitch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: j.id }) });
  const r = await res.json();
  if (!res.ok) return toast(r.error, true);
  toast("Refazendo a emenda (grátis)…");
  await loadJobs();
}

// ---------- Frames dos vídeos ----------

// Frame atual se o vídeo estiver pausado no meio; senão, o último.
async function grabFrame(j, video) {
  const t = video && video.paused && video.currentTime > 0.05 && video.currentTime < video.duration - 0.15 ? video.currentTime : null;
  const res = await fetch("/api/frame", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: j.file, t }) });
  const r = await res.json();
  if (!res.ok) throw new Error(r.error);
  return r;
}

async function saveFrame(j, video) {
  try {
    const f = await grabFrame(j, video);
    h("a", { href: `${f.url}?download` }).click();
  } catch (e) {
    toast(e.message, true);
  }
}

// Cria um nó de imagem com o frame e o envia como se fosse um arquivo novo (panorâmicas são divididas de novo).
async function frameNode(j, video, x, y, label) {
  const n = { id: uid(), type: "image", ...freeSpot(x, y, 300, 300), data: { label } };
  graph.nodes.push(n);
  mount(n);
  refreshAll();
  reveal(n);
  try {
    const f = await grabFrame(j, video);
    const blob = await (await fetch(f.url)).blob();
    await els.get(n.id).upload(new File([blob], f.file, { type: "image/jpeg" }));
  } catch (e) {
    toast(e.message, true);
  }
  return n;
}

function resultNodeOf(j) {
  const e = graph.edges.find((x) => x.from === j.node && node(x.to)?.type === "result");
  return e ? node(e.to) : null;
}

// "Continuar": frame vira First frame de um nó de vídeo novo à direita, com o mesmo prompt.
async function continueFrom(j, video) {
  const g = node(j.node);
  const anchor = resultNodeOf(j) || g;
  const base = anchor ? { x: anchor.x + (els.get(anchor.id).root.offsetWidth || 360) + 60, y: anchor.y } : { x: 0, y: 0 };
  const gen = { id: uid(), type: "generator", x: base.x + 340, y: base.y, data: { ...(g ? g.data : genDefaults()), view: 0, title: "Continuação" } };
  Object.assign(gen, freeSpot(gen.x, gen.y));
  graph.nodes.push(gen);
  mount(gen);
  const promptEdge = g && edgeTo(g.id, "prompt");
  if (promptEdge) graph.edges.push({ from: promptEdge.from, to: gen.id, port: "prompt" });
  const img = await frameNode(j, video, base.x, base.y, "First frame (do vídeo)");
  graph.edges.push({ from: img.id, to: gen.id, port: "first" });
  refreshAll();
  select(gen.id);
  fit([img, gen]);
  toast("Nó de continuação criado à direita. Ajuste o prompt se quiser e clique em Gerar.");
}

function startFrameDrag(e, j, video, port) {
  e.stopPropagation();
  e.preventDefault();
  const r = port.getBoundingClientRect();
  const a = toWorld(r.left + r.width / 2, r.top + r.height / 2);
  const move = (ev) => drawWires({ a, b: toWorld(ev.clientX, ev.clientY), type: "image" });
  const up = async (ev) => {
    removeEventListener("pointermove", move);
    drawWires();
    const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.port.in[data-type="image"]');
    const at = toWorld(ev.clientX, ev.clientY);
    if (target) {
      const to = target.closest(".node").dataset.id;
      const t = node(to);
      const img = await frameNode(j, video, t.x - 340, t.y + (target.dataset.port === "last" ? 260 : 0), target.dataset.port === "last" ? "Last frame (do vídeo)" : "First frame (do vídeo)");
      graph.edges = graph.edges.filter((x) => !(x.to === to && x.port === target.dataset.port));
      graph.edges.push({ from: img.id, to, port: target.dataset.port });
      refreshAll();
    } else {
      await frameNode(j, video, at.x, at.y - 40, "Frame do vídeo");
    }
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up, { once: true });
}

// ---------- Tela cheia ----------

function viewer({ video, image, time = 0 }) {
  const close = () => {
    box.remove();
    removeEventListener("keydown", onKey);
  };
  const onKey = (e) => e.key === "Escape" && close();
  let media;
  if (video) {
    media = h("video", { src: `/videos/${encodeURIComponent(video)}`, controls: true, autoplay: true, loop: true, playsinline: true });
    media.currentTime = time;
  } else {
    media = h("img", { src: image, alt: "" });
  }
  const box = h("div", { class: "viewer", onclick: (e) => e.target === box && close() },
    media,
    h("div", { class: "viewer-bar" },
      h("a", { href: video ? `/videos/${encodeURIComponent(video)}?download` : `${image}?download` }, video ? "Baixar vídeo" : "Baixar imagem"),
      h("button", { onclick: close }, "Fechar (Esc)"),
    ),
  );
  document.body.append(box);
  addEventListener("keydown", onKey);
}

const BUILD = { final: (n) => buildJoin(n, { ports: ["v1", "v2", "v3", "v4", "v5", "v6"], wall: true, word: "Parte" }), adjust: buildAdjust, compose: buildCompose, join: buildJoin, note: buildNote, group: buildGroup, clip: buildClip, logo3d: buildLogo3d, travar: buildTravar, removebg: buildRemoveBg, prompt: buildPrompt, logo: buildLogo, image: buildImage, generator: buildGenerator, result: buildResult };

function mount(n) {
  if (!BUILD[n.type]) return; // tipo de nó desconhecido (de uma versão mais nova): não quebra o resto do quadro
  const ui = BUILD[n.type](n);
  els.set(n.id, ui);
  // Grupos ficam atrás de tudo (antes dos fios e dos outros nós).
  if (n.type === "group") world.prepend(ui.root);
  else world.append(ui.root);
}

function removeNode(id) {
  graph.nodes = graph.nodes.filter((n) => n.id !== id);
  graph.edges = graph.edges.filter((e) => e.from !== id && e.to !== id);
  els.get(id)?.root.remove();
  els.delete(id);
  refreshAll();
}

function addNode(type, label) {
  const r = canvas.getBoundingClientRect();
  const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
  const n = { id: uid(), type, x: c.x - 150 + Math.random() * 40, y: c.y - 120 + Math.random() * 40,
    data: type === "generator" ? genDefaults() : type === "image" ? { label } : type === "prompt" ? { text: "" } : {} };
  graph.nodes.push(n);
  mount(n);
  select(n.id);
  refreshAll();
}

// Lista de nós: duplo clique no fundo, botão "+ Adicionar" ou soltar um fio no vazio.
// Com { from, type }, mostra só o que aceita aquela saída e já liga o fio.
// Sem posição (botão da barra), o nó nasce no centro da tela, num espaço livre.
function nodePicker(clientX, clientY, link = null, { center = false } = {}) {
  const c = viewCenter();
  const at = center ? { x: c.x - 190, y: c.y - 160 } : toWorld(clientX, clientY);
  const place = (n) => {
    Object.assign(n, freeSpot(n.x, n.y, n.type === "generator" ? 380 : 300, n.type === "generator" ? 640 : 300));
    graph.nodes.push(n);
    mount(n);
    if (link && link.type !== "video") {
      graph.edges.push({ from: link.from, to: n.id, port: link.type === "text" ? "prompt" : "first" });
    }
    select(n.id);
    refreshAll();
    reveal(n);
    return n;
  };
  const video = (model, resolution) => () => place({ id: uid(), type: "generator", x: at.x, y: at.y - 40, data: { ...genDefaults(model, resolution), title: MODELS[model].name } });
  const videoItems = Object.entries(MODELS).map(([id, m]) => ({
    label: `Vídeo · ${m.name}`, sub: m.note, right: `${money(m.price[m.resolutions[0]])}/s`, onclick: video(id, m.resolutions[0]),
  }));
  let items;
  if (link?.type === "video" || link?.type === "any") {
    const src = node(link.from);
    items = [
      { header: "Usar o vídeo" },
      { label: "Ajuste (desfoque, cor…)", sub: "já ligado a este nó: desfoque, brilho, contraste, saturação e cor", onclick: () => { const a = { id: uid(), type: "adjust", x: at.x, y: at.y - 40, data: { label: "Ajuste" } }; Object.assign(a, freeSpot(a.x, a.y, 340, 560)); graph.nodes.push(a); mount(a); graph.edges.push({ from: link.from, to: a.id, port: "in" }); select(a.id); refreshAll(); reveal(a); } },
      { label: "Continuar", sub: "novo vídeo começando no último frame", onclick: () => { const j = shownJob(src); j ? continueFrom(j, previewVideo(src)) : toast("Esse nó ainda não tem vídeo pronto", true); } },
      { label: "Imagem do último frame", sub: "um nó de imagem com o frame", onclick: () => { const j = shownJob(src); j ? frameNode(j, previewVideo(src), at.x, at.y - 40, "Frame do vídeo") : toast("Esse nó ainda não tem vídeo pronto", true); } },
    ];
  } else if (link) {
    items = [...(link.type === "image" ? [{ header: "Editar a imagem" }, { label: "Ajuste (desfoque, cor…)", sub: "já ligado a este nó: desfoque, brilho, contraste, saturação e cor", onclick: () => { const a = { id: uid(), type: "adjust", x: at.x, y: at.y - 40, data: { label: "Ajuste" } }; Object.assign(a, freeSpot(a.x, a.y, 340, 560)); graph.nodes.push(a); mount(a); graph.edges.push({ from: link.from, to: a.id, port: "in" }); select(a.id); refreshAll(); reveal(a); } },] : []), { header: link.type === "text" ? "Ligar o prompt a" : "Usar como first frame de" }, ...videoItems];
  } else {
    items = [
      { header: "Entradas" },
      { label: "Prompt", sub: "texto que descreve o vídeo", onclick: () => place({ id: uid(), type: "prompt", x: at.x, y: at.y - 40, data: { text: "" } }) },
      { label: "Logo", sub: "texto do giro do logo, somado aos vídeos ligados", onclick: () => place({ id: uid(), type: "logo", x: at.x, y: at.y - 40, data: {} }) },
      { label: "Ajuste", sub: "desfoque, brilho, contraste, saturação e cor; solte em cima de um fio para encaixar", onclick: () => place({ id: uid(), type: "adjust", x: at.x, y: at.y - 40, data: { label: "Ajuste" } }) },
      { label: "Compor", sub: "põe o logo sem fundo em cima das ondas, no lugar da Forma (grátis)", onclick: () => place({ id: uid(), type: "compose", x: at.x, y: at.y - 40, data: { label: "Compor" } }) },
      { label: "Composição final", sub: "junta os vídeos prontos em ordem (até 6) num vídeo da parede, 6410 × 1150 (grátis)", onclick: () => place({ id: uid(), type: "final", x: at.x, y: at.y - 40, data: { label: "Composição final" } }) },
      { label: "Travar fundo", sub: "cenário parado (com vento na grama ou água) e só os elementos do vídeo se mexendo (grátis)", onclick: () => place({ id: uid(), type: "travar", x: at.x, y: at.y - 40, data: { label: "Travar fundo", movimento: "nenhum", indice: 0, total: 1 } }) },
      { label: "Logo 3D", sub: "põe o logo 3D girando (gel ou couvert) no lugar da Forma, atrás das fitas (grátis)", onclick: () => place({ id: uid(), type: "logo3d", x: at.x, y: at.y - 40, data: { label: "Logo 3D", preset: "gel" } }) },
      { label: "Remover fundo", sub: "tira o fundo branco liso de um vídeo e guarda com transparência (grátis)", onclick: () => place({ id: uid(), type: "removebg", x: at.x, y: at.y - 40, data: { label: "Remover fundo" } }) },
      { label: "Juntar", sub: "emenda até 6 vídeos num só, na ordem (grátis)", onclick: () => place({ id: uid(), type: "join", x: at.x, y: at.y - 40, data: { label: "Juntar" } }) },
      { label: "Grupo", sub: "moldura com nome e cor, atrás dos nós; arraste pela barra para levar junto o que está dentro", onclick: () => { const g = { id: uid(), type: "group", x: at.x, y: at.y - 40, data: { label: "Grupo", w: 900, h: 560, color: GROUP_COLORS[0] } }; graph.nodes.push(g); mount(g); select(g.id); refreshAll(); save(); } },
      { label: "Nota", sub: "lembrete em texto, sem fios", onclick: () => place({ id: uid(), type: "note", x: at.x, y: at.y - 40, data: { label: "Nota", text: "" } }) },
      { label: "Vídeo pronto", sub: "um vídeo do computador, para juntar, ajustar ou compor (grátis)", onclick: () => place({ id: uid(), type: "clip", x: at.x, y: at.y - 40, data: { label: "Vídeo pronto" } }) },
      { label: "Imagem", sub: "first frame, last frame ou referência", onclick: () => place({ id: uid(), type: "image", x: at.x, y: at.y - 40, data: { label: "Imagem" } }) },
      { header: "Gerar vídeo" },
      ...videoItems,
    ];
  }
  menu(clientX, clientY, items, { search: true, width: 320 });
}

// Vídeo mostrado agora na prévia de um nó de vídeo (só se estiver pronto).
function shownJob(n) {
  const j = n && jobsOf(n)[n.data.view || 0];
  return j?.status === "done" ? j : null;
}
const previewVideo = (n) => els.get(n.id)?.root.querySelector(".preview video") || null;

async function frameInto(fromId, target) {
  const src = node(fromId);
  const j = shownJob(src);
  if (!j) return toast("Esse nó ainda não tem vídeo pronto", true);
  const to = target.closest(".node").dataset.id;
  const t = node(to);
  const port = target.dataset.port;
  // Sempre o último frame (sem o vídeo, grabFrame pega o fim), mesmo se a prévia estiver pausada no meio.
  const img = await frameNode(j, null, t.x - 340, t.y + (port === "last" ? 260 : 0), port === "last" ? "Last frame (último frame do vídeo)" : "First frame (último frame do vídeo)");
  graph.edges = graph.edges.filter((x) => !(x.to === to && x.port === port));
  graph.edges.push({ from: img.id, to, port });
  refreshAll();
}

canvas.addEventListener("dblclick", (e) => {
  if (e.target !== canvas && e.target !== world && e.target !== wires) return;
  nodePicker(e.clientX, e.clientY);
});
$("#add").addEventListener("click", (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  nodePicker(r.left, r.bottom + 6, null, { center: true });
});

// ---------- Atalhos: apagar, selecionar tudo, copiar, colar, duplicar ----------

const CLIP_MARK = "estudio-nos:"; // formato antigo, ainda aceito ao colar
const CLIP_TYPE = "application/x-estudio-nos";
let clip = null; // cópia interna, caso a área de transferência do sistema esteja bloqueada
let clipText = ""; // o texto que foi junto com essa cópia

// Texto do prompt de um nó: o do nó de Prompt, ou o que um nó de vídeo usa.
const promptTextOf = (n) => (n.type === "prompt" ? n.data.text : n.type === "generator" ? inputsOf(n).prompt : "")?.trim() || "";
const selectionText = () => [...new Set([...sel].map(node).filter(Boolean).map(promptTextOf).filter(Boolean))].join("\n\n");

async function copyText(text) {
  if (!text) return toast("Não há texto de prompt para copiar", true);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast("Prompt copiado como texto");
}

// Os nós selecionados, com posições relativas e os fios entre eles (e os que chegam de fora).
function snapshot() {
  const ids = new Set(sel);
  const nodes = graph.nodes.filter((n) => ids.has(n.id));
  if (!nodes.length) return null;
  const x0 = Math.min(...nodes.map((n) => n.x)), y0 = Math.min(...nodes.map((n) => n.y));
  return {
    nodes: nodes.map((n) => ({ ...structuredClone(n), x: n.x - x0, y: n.y - y0 })),
    inner: graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
    outer: graph.edges.filter((e) => !ids.has(e.from) && ids.has(e.to)),
  };
}

// Cola num ponto do quadro, com ids novos. keepInputs mantém os fios que vinham de nós fora da cópia.
function pasteNodes(data, at, keepInputs = false) {
  const map = new Map();
  const fresh = data.nodes.map((n) => {
    const id = uid();
    map.set(n.id, id);
    const copy = { ...structuredClone(n), id, x: at.x + n.x, y: at.y + n.y };
    if (copy.type === "generator") copy.data.view = 0;
    return copy;
  });
  graph.nodes.push(...fresh);
  for (const e of data.inner) graph.edges.push({ ...e, from: map.get(e.from), to: map.get(e.to) });
  if (keepInputs) {
    for (const e of data.outer) if (node(e.from)) graph.edges.push({ ...e, to: map.get(e.to) });
  }
  fresh.forEach(mount);
  sel.clear();
  for (const n of fresh) sel.add(n.id);
  selected = fresh.at(-1)?.id || null;
  paintSelection();
  refreshAll();
  fit(fresh);
  return fresh;
}

// Onde colar: no mouse, se ele estiver no quadro; senão, um pouco ao lado do original.
function pastePoint(data) {
  if (pointer) return toWorld(pointer.x, pointer.y);
  const c = viewCenter();
  return { x: c.x - 100, y: c.y - 100 };
}

function removeSelected() {
  for (const id of [...sel]) removeNode(id);
  select(null);
}

addEventListener("keydown", (e) => {
  if (typing(e)) return;
  const mod = e.ctrlKey || e.metaKey;
  if ((e.key === "Delete" || e.key === "Backspace") && sel.size) {
    e.preventDefault();
    removeSelected();
  } else if (mod && e.key.toLowerCase() === "a") {
    e.preventDefault();
    sel.clear();
    for (const n of graph.nodes) sel.add(n.id);
    paintSelection();
  } else if (mod && e.key.toLowerCase() === "d" && sel.size) {
    // Duplicar: cópia ao lado, mantendo os fios de entrada.
    e.preventDefault();
    const data = snapshot();
    const ids = [...sel];
    const x0 = Math.min(...ids.map((id) => node(id).x)), y0 = Math.min(...ids.map((id) => node(id).y));
    pasteNodes(data, { x: x0 + 60, y: y0 + 60 }, true);
  } else if (mod && e.key.toLowerCase() === "c" && sel.size && !getSelection().toString()) {
    clip = snapshot();
    clipText = selectionText();
    toast(clipText ? "Prompt copiado como texto (Ctrl+V aqui no quadro cola os nós)" : sel.size > 1 ? `${sel.size} nós copiados` : "Nó copiado");
  } else if (mod && e.key.toLowerCase() === "v") {
    // Se o navegador não mandar o evento de colar (área de transferência bloqueada), cola a cópia interna.
    clearTimeout(pendingPaste);
    pendingPaste = setTimeout(() => clip && pasteNodes(clip, pastePoint(clip), e.shiftKey), 120);
  } else if (e.key === "Escape" && sel.size) {
    select(null);
  }
});
let pendingPaste = null;

// Na área de transferência vai só o texto dos prompts (para colar em qualquer lugar);
// os nós vão num tipo próprio, que só o estúdio lê.
function putOnClipboard(e) {
  clip = snapshot();
  clipText = selectionText();
  e.clipboardData.setData(CLIP_TYPE, JSON.stringify(clip));
  if (clipText) e.clipboardData.setData("text/plain", clipText);
  e.preventDefault();
}

addEventListener("copy", (e) => {
  if (typing(e) || !sel.size || getSelection().toString()) return;
  putOnClipboard(e);
});

addEventListener("cut", (e) => {
  if (typing(e) || !sel.size) return;
  putOnClipboard(e);
  removeSelected();
});

function refreshGenerators() {
  for (const n of graph.nodes) if (n.type === "generator") els.get(n.id)?.update();
}

function refreshAll() {
  for (const n of graph.nodes) els.get(n.id)?.update?.();
  drawWires();
  save();
}

// ---------- Servidor ----------

async function loadJobs() {
  try {
    jobs = await (await fetch("/api/jobs")).json();
    jobsLoaded = true;
  } catch {
    return;
  }
  for (const n of graph.nodes) if (n.type === "result" || n.type === "generator" || n.type === "join" || n.type === "final" || n.type === "compose" || n.type === "adjust") els.get(n.id)?.update();
  renderAssets();
  renderSpent();
  drawWires();
}

// ---------- Arquivos: todos os vídeos gerados ----------

const assets = $("#assets");
let assetsSig = "";
$("#assets-toggle").addEventListener("click", () => {
  assets.hidden = !assets.hidden;
  $("#assets-toggle").classList.toggle("on", !assets.hidden);
  assetsSig = "";
  renderAssets();
});

function renderAssets() {
  if (assets.hidden) return;
  const done = jobs.filter((j) => j.status === "done");
  const sig = done.map((j) => j.id + (j.stitchedAt || "")).join();
  if (sig === assetsSig) return;
  assetsSig = sig;
  $("#assets-list").replaceChildren(...(done.length ? done.map((j) => {
    const v = h("video", { src: `/videos/${encodeURIComponent(j.file)}?v=${j.stitchedAt || 0}#t=0.5`, muted: true, loop: true, playsinline: true, preload: "metadata" });
    v.addEventListener("mouseenter", () => v.play().catch(() => {}));
    v.addEventListener("mouseleave", () => v.pause());
    return h("div", {
      class: "asset", draggable: true,
      ondragstart: (e) => e.dataTransfer.setData("text/x-job", j.id),
      onclick: () => viewer({ video: j.file }),
      title: j.prompt,
    }, v, h("div", { class: "asset-info" },
      h("b", {}, `${MODELS[j.model]?.name || j.model} · ${j.resolution}`),
      h("span", { class: "meta" }, new Date(j.created).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }))));
  }) : [h("div", { class: "meta" }, "Nenhum vídeo gerado ainda.")]));
}

// Vídeo arrastado dos Arquivos: numa entrada de imagem, liga o último frame; no fundo, cria um nó de imagem.
canvas.addEventListener("drop", async (e) => {
  const id = e.dataTransfer.getData("text/x-job");
  const j = id && jobs.find((x) => x.id === id);
  if (!j) return;
  e.preventDefault();
  const target = e.target.closest?.('.port.in[data-type="image"]');
  const at = toWorld(e.clientX, e.clientY);
  if (target) {
    const to = target.closest(".node").dataset.id;
    const t = node(to);
    const img = await frameNode(j, null, t.x - 340, t.y + (target.dataset.port === "last" ? 260 : 0), "Frame do vídeo");
    graph.edges = graph.edges.filter((x) => !(x.to === to && x.port === target.dataset.port));
    graph.edges.push({ from: img.id, to, port: target.dataset.port });
    refreshAll();
  } else {
    frameNode(j, null, at.x, at.y - 40, "Frame do vídeo");
  }
});

// Quanto as gerações de hoje cobraram (segundos cobrados × preço), e quanto está gerando agora.
function renderSpent() {
  const today = new Date().toDateString();
  let spent = 0, running = 0;
  for (const j of jobs) {
    if (new Date(j.created).toDateString() !== today) continue;
    const price = MODELS[j.model]?.price[j.resolution] || 0;
    spent += (j.billed || 0) * price;
    if (j.status === "pending") {
      const waiting = j.parts ? j.parts.filter((p) => p.status === "pending").length : 1;
      running += price * j.duration * waiting;
    }
  }
  $("#spent").textContent = `Hoje ${money(spent)}${running ? ` · gerando ≈ ${money(running)}` : ""}`;
}

// O estúdio mudou depois que esta página abriu: avisa e oferece recarregar (o quadro fica salvo).
let pageBuild = null;
function checkBuild(build) {
  if (!build) return;
  if (pageBuild === null) pageBuild = build;
  else if (build !== pageBuild) staleBanner();
}
function staleBanner() {
  if ($(".stale")) return;
  document.body.append(h("div", { class: "stale" },
    h("span", {}, "O estúdio foi atualizado. Recarregue para usar a versão nova."),
    h("button", { onclick: () => { try { localStorage.setItem(STORE, JSON.stringify(graph)); } catch {} location.reload(); } }, "Recarregar")));
}

async function loadBalance() {
  const chip = $("#balance");
  try {
    const s = await (await fetch("/api/status")).json();
    checkBuild(s.build);
    chip.classList.toggle("bad", !s.key || Boolean(s.error));
    chip.textContent = !s.key ? "Sem chave" : s.error ? "Saldo indisponível" : `Saldo ${money(s.available)}${s.held > 0 ? ` · ${money(s.held)} reservado` : ""}`;
    chip.title = s.error || "";
  } catch {
    chip.textContent = "Servidor desligado";
    chip.classList.add("bad");
  }
}

let wasPending = false;
setInterval(async () => {
  const pending = jobs.some((j) => j.status === "pending" || j.status === "stitching");
  if (pending || wasPending) await loadJobs();
  if (wasPending && !pending) loadBalance();
  wasPending = pending;
}, 4000);
setInterval(loadBalance, 60000);

// ---------- Caixa de recados: montagens deixadas em inbox.json ----------

// O quadro fica salvo só neste navegador. Para montar nós por fora (por exemplo, a pedido no chat),
// basta deixar um pedido em inbox.json; cada pedido é aplicado uma vez e fica marcado aqui.
const INBOX_DONE = "estudio-inbox-feito";

// "build": monta um conjunto de nós (imagens, textos, vídeos) e os fios, à direita do que já existe.
// As imagens já estão em uploads/; as panorâmicas se dividem sozinhas quando a imagem carrega.
function buildCommand(c) {
  // c.unless: se já existe um nó com esse título, não monta de novo; só leva a vista até ele.
  const had = c.unless && graph.nodes.find((n) => (n.data.title || n.data.label) === c.unless);
  if (had) { fit([had]); select(had.id); toast(c.message || "Os nós já estavam no quadro."); return true; }
  const boxes = graph.nodes.map((n) => ({ n, b: nodeBox(n) }));
  const x0 = boxes.length ? Math.max(...boxes.map(({ n, b }) => n.x + b.w)) + 200 : 0;
  const y0 = boxes.length ? Math.min(...boxes.map(({ n }) => n.y)) : 0;
  const ids = {};
  const made = [];
  for (const s of c.nodes) {
    const data = s.type === "generator" ? { ...genDefaults(), ...s.data }
      : s.type === "image" ? (s.data.file ? { label: s.data.label, file: s.data.file, url: `/uploads/${s.data.file}` } : { label: s.data.label })
      : { ...s.data };
    const n = { id: uid(), type: s.type, x: x0 + s.x, y: y0 + s.y, data };
    ids[s.key] = n.id;
    graph.nodes.push(n);
    mount(n);
    made.push(n);
  }
  for (const [from, to, port] of c.edges) if (ids[from] && ids[to]) graph.edges.push({ from: ids[from], to: ids[to], port });
  refreshAll();
  fit(made);
  toast(c.message || "Montei os nós pedidos.");
  return true;
}

// "board": remonta um conjunto de vídeos em linhas organizadas. Cada vídeo vira uma coluna:
// a nota em cima, as imagens (first e last) à esquerda e o nó de vídeo à direita.
// Antes, tira os nós antigos com esses títulos (e as imagens que só serviam a eles), desde que
// nenhum deles já tenha vídeo gerado.
function boardCommand(c) {
  const titles = new Set(c.replace || []);
  const old = graph.nodes.filter((n) => n.type === "generator" && titles.has(n.data.title) && !jobsOf(n).length);
  const oldIds = new Set(old.map((n) => n.id));
  const feeds = graph.nodes.filter((n) => {
    const out = graph.edges.filter((e) => e.from === n.id);
    return n.type === "image" && out.length && out.every((e) => oldIds.has(e.to));
  });
  for (const n of [...old, ...feeds]) removeNode(n.id);

  const boxes = graph.nodes.map((n) => ({ n, b: nodeBox(n) }));
  const x0 = boxes.length ? Math.max(...boxes.map(({ n, b }) => n.x + b.w)) + 240 : 0;
  let y = boxes.length ? Math.min(...boxes.map(({ n }) => n.y)) : 0;
  const made = [];
  const add = (type, x, yy, data) => {
    const n = { id: uid(), type, x, y: yy, data };
    graph.nodes.push(n);
    mount(n);
    made.push(n);
    return n;
  };
  const image = (x, yy, label, file) => add("image", x, yy, file ? { label, file, url: `/uploads/${file}` } : { label });
  const COL = 300 + 40 + 380; // imagens + espaço + vídeo
  for (const row of c.rows) {
    if (row.title) {
      const t = add("note", x0, y, { label: row.title, text: row.text || "", w: Math.max(1, row.cells.length) * (COL + 120) - 120 });
      y += nodeBox(t).h + 40;
    }
    let x = x0, rowH = 0;
    const gens = [];
    // row.fundo: o fundo limpo do ato (uma imagem para a linha toda), à esquerda; os "Travar fundo" ligam nele.
    const fundoNode = row.fundo ? image(x0 - 380, y, row.fundo.label || "Fundo limpo", row.fundo.file) : null;
    row.cells.forEach((cell, ci) => { cell._i = ci; });
    for (const cell of row.cells) {
      const note = add("note", x, y, { label: cell.title, text: cell.note, w: COL });
      const top = y + nodeBox(note).h + 24;
      const same = !cell.last || cell.last === cell.first;
      const first = image(x, top, same && !cell.noLast ? `First e last · ${cell.firstLabel}` : `First · ${cell.firstLabel}`, cell.first);
      const last = same ? first : image(x, top + nodeBox(first).h + 24, `Last · ${cell.lastLabel}`, cell.last);
      const gen = add("generator", x + 340, top, { ...genDefaults(), ...cell.video, title: cell.title });
      graph.edges.push({ from: first.id, to: gen.id, port: "first" });
      if (!cell.noLast) graph.edges.push({ from: last.id, to: gen.id, port: "last" }); // noLast: só o first frame
      gens.push(gen);
      // cell.adjust: um Ajuste (ex.: lento) embaixo do vídeo, já ligado nele.
      let adjBottom = 0;
      if (cell.adjust) {
        const adj = add("adjust", gen.x, gen.y + nodeBox(gen).h + 24, { ...ADJUST_DEFAULT, ...cell.adjust, label: `${cell.title} · lento`, dirty: true });
        graph.edges.push({ from: gen.id, to: adj.id, port: "in" });
        adjBottom = adj.y + nodeBox(adj).h;
      }
      // cell.travar: um "Travar fundo" embaixo, ligado no vídeo, nas paredes de começo/fim e no fundo limpo;
      // o Juntar passa a receber o vídeo travado.
      if (cell.travar) {
        const ty = adjBottom ? adjBottom + 24 : gen.y + nodeBox(gen).h + 24;
        const tv = add("travar", gen.x, ty, { label: `${cell.title} · travado`, movimento: cell.travar.movimento || "nenhum", indice: cell._i, total: row.cells.length });
        graph.edges.push({ from: gen.id, to: tv.id, port: "in" }, { from: first.id, to: tv.id, port: "ini" }, { from: last.id, to: tv.id, port: "fim" });
        if (fundoNode) graph.edges.push({ from: fundoNode.id, to: tv.id, port: "fundo" });
        gens[gens.length - 1] = tv;
        adjBottom = tv.y + nodeBox(tv).h;
      }
      const bottom = Math.max(last.y + nodeBox(last).h, gen.y + nodeBox(gen).h, adjBottom);
      rowH = Math.max(rowH, bottom - y);
      x += COL + 120;
    }
    // Linha com "join": um nó Juntar no fim, com os vídeos da linha ligados na ordem.
    if (row.join) {
      const note = add("note", x, y, { label: row.join.title, text: row.join.note, w: 380 });
      const j = add("join", x, y + nodeBox(note).h + 24, { label: row.join.title });
      gens.slice(0, JOIN_PORTS.length).forEach((g, i) => graph.edges.push({ from: g.id, to: j.id, port: JOIN_PORTS[i] }));
      // "logo3d" na linha: um nó Logo 3D logo depois do Juntar, já ligado nele e com o preset escolhido.
      if (row.logo3d) {
        const lx = x + 380 + 120;
        const ln = add("note", lx, y, { label: row.logo3d.title, text: row.logo3d.note || "", w: 380 });
        const lg = add("logo3d", lx, y + nodeBox(ln).h + 24, { label: row.logo3d.title, preset: row.logo3d.preset || "gel" });
        graph.edges.push({ from: j.id, to: lg.id, port: "in" });
      }
    }
    y += rowH + 160;
  }
  refreshAll();
  fit(made);
  toast(c.message || "Reorganizei os nós.");
  return true;
}

// "patch": troca campos (ex.: o prompt) dos nós de vídeo com aqueles títulos e redesenha cada um.
function patchCommand(c) {
  const hit = graph.nodes.filter((n) => (n.type === "generator" && c.patch[n.data.title]) || (n.type === "note" && c.notes?.[n.data.label]));
  for (const n of hit) {
    Object.assign(n.data, n.type === "note" ? { text: c.notes[n.data.label] } : c.patch[n.data.title]);
    els.get(n.id)?.root.remove();
    els.delete(n.id);
    mount(n);
  }
  if (!hit.length) return false;
  refreshAll();
  save();
  toast(c.message || "Atualizei os nós.");
  return true;
}

// "wire-gens": liga geradores às imagens que já estão no quadro (pelo id do nó, sem mexer nelas):
// embaixo de cada par first/last, um prompt, o gerador e um Ajuste; no fim, um Juntar com os Ajustes em ordem.
function wireGensCommand(c) {
  if (c.cells.some((k) => !graph.nodes.find((n) => n.id === k.first) || (k.last && !graph.nodes.find((n) => n.id === k.last)))) return false;
  if (graph.nodes.some((n) => n.type === "join" && n.data.label === c.join.title)) return true;
  const imgs = c.cells.flatMap((k) => [k.first, k.last].filter(Boolean)).map((id) => graph.nodes.find((n) => n.id === id));
  let y0 = Math.max(...imgs.map((n) => n.y + nodeBox(n).h)) + 120;
  const made = [], adjusts = [];
  const add = (type, x, y, data) => { const n = { id: uid(), type, x, y, data }; graph.nodes.push(n); mount(n); made.push(n); return n; };
  for (const k of c.cells) {
    const first = graph.nodes.find((n) => n.id === k.first);
    const x = first.x;
    let y = y0;
    const note = add("note", x, y, { label: k.title, text: k.note, w: 380 });
    y += nodeBox(note).h + 24;
    const p = add("prompt", x, y, { text: k.prompt });
    y += nodeBox(p).h + 24;
    const gen = add("generator", x, y, { ...genDefaults(c.model || "seedance-2.0-mini", c.resolution || "480p"), ratio: "adaptive", lockBlack: true, partPrompts: ["", "", ""], ...(c.video || {}), title: k.title });
    graph.edges.push({ from: first.id, to: gen.id, port: "first" });
    if (k.last) graph.edges.push({ from: k.last, to: gen.id, port: "last" });
    graph.edges.push({ from: p.id, to: gen.id, port: "prompt" });
    y += nodeBox(gen).h + 24;
    const adj = add("adjust", x, y, { ...ADJUST_DEFAULT, ...(c.adjust || {}), label: `${k.title} · lento`, dirty: true });
    graph.edges.push({ from: gen.id, to: adj.id, port: "in" });
    adjusts.push(adj);
  }
  const lastAdj = adjusts.at(-1);
  const jx = lastAdj.x + 520, jy = y0;
  const jn = add("note", jx, jy, { label: c.join.title, text: c.join.note, w: 380 });
  const j = add("join", jx, jy + nodeBox(jn).h + 24, { label: c.join.title, fade: c.join.fade ?? 0.6, loop: c.join.loop ?? true });
  adjusts.slice(0, JOIN_PORTS.length).forEach((a, i) => graph.edges.push({ from: a.id, to: j.id, port: JOIN_PORTS[i] }));
  refreshAll();
  save();
  fit(made);
  toast(c.message || "Liguei os geradores às suas imagens.");
  return true;
}

// "prune-empty": apaga os nós que nunca geraram nada (Vídeo sem vídeo pronto; Ajuste, Juntar, Compor e
// Composição final sem arquivo) e o que só servia a eles (imagens, textos, logos, saídas e notas com o mesmo
// título). Antes, guarda uma cópia do quadro inteiro em localStorage, para dar para voltar.
function pruneEmptyCommand(c) {
  if (!jobsLoaded) return false;
  const gone = new Set();
  const keep = (n) => (c.keep || []).some((k) => (n.data.title || n.data.label || "").startsWith(k));
  for (const n of graph.nodes) {
    if (keep(n)) continue;
    if (n.type === "generator" && !jobsOf(n).some((j) => j.status !== "failed")) gone.add(n.id);
    if (["adjust", "join", "compose", "final"].includes(n.type) && !n.data.file && !n.data.busy) gone.add(n.id);
  }
  // O que só alimentava (ou só recebia de) nós apagados vai junto.
  for (let grew = true; grew;) {
    grew = false;
    for (const n of graph.nodes) {
      if (gone.has(n.id) || !["image", "prompt", "logo", "result"].includes(n.type)) continue;
      const touch = graph.edges.filter((e) => e.from === n.id || e.to === n.id);
      if (touch.length && touch.every((e) => gone.has(e.from === n.id ? e.to : e.from))) { gone.add(n.id); grew = true; }
    }
  }
  const names = new Set(graph.nodes.filter((n) => gone.has(n.id)).map((n) => n.data.title || n.data.label).filter(Boolean));
  for (const n of graph.nodes) if (n.type === "note" && names.has(n.data.label)) gone.add(n.id);
  if (!gone.size) return true;
  try { localStorage.setItem(`estudio-grafo-copia-${c.id}`, JSON.stringify(graph)); } catch {}
  for (const id of gone) removeNode(id);
  save();
  toast(`${c.message || "Apaguei os nós que não geraram nada."} (${gone.size} nós)`);
  return true;
}

// "remove-titles": apaga os nós de Vídeo cujo título bate com c.match (regex), as notas cujo nome bate com
// c.notes (regex) ou com o título de um nó apagado, e o que só servia a eles (imagens, textos, Juntar,
// Composição final...). Nada que comece com c.keep é tocado. Antes, guarda uma cópia do quadro.
// "connect": liga nós pelo título/nome (c.edges: [de, para, porta]) e troca campos (c.data: {nome: {...}}).
function connectCommand(c) {
  // nome igual ao de uma nota (ex.: a nota em cima do Juntar): fica o nó que não é nota
  const by = (name) => graph.nodes.find((n) => n.type !== "note" && (n.data.title || n.data.label) === name) || graph.nodes.find((n) => (n.data.title || n.data.label) === name);
  if (c.edges.some(([a, b]) => !by(a) || !by(b))) return false;
  for (const [name, fields] of Object.entries(c.data || {})) {
    const n = by(name); if (!n) continue;
    Object.assign(n.data, fields); els.get(n.id)?.root.remove(); els.delete(n.id); mount(n);
  }
  for (const [a, b, port] of c.edges) {
    const from = by(a).id, to = by(b).id;
    graph.edges = graph.edges.filter((e) => !(e.to === to && e.port === port));
    graph.edges.push({ from, to, port });
  }
  refreshAll(); save(); fit([by(c.edges[0][1])]);
  toast(c.message || "Liguei os nós.");
  return true;
}

// "refazer-faixas": refaz a faixa do modo vídeo único de todas as imagens panorâmicas do quadro com a borda
// espelhada (bandImage). As antigas tinham faixas bem desfocadas, e o Seedance 2.5 lia o quadro como foto com
// pouco foco e borrava a parede junto.
function refazerFaixasCommand(c) {
  const alvo = graph.nodes.filter((n) => n.type === "image" && n.data.file && n.data.pano?.band);
  (async () => {
    let feitos = 0;
    for (const n of alvo) {
      try {
        const blob = await (await fetch(`/uploads/${n.data.file}`)).blob();
        const bmp = await createImageBitmap(blob);
        const nb = await bandImage(bmp);
        const band = await sendImage(nb.blob);
        n.data.pano = { ...n.data.pano, band: { file: band.file, y: nb.y, h: nb.h } };
        feitos++;
      } catch (e) { console.warn("faixa", n.data.label, e); }
    }
    refreshAll(); save();
    toast(`${c.message || "Refiz as faixas das imagens panorâmicas."} (${feitos} de ${alvo.length})`);
  })();
  return true;
}

// "refazer-faixas-fundo": refaz a faixa das imagens cujo arquivo casa com c.match usando o fundo limpo do ato
// (c.fundo, em uploads) nas margens de cima e de baixo, no lugar da parede espelhada. Sem c.fundo, volta a faixa
// espelhada de sempre.
function refazerFaixasFundoCommand(c) {
  // c.match casa com o arquivo; c.label, com o nome do nó (as imagens das fileiras são cópias com outro arquivo).
  const re = c.match ? new RegExp(c.match) : null, rl = c.label ? new RegExp(c.label) : null;
  const alvo = graph.nodes.filter((n) => n.type === "image" && n.data.pano?.band &&
    ((re && re.test(n.data.file || "")) || (rl && rl.test(n.data.label || ""))));
  (async () => {
    let feitos = 0;
    try {
      const plate = c.fundo ? await createImageBitmap(await (await fetch(`/uploads/${c.fundo}`)).blob()) : null;
      const feitas = new Map(); // o mesmo arquivo em várias fileiras: uma faixa só
      for (const n of alvo) {
        try {
          if (!feitas.has(n.data.file)) {
            const bmp = await createImageBitmap(await (await fetch(`/uploads/${n.data.file}`)).blob());
            const nb = await bandImage(bmp, plate);
            const band = await sendImage(nb.blob);
            feitas.set(n.data.file, { file: band.file, y: nb.y, h: nb.h, ...(c.fundo ? { fundo: c.fundo } : {}) });
          }
          n.data.pano = { ...n.data.pano, band: feitas.get(n.data.file) };
          feitos++;
        } catch (e) { console.warn("faixa", n.data.label, e); }
      }
    } catch (e) { console.warn("fundo", c.fundo, e); }
    refreshAll(); save();
    toast(`${c.message || "Refiz as faixas com o fundo limpo."} (${feitos} de ${alvo.length})`);
  })();
  return true;
}

// "logo-velocidade": todos os nós Logo 3D do quadro com a velocidade padrão (a do Couvert). Vale no próximo
// "Pôr logo"; os vídeos já feitos não mudam.
function logoVelocidadeCommand(c) {
  const alvo = graph.nodes.filter((n) => n.type === "logo3d");
  for (const n of alvo) {
    n.data.aj = { velocidade: LOGO_VEL, inicio: 0, tamanho: 1, dx: 0, dy: 0, ...(n.data.aj || {}), velocidade: LOGO_VEL };
    els.get(n.id)?.root.remove(); els.delete(n.id); mount(n);
  }
  refreshAll(); save();
  toast(`${c.message || "Pus todos os logos na velocidade do Couvert."} (${alvo.length} nós)`);
  return true;
}

// "organizar-atos": arruma o quadro inteiro por ato, na ordem do jantar. Cada grupo (nós ligados por fios, com as
// notas que estão logo acima deles) anda junto, sem mudar o desenho interno. Em cima, uma faixa por ato com as
// versões atuais (c.atuais: começos de nome); embaixo, "ARQUIVO" com o resto, também por ato. Nada é apagado, e
// antes de mexer o quadro é guardado em localStorage ("estudio-grafo-copia-antes-de-organizar").
function organizarAtosCommand(c) {
  if (c.quadros?.secoes && !jobsLoaded) return false; // precisa dos vídeos já feitos para separar; tenta de novo depois
  try { localStorage.setItem("estudio-grafo-copia-antes-de-organizar", JSON.stringify(graph)); } catch (e) { console.warn(e); }
  const ns = graph.nodes.filter((n) => n.type !== "group" && !n.data.faixa);
  for (const n of graph.nodes.filter((n) => n.type === "group" && n.data.quadroAto)) removeNode(n.id);
  const box = new Map(ns.map((n) => [n.id, nodeBox(n)]));
  const pai = new Map(ns.map((n) => [n.id, n.id]));
  const raiz = (id) => { while (pai.get(id) !== id) { pai.set(id, pai.get(pai.get(id))); id = pai.get(id); } return id; };
  const une = (a, b) => { if (pai.has(a) && pai.has(b)) pai.set(raiz(a), raiz(b)); };
  for (const e of graph.edges) une(e.from, e.to);
  // nota solta: vai com o nó logo abaixo dela (mesma coluna, até 700 px)
  const ligados = new Set(graph.edges.flatMap((e) => [e.from, e.to]));
  for (const nt of ns.filter((n) => n.type === "note" && !ligados.has(n.id))) {
    const h = box.get(nt.id).h;
    let best = null, bd = 1e9;
    for (const m of ns) {
      if (m === nt) continue;
      const dy = m.y - (nt.y + h * 0.5);
      if (dy <= 0 || dy > 700 || m.x < nt.x - 30 || m.x > nt.x + Math.max(400, box.get(nt.id).w * 0.25)) continue;
      if (dy < bd) { bd = dy; best = m; }
    }
    if (best) une(nt.id, best.id);
  }
  const grupos = new Map();
  for (const n of ns) { const r = raiz(n.id); if (!grupos.has(r)) grupos.set(r, []); grupos.get(r).push(n); }
  const nome = (n) => `${n.data.title || ""} ${n.data.label || ""}`.toLowerCase();
  const ATOS = c.atos; // [{ key, titulo, re }]
  const atuais = c.atuais.map((a) => a.toLowerCase());
  const lista = [...grupos.values()].map((g) => {
    const txt = g.map(nome).join(" | ");
    let ato = "outros", melhor = 0;
    for (const a of ATOS) { const k = (txt.match(new RegExp(a.re, "gi")) || []).length; if (k > melhor) { melhor = k; ato = a.key; } }
    const atual = g.some((n) => [n.data.title, n.data.label].some((t) => t && atuais.some((a) => t.toLowerCase().startsWith(a))));
    const x = Math.min(...g.map((n) => n.x)), y = Math.min(...g.map((n) => n.y));
    const w = Math.max(...g.map((n) => n.x + box.get(n.id).w)) - x, hh = Math.max(...g.map((n) => n.y + box.get(n.id).h)) - y;
    return { g, ato, atual, x, y, w, h: hh };
  });
  const move = (n, x, y) => { n.x = x; n.y = y; const r = els.get(n.id)?.root; if (r) { r.style.left = x + "px"; r.style.top = y + "px"; } };
  const titulo = (x, y, label, text, w) => {
    const n = { id: uid(), type: "note", x, y, data: { label, text, w } };
    graph.nodes.push(n); mount(n); return nodeBox(n).h;
  };
  // tira os títulos de faixa de uma organização anterior
  for (const n of graph.nodes.filter((n) => n.type === "note" && n.data.faixa)) removeNode(n.id);
  const GAP = 260, LARG = c.largura || 26000;
  let Y = 0;
  // c.quadros: em vez da nota de título, um quadro colorido atrás da faixa, com o nome enorme em cima dos nós.
  const Q = c.quadros, PAD = 300;
  const faixa = (itens, label, text, cor) => {
    if (!itens.length) return;
    itens.sort((a, b) => a.y - b.y || a.x - b.x);
    const y0 = Y;
    if (Q) Y += Q.big * 1.5;
    else {
      const th = titulo(0, Y, label, text, 1600);
      graph.nodes[graph.nodes.length - 1].data.faixa = true;
      Y += th + 60;
    }
    let x = 0, alt = 0, maxX = 0;
    for (const it of itens) {
      if (x > 0 && x + it.w > LARG) { Y += alt + GAP; x = 0; alt = 0; }
      for (const n of it.g) move(n, n.x - it.x + x, n.y - it.y + Y);
      x += it.w + GAP; alt = Math.max(alt, it.h); maxX = Math.max(maxX, x - GAP);
    }
    Y += alt;
    if (Q) {
      const gr = { id: uid(), type: "group", x: -PAD, y: y0 - PAD, data: { label, color: cor || "#9ca3af", big: Q.big, w: maxX + 2 * PAD, h: Y - y0 + 2 * PAD, quadroAto: true } };
      graph.nodes.push(gr); mount(gr);
      Y += 2 * PAD + 400;
    } else Y += 700;
  };
  if (Q?.secoes) {
    // Cada ato num quadro grande, e dentro dele três quadros menores, um embaixo do outro: o que ainda vai ser gerado
    // (versão nova), o que já foi gerado e as versões antigas. Um grupo "já gerado" tem algum vídeo pronto.
    const feito = (n) => n.type === "generator" ? jobsOf(n).some((j) => j.status === "done" && j.file)
      : !["image", "note", "prompt", "logo", "group"].includes(n.type) && !!n.data.file;
    for (const it of lista) {
      it.gerado = it.g.some(feito);
      // c.quadros.mesa: o que é das mesas (projeção nos pratos) fica separado das paredes
      it.mesa = !!Q.mesa && it.g.some((n) => new RegExp(Q.mesa, "i").test(nome(n)));
    }
    const SB = Q.sub || 260, SP = 160;
    const quadro = (x, y, w, hh, label, cor, big) => {
      const gr = { id: uid(), type: "group", x, y, data: { label, color: cor, big, w, h: hh, quadroAto: true } };
      graph.nodes.push(gr); mount(gr);
    };
    const secao = (itens, label, cor, x0, y) => { // devolve [altura, largura]
      itens.sort((a, b) => a.y - b.y || a.x - b.x);
      let yy = y + SB * 1.5, x = 0, alt = 0, maxX = 0;
      for (const it of itens) {
        if (x > 0 && x + it.w > LARG) { yy += alt + GAP; x = 0; alt = 0; }
        for (const n of it.g) move(n, n.x - it.x + x0 + x, n.y - it.y + yy);
        x += it.w + GAP; alt = Math.max(alt, it.h); maxX = Math.max(maxX, x - GAP);
      }
      const hh = yy + alt - y + SP;
      quadro(x0 - SP, y - SP, maxX + 2 * SP, hh + SP, label, cor, SB);
      return [hh + SP, maxX + 2 * SP];
    };
    for (const a of [...ATOS, { key: "outros", titulo: "OUTROS", cor: Q.arquivo }]) {
      const meus = lista.filter((i) => i.ato === a.key);
      if (!meus.length) continue;
      const y0 = Y;
      Y += Q.big * 1.5;
      let larg = 0;
      // Paredes e mesas, cada uma num quadro com as suas três partes. Nas mesas não há "versão atual" por nome:
      // o que já tem vídeo fica em "já gerado", o resto em "para gerar".
      const blocos = [
        ["PAREDES", meus.filter((i) => !i.mesa), "#e5e7eb", (i) => i.atual],
        ["MESAS", meus.filter((i) => i.mesa), "#2dd4bf", () => true],
      ].filter((b) => b[1].length);
      for (const [nomeB, itensB, corB, atualB] of blocos) {
        const partes = [
          [`${nomeB} · NOVA VERSÃO · PARA GERAR`, itensB.filter((i) => atualB(i) && !i.gerado), "#c6f432"],
          [`${nomeB} · JÁ GERADO`, itensB.filter((i) => atualB(i) && i.gerado), "#5aa9ff"],
          [`${nomeB} · VERSÕES ANTIGAS`, itensB.filter((i) => !atualB(i)), Q.arquivo],
        ].filter((p) => p[1].length);
        const yb = Y;
        Y += Q.bloco * 1.5;
        let lb = 0;
        for (const [label, itens, cor] of partes) {
          const [hh, w] = secao(itens, label, cor, PAD + 2 * SP, Y + SP);
          Y += hh + SP * 2; lb = Math.max(lb, w);
        }
        quadro(PAD, yb, lb + 2 * SP, Y - yb, nomeB, corB, Q.bloco);
        Y += SP * 2; larg = Math.max(larg, lb + 2 * SP);
      }
      quadro(-PAD, y0 - PAD, larg + 2 * PAD + 2 * SP, Y - y0 + PAD, a.titulo, a.cor || Q.arquivo, Q.big);
      Y += 2 * PAD + 600;
    }
    refreshAll(); save();
    fit(graph.nodes.filter((n) => n.data.quadroAto));
    toast(`${c.message || "Organizei o quadro por ato."} (${lista.filter((i) => i.atual && !i.gerado).length} para gerar, ${lista.filter((i) => i.atual && i.gerado).length} já gerados, ${lista.filter((i) => !i.atual).length} antigos)`);
    return true;
  }
  for (const a of ATOS) faixa(lista.filter((i) => i.ato === a.key && i.atual), a.titulo, "Versões atuais deste ato: a fileira 480p, a fileira 4K e o final.", a.cor);
  const arqY = Y;
  if (!Q) {
    titulo(0, Y, "ARQUIVO · VERSÕES ANTIGAS", "Tudo o que não é mais usado, separado por ato. Nada foi apagado.", 1600);
    graph.nodes[graph.nodes.length - 1].data.faixa = true;
    Y += 400;
  } else Y += 1200;
  for (const a of [...ATOS, { key: "outros", titulo: "Outros" }]) faixa(lista.filter((i) => i.ato === a.key && !i.atual), `ARQUIVO · ${a.titulo}`, "", Q?.arquivo);
  refreshAll(); save();
  fit(graph.nodes.filter((n) => n.y < arqY));
  toast(`${c.message || "Organizei o quadro por ato."} (${lista.filter((i) => i.atual).length} grupos atuais, ${lista.filter((i) => !i.atual).length} no arquivo)`);
  return true;
}

// "sem-travar": tira os nós Travar fundo que ainda não fizeram nada (sem vídeo), ligando direto o vídeo gerado no
// que vinha depois deles (o Juntar). Os Travar que já têm vídeo ficam, porque há finais feitos com eles.
function semTravarCommand(c) {
  const alvo = graph.nodes.filter((n) => n.type === "travar" && !n.data.file);
  for (const t of alvo) {
    const src = graph.edges.find((e) => e.to === t.id && e.port === "in");
    if (src) for (const e of graph.edges.filter((e) => e.from === t.id)) graph.edges.push({ from: src.from, to: e.to, port: e.port });
    removeNode(t.id);
  }
  refreshAll(); save();
  toast(`${c.message || "Tirei os Travar fundo."} (${alvo.length} nós)`);
  return true;
}

// "lento-e-logo": depois de cada Juntar da lista (pelo nome), um Ajuste lento (c.speed) e o Logo 3D ligado nele:
// Juntar → Ajuste → Logo 3D. Se o Logo 3D já existe, o Ajuste entra no meio; se não existe e há preset, ele é criado.
function lentoELogoCommand(c) {
  let feitos = 0;
  for (const r of c.rows) {
    const j = graph.nodes.find((n) => n.type === "join" && (n.data.label === r.join || n.data.title === r.join));
    if (!j) continue;
    const saidas = graph.edges.filter((e) => e.from === j.id);
    if (saidas.some((e) => node(e.to)?.type === "adjust")) continue; // já tem
    const jb = nodeBox(j);
    const adj = { id: uid(), type: "adjust", x: j.x, y: j.y + jb.h + 40, data: { ...ADJUST_DEFAULT, speed: c.speed, label: `${r.join} · lento`, dirty: true } };
    graph.nodes.push(adj); mount(adj);
    graph.edges.push({ from: j.id, to: adj.id, port: "in" });
    let lg = saidas.map((e) => node(e.to)).find((n) => n?.type === "logo3d");
    if (lg) {
      graph.edges = graph.edges.filter((e) => !(e.from === j.id && e.to === lg.id));
    } else if (r.preset) {
      lg = { id: uid(), type: "logo3d", x: j.x + jb.w + 120, y: j.y, data: { label: r.logo || `${r.join} · logo 3d`, preset: r.preset, aj: { velocidade: LOGO_VEL, inicio: 0, tamanho: 1, dx: 0, dy: 0 } } };
      graph.nodes.push(lg); mount(lg);
    }
    if (lg) graph.edges.push({ from: adj.id, to: lg.id, port: "in" });
    feitos++;
  }
  refreshAll(); save();
  toast(`${c.message || "Pus o Ajuste lento e o Logo 3D depois dos Juntar."} (${feitos})`);
  return true;
}

// "renovar": troca nós de vídeo (pelo título) por nós novos no mesmo lugar, com os mesmos dados, fios e prompt, mas
// sem os vídeos que deram errado. Os vídeos antigos continuam salvos na pasta.
function renovarCommand(c) {
  let feitos = 0;
  for (const t of c.titles) {
    const old = graph.nodes.find((n) => n.type === "generator" && n.data.title === t);
    if (!old) continue;
    const { view, ...data } = old.data;
    const nn = { id: uid(), type: "generator", x: old.x, y: old.y, data: JSON.parse(JSON.stringify(data)) };
    for (const e of graph.edges) { if (e.from === old.id) e.from = nn.id; if (e.to === old.id) e.to = nn.id; }
    graph.nodes = graph.nodes.filter((n) => n.id !== old.id);
    els.get(old.id)?.root.remove(); els.delete(old.id);
    graph.nodes.push(nn); mount(nn);
    feitos++;
  }
  refreshAll(); save();
  toast(`${c.message || "Troquei os nós de vídeo por nós novos."} (${feitos})`);
  return true;
}

// "logo-ajustes": muda os ajustes (c.aj) dos nós Logo 3D com o preset c.preset (ou pelo nome, c.labels).
function logoAjustesCommand(c) {
  const alvo = graph.nodes.filter((n) => n.type === "logo3d" && (c.labels ? c.labels.includes(n.data.label) : n.data.preset === c.preset));
  for (const n of alvo) {
    n.data.aj = { velocidade: LOGO_VEL, inicio: 0, tamanho: 1, dx: 0, dy: 0, ...(n.data.aj || {}), ...c.aj };
    if (c.novoPreset) n.data.preset = c.novoPreset;
    els.get(n.id)?.root.remove(); els.delete(n.id); mount(n);
  }
  refreshAll(); save();
  toast(`${c.message || "Mudei os ajustes dos logos."} (${alvo.length} nós)`);
  return true;
}

// "mostrar": centraliza o quadro nos nós pelo título (c.match) e seleciona o primeiro.
function mostrarCommand(c) {
  const re = new RegExp(c.match);
  const alvo = graph.nodes.filter((n) => n.type !== "group" && re.test(n.data.title || n.data.label || ""));
  if (!alvo.length) return true;
  fit(alvo);
  toast(c.message || "Aqui estão os nós.");
  return true;
}

// "dedupe": nós repetidos (mesmo tipo e mesmo título/nome, da lista c.titles): fica o primeiro, os outros saem.
function dedupeCommand(c) {
  const seen = new Set(), gone = [];
  for (const n of graph.nodes) {
    const name = n.data.title || n.data.label || "";
    if (!c.titles.includes(name)) continue;
    const k = `${n.type}|${name}`;
    if (seen.has(k)) gone.push(n.id); else seen.add(k);
  }
  for (const id of gone) removeNode(id);
  if (gone.length) { save(); toast(`${c.message || "Tirei os nós repetidos."} (${gone.length} nós)`); }
  return true;
}

function removeTitlesCommand(c) {
  const re = new RegExp(c.match), reN = c.notes ? new RegExp(c.notes) : null;
  const keep = (n) => (c.keep || []).some((k) => (n.data.title || n.data.label || "").startsWith(k));
  // Vídeos com o título e os Ajustes com o mesmo nome ("<título> · lento"), mesmo os que ficaram sem vídeo ligado.
  const gone = new Set(graph.nodes.filter((n) => !keep(n) && ((n.type === "generator" && re.test(n.data.title || "")) || (n.type === "adjust" && re.test(n.data.label || "")))).map((n) => n.id));
  for (let grew = true; grew;) {
    grew = false;
    for (const n of graph.nodes) {
      if (gone.has(n.id) || keep(n) || ["note", "group", "generator", "clip"].includes(n.type)) continue;
      const ins = graph.edges.filter((e) => e.to === n.id), outs = graph.edges.filter((e) => e.from === n.id);
      const feedsOnlyGone = outs.length && outs.every((e) => gone.has(e.to)) && !ins.some((e) => !gone.has(e.from));
      const fedOnlyByGone = ["join", "final", "compose", "adjust", "result"].includes(n.type) && ins.length && ins.every((e) => gone.has(e.from));
      if (feedsOnlyGone || fedOnlyByGone) { gone.add(n.id); grew = true; }
    }
  }
  const names = new Set(graph.nodes.filter((n) => gone.has(n.id)).map((n) => n.data.title || n.data.label).filter(Boolean));
  for (const n of graph.nodes) if (n.type === "note" && !keep(n) && (names.has(n.data.label) || reN?.test(n.data.label || ""))) gone.add(n.id);
  // c.also: nós soltos (sem fio) com esses nomes exatos, que não sairiam pelos fios.
  // (os fios que só vão para nós que também saem não seguram o nó)
  for (const n of graph.nodes) if ((c.also || []).includes(n.data.title || n.data.label) && !graph.edges.some((e) => (e.from === n.id && !gone.has(e.to)) || (e.to === n.id && !gone.has(e.from)))) gone.add(n.id);
  if (!gone.size) return true;
  try { localStorage.setItem(`estudio-grafo-copia-${c.id}`, JSON.stringify(graph)); } catch {}
  for (const id of gone) removeNode(id);
  save();
  toast(`${c.message || "Apaguei os nós pedidos."} (${gone.size} nós)`);
  return true;
}

// "join-insert": liga um nó de Vídeo (pelo título) a um Juntar (pelo nome) na posição c.at (0 = primeiro),
// empurrando os que já estavam ligados.
function joinInsertCommand(c) {
  const j = graph.nodes.find((n) => n.type === "join" && n.data.label === c.join);
  const g = graph.nodes.find((n) => n.type === "generator" && n.data.title === c.gen);
  if (!j || !g) return false;
  if (graph.edges.some((e) => e.to === j.id && e.from === g.id)) return true;
  const ins = JOIN_PORTS.map((p) => edgeTo(j.id, p)).filter(Boolean);
  graph.edges = graph.edges.filter((e) => !ins.includes(e));
  const order = ins.map((e) => e.from);
  order.splice(c.at || 0, 0, g.id);
  order.slice(0, JOIN_PORTS.length).forEach((from, i) => graph.edges.push({ from, to: j.id, port: JOIN_PORTS[i] }));
  refreshAll();
  save();
  toast(c.message || "Liguei o vídeo ao Juntar.");
  return true;
}

// "swap-image": troca a imagem destes nós (por id) por um arquivo de uploads/, refazendo as partes da panorâmica.
function swapImageCommand(c) {
  const targets = c.labels // pelo nome do nó de imagem (ex.: "Vista 1 · frente"), ou pelo id
    ? graph.nodes.filter((n) => n.type === "image" && c.labels.includes(n.data.label))
    : c.nodes.map((id) => graph.nodes.find((n) => n.id === id)).filter(Boolean);
  if (!targets.length) return false;
  (async () => {
    try {
      const blob = await (await fetch(c.url)).blob();
      const { blob: img, pano } = await prepareImage(new File([blob], c.url.split("/").pop(), { type: blob.type }));
      const j = await sendImage(img);
      let p = null;
      if (pano) {
        const tiles = [];
        for (const t of pano.tiles) tiles.push((await sendImage(t)).file);
        const band = await sendImage(pano.band.blob);
        p = { w: pano.w, h: pano.h, tileW: pano.tileW, xs: pano.xs, tiles, band: { file: band.file, y: pano.band.y, h: pano.band.h } };
      }
      for (const n of targets) {
        Object.assign(n.data, { file: j.file, url: j.url, pano: p, ...(c.label ? { label: c.label } : {}) });
        els.get(n.id)?.root.remove();
        els.delete(n.id);
        mount(n);
      }
      save();
      refreshAll();
      refreshGenerators();
      toast(c.message || "Troquei a imagem.");
    } catch (e) {
      toast(`Não consegui trocar a imagem: ${e.message}`, true);
    }
  })();
  return true;
}

// "set-prompts": troca o texto do nó de prompt ligado a cada gerador (pelo título ou pelo id do gerador).
function setPromptsCommand(c) {
  let hit = 0;
  for (const [key, text] of Object.entries(c.prompts)) {
    const gen = graph.nodes.find((n) => n.type === "generator" && (n.id === key || n.data.title === key));
    const e = gen && edgeTo(gen.id, "prompt");
    const p = e && graph.nodes.find((n) => n.id === e.from && n.type === "prompt");
    if (!p) continue;
    p.data.text = text;
    els.get(p.id)?.root.remove();
    els.delete(p.id);
    mount(p);
    hit++;
  }
  if (!hit) return false;
  save();
  refreshAll();
  toast(c.message || `Atualizei ${hit} prompts.`);
  return true;
}

// "join-prepend": põe um gerador (com um Ajuste novo) na primeira entrada de um Juntar; os outros descem uma.
function joinPrependCommand(c) {
  const j = graph.nodes.find((n) => n.type === "join" && n.data.label === c.join);
  const gen = graph.nodes.find((n) => n.id === c.gen);
  if (!j || !gen) return false;
  if (graph.edges.some((e) => e.to === j.id && graph.nodes.find((n) => n.id === e.from)?.data.label === c.adjustLabel)) return true;
  const b = nodeBox(gen);
  const spot = freeSpot(gen.x, gen.y + b.h + 40, 380, 520);
  const adj = { id: uid(), type: "adjust", x: spot.x, y: spot.y, data: { ...ADJUST_DEFAULT, ...(c.adjust || {}), label: c.adjustLabel, dirty: true } };
  graph.nodes.push(adj);
  mount(adj);
  graph.edges.push({ from: gen.id, to: adj.id, port: "in" });
  const ins = JOIN_PORTS.map((p) => edgeTo(j.id, p)).filter(Boolean);
  graph.edges = graph.edges.filter((e) => !ins.includes(e));
  [adj.id, ...ins.map((e) => e.from)].slice(0, JOIN_PORTS.length).forEach((from, i) => graph.edges.push({ from, to: j.id, port: JOIN_PORTS[i] }));
  refreshAll();
  save();
  fit([gen, adj, j]);
  toast(c.message || "Pus o clipe no começo do Juntar.");
  return true;
}

// "join-for": põe um nó Juntar ao lado dos vídeos com esses títulos (na ordem), se ainda não houver.
function joinForCommand(c) {
  const gens = c.titles.map((t) => graph.nodes.find((n) => n.type === "generator" && n.data.title === t));
  if (gens.some((g) => !g)) return false; // os trechos ainda não chegaram a esta página
  const already = graph.nodes.some((n) => n.type === "join" && graph.edges.some((e) => e.to === n.id && e.from === gens[0].id));
  if (already) return true;
  const last = gens.at(-1);
  const b = nodeBox(last);
  const x = last.x + b.w + 120;
  const noteNode = { id: uid(), type: "note", x, y: last.y - 170, data: { label: c.title, text: c.note, w: 380 } };
  const j = { id: uid(), type: "join", x, y: last.y, data: { label: c.title } };
  for (const n of [noteNode, j]) { graph.nodes.push(n); mount(n); }
  gens.slice(0, JOIN_PORTS.length).forEach((g, i) => graph.edges.push({ from: g.id, to: j.id, port: JOIN_PORTS[i] }));
  refreshAll();
  fit([...gens, j]);
  toast(c.message || "Pus o nó Juntar ao lado dos trechos.");
  return true;
}

// "compose-for": põe um nó Compor ligado ao vídeo de fundo (título) e ao logo (título ou nome do Juntar).
function composeForCommand(c) {
  const find = (t) => graph.nodes.find((n) => (n.type === "generator" && n.data.title === t) || (n.type === "join" && n.data.label === t));
  const logo = find(c.logo);
  const bg = c.bg ? find(c.bg) : null;
  if (!logo || (c.bg && !bg)) return false; // os nós ainda não chegaram a esta página
  if (graph.nodes.some((n) => n.type === "compose" && n.data.label === c.title)) return true;
  // Fica ao lado do vídeo de fundo (cada Compor perto das suas ondas), ou do logo se o fundo for imagem.
  const anchor = bg || logo;
  const b = nodeBox(anchor);
  const spot = freeSpot(anchor.x + b.w + 140, anchor.y, 420, 900);
  const x = spot.x;
  const note = { id: uid(), type: "note", x, y: spot.y - 190, data: { label: c.title, text: c.note, w: 380 } };
  const comp = { id: uid(), type: "compose", x, y: spot.y, data: { label: c.title, ...COMPOSE_DEFAULT, ...(c.pos || {}), erase: c.erase || null } };
  // Fundo de imagem: cria o nó da imagem ao lado (bgImage = arquivo em uploads/).
  const img = c.bgImage ? { id: uid(), type: "image", x: x + 420, y: spot.y, data: { label: c.bgImageLabel || "Fundo", file: c.bgImage, url: `/uploads/${c.bgImage}` } } : null;
  for (const n of [note, comp, img].filter(Boolean)) { graph.nodes.push(n); mount(n); }
  graph.edges.push({ from: logo.id, to: comp.id, port: "logo" });
  if (bg) graph.edges.push({ from: bg.id, to: comp.id, port: "bg" });
  if (img) graph.edges.push({ from: img.id, to: comp.id, port: "bgimg" });
  refreshAll();
  fit([bg, logo, comp, img].filter(Boolean));
  toast(c.message || "Pus o nó Compor.");
  return true;
}

// "compose-tidy": arruma o quadro depois que as imagens carregam. (1) Em cada nó de vídeo, a imagem
// de last frame fica logo abaixo da de first frame, pela altura real. (2) Os Compor (com a nota e a
// imagem de fundo, se tiverem) vão para uma coluna só deles, à direita de tudo, na altura do seu fundo.
function composeTidyCommand() {
  const move = (n, x, y) => { n.x = x; n.y = y; const r = els.get(n.id)?.root; if (r) { r.style.left = x + "px"; r.style.top = y + "px"; } };
  const hOf = (n) => nodeBox(n).h;
  for (const g of graph.nodes.filter((n) => n.type === "generator")) {
    const f = edgeTo(g.id, "first"), l = edgeTo(g.id, "last");
    const fi = f && node(f.from), li = l && node(l.from);
    if (!fi || !li || fi === li) continue;
    const lOthers = graph.edges.filter((e) => e.from === li.id && e.to !== g.id).length;
    if (!lOthers && li.y < fi.y + hOf(fi) + 24 && Math.abs(li.x - fi.x) < 40) move(li, li.x, fi.y + hOf(fi) + 24);
  }
  const comps = graph.nodes.filter((n) => n.type === "compose");
  const extra = new Set();
  for (const c of comps) {
    extra.add(c.id);
    const note = graph.nodes.find((n) => n.type === "note" && n.data.label === c.data.label);
    if (note) extra.add(note.id);
    const ie = edgeTo(c.id, "bgimg");
    if (ie && graph.edges.filter((e) => e.from === ie.from).length === 1) extra.add(ie.from);
  }
  const rest = graph.nodes.filter((n) => !extra.has(n.id));
  const X = Math.max(...rest.map((n) => n.x + nodeBox(n).w)) + 260;
  const anchorY = (c) => { const e = edgeTo(c.id, "bg") || edgeTo(c.id, "logo"); return e ? node(e.from).y : c.y; };
  let floor = -Infinity;
  for (const c of comps.sort((p, q) => anchorY(p) - anchorY(q))) {
    const note = graph.nodes.find((n) => n.type === "note" && n.data.label === c.data.label);
    const top = Math.max(anchorY(c) - (note ? 190 : 0), floor);
    if (note) move(note, X, top);
    move(c, X, top + (note ? 190 : 0));
    let bottom = c.y + hOf(c);
    const ie = edgeTo(c.id, "bgimg");
    if (ie && extra.has(ie.from)) { const img = node(ie.from); move(img, X + nodeBox(c).w + 60, c.y); bottom = Math.max(bottom, img.y + hOf(img)); }
    floor = bottom + 120;
  }
  refreshAll();
  return true;
}

// "final-for": põe um nó Composição final ligado, na ordem, aos nós com esses nomes (Compor, Juntar
// ou vídeo). Os que ainda não existirem nesta página ficam de fora; o resto liga normalmente.
function finalForCommand(c) {
  if (graph.nodes.some((n) => n.type === "final" && n.data.label === c.title)) return true;
  const find = (t) => graph.nodes.find((n) => (n.type === "compose" || n.type === "join" || n.type === "final") ? n.data.label === t : n.type === "generator" && n.data.title === t);
  const parts = c.parts.map(find).filter(Boolean);
  if (!parts.length) return false;
  const right = Math.max(...parts.map((p) => p.x + nodeBox(p).w));
  const spot = freeSpot(right + 200, Math.min(...parts.map((p) => p.y)), 380, 700);
  const note = { id: uid(), type: "note", x: spot.x, y: spot.y - 190, data: { label: c.title, text: c.note, w: 380 } };
  const fin = { id: uid(), type: "final", x: spot.x, y: spot.y, data: { label: c.title } };
  for (const n of [note, fin]) { graph.nodes.push(n); mount(n); }
  parts.slice(0, 6).forEach((p, i) => graph.edges.push({ from: p.id, to: fin.id, port: `v${i + 1}` }));
  refreshAll();
  fit([...parts, fin]);
  toast(c.message || "Pus a Composição final ligada aos resultados.");
  return true;
}

function applyCommand(c) {
  if (c.type === "final-for") return finalForCommand(c);
  if (c.type === "compose-for") return composeForCommand(c);
  if (c.type === "join-for") return joinForCommand(c);
  if (c.type === "wire-gens") return wireGensCommand(c);
  if (c.type === "prune-empty") return pruneEmptyCommand(c);
  if (c.type === "remove-titles") return removeTitlesCommand(c);
  if (c.type === "join-insert") return joinInsertCommand(c);
  if (c.type === "swap-image") return swapImageCommand(c);
  // Igual, para refazer as faixas com a borda espelhada: páginas antigas ignoram (fariam a faixa desfocada de antes).
  if (c.type === "swap-image-2") return swapImageCommand(c);
  if (c.type === "set-prompts") return setPromptsCommand(c);
  if (c.type === "join-prepend") return joinPrependCommand(c);
  if (c.type === "patch") return patchCommand(c);
  if (c.type === "board") return boardCommand(c);
  // Versão com nó Juntar: páginas antigas não conhecem esse tipo e o ignoram, em vez de quebrar o quadro.
  if (c.type === "board-join") return boardCommand(c);
  // Com nó Logo 3D depois do Juntar (row.logo3d): páginas antigas ignoram, em vez de montar sem o logo.
  if (c.type === "board-logo") return boardCommand(c);
  // Com Ajuste embaixo de cada vídeo (cell.adjust): páginas antigas ignoram, em vez de montar sem ele.
  if (c.type === "board-ajuste") return boardCommand(c);
  // Com fundo limpo e "Travar fundo" em cada troca: páginas antigas ignoram.
  if (c.type === "board-4k") return boardCommand(c);
  if (c.type === "build") return buildCommand(c);
  // Nós com vídeo de referência (refVideo): páginas antigas ignoram, em vez de montar um nó que gera só com o prompt.
  if (c.type === "build-ref") return buildCommand(c);
  // Igual, mas com c.unless (não duplica; só leva a vista até o nó): páginas sem esse código ignoram.
  if (c.type === "build-ref-mostrar") return buildCommand(c);
  if (c.type === "dedupe") return dedupeCommand(c);
  if (c.type === "refazer-faixas") return refazerFaixasCommand(c);
  if (c.type === "refazer-faixas-fundo" || c.type === "refazer-faixas-fundo-2" || c.type === "refazer-faixas-fundo-3") return refazerFaixasFundoCommand(c);
  if (c.type === "logo-velocidade") return logoVelocidadeCommand(c);
  if (c.type === "sem-travar") return semTravarCommand(c);
  if (c.type === "renovar") return renovarCommand(c);
  if (c.type === "logo-ajustes") return logoAjustesCommand(c);
  if (c.type === "mostrar") return mostrarCommand(c);
  if (c.type === "lento-e-logo") return lentoELogoCommand(c);
  if (c.type === "organizar-atos" || c.type === "organizar-atos-2" || c.type === "organizar-atos-3" || c.type === "organizar-atos-4") return organizarAtosCommand(c);
  if (c.type === "connect") return connectCommand(c);
  // Igual, mas ignorando notas com o mesmo nome: páginas antigas ignoram.
  if (c.type === "connect-2") return connectCommand(c);
  // Limpeza que também apaga Ajustes pelo nome: páginas antigas ignoram (elas deixariam os Ajustes para trás).
  if (c.type === "remove-titles-2") return removeTitlesCommand(c);
  // Com c.also (nós soltos pelo nome): páginas antigas ignoram.
  if (c.type === "remove-titles-3") return removeTitlesCommand(c);
  // c.also também leva nós ligados só ao que sai (ex.: o Logo 3D depois de um Juntar apagado).
  if (c.type === "remove-titles-4") return removeTitlesCommand(c);
  if (c.type !== "grokCopy") return false;
  const n = node(c.node);
  if (!n) return false;
  const b = nodeBox(n);
  const copy = duplicate(n, { ...c.patch, view: 0 }, b.w + 60, 0, false);
  // A cópia herdou os fios do original; o logo dela é o nó novo, não o antigo.
  graph.edges = graph.edges.filter((e) => !(e.to === copy.id && e.port === "logo"));
  const cb = nodeBox(copy);
  const logo = {
    id: uid(), type: "logo", ...freeSpot(copy.x, copy.y + cb.h + 40, 320, 560),
    data: { label: "Logo (giro)", text: LOGO_DEFAULT, refs: (c.refs || []).map((f) => ({ file: f, url: `/uploads/${f}` })), refsParts: c.refsParts || [3] },
  };
  graph.nodes.push(logo);
  mount(logo);
  graph.edges.push({ from: logo.id, to: copy.id, port: "logo" });
  refreshAll();
  select(copy.id);
  fit([n, copy, logo]);
  toast(c.message || "Montei os nós pedidos ao lado do vídeo.");
  return true;
}

async function checkInbox() {
  if (desatualizada) return;
  let list;
  try {
    const r = await fetch("/inbox.json", { cache: "no-store" });
    if (!r.ok) return;
    list = await r.json();
  } catch {
    return;
  }
  let done = [];
  try { done = JSON.parse(localStorage.getItem(INBOX_DONE)) || []; } catch {}
  for (const c of Array.isArray(list) ? list : []) {
    if (!c?.id || done.includes(c.id)) continue;
    if (applyCommand(c)) {
      done.push(c.id);
      try { localStorage.setItem(INBOX_DONE, JSON.stringify(done)); } catch {}
    }
  }
}
setInterval(checkInbox, 5000);

// ---------- Início ----------

applyView();
graph.nodes.forEach(mount);
refreshAll();
loadJobs();
loadBalance();
setTimeout(checkInbox, 800); // depois de os nós aparecerem, para medir o tamanho deles
addEventListener("resize", () => drawWires());
