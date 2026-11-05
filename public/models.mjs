// Catálogo dos modelos de vídeo do ArgoLink usados no estúdio.
// Preços em USD por segundo, conferidos nas páginas de cada modelo em 2026-10-26.
export const MODELS = {
  "seedance-2.0-mini": {
    name: "Seedance 2.0 Mini",
    note: "O mais barato do Seedance, para rascunhos em lote",
    resolutions: ["480p", "720p"],
    price: { "480p": 0.0299, "720p": 0.0643 },
    maxDuration: 15,
  },
  "seedance-2.0-fast": {
    name: "Seedance 2.0 Fast",
    note: "Entrega mais rápida, para testar uma ideia",
    resolutions: ["480p", "720p"],
    price: { "480p": 0.0478, "720p": 0.103 },
    maxDuration: 15,
  },
  "seedance-2.0": {
    name: "Seedance 2.0",
    note: "Rascunhos em 480p e o único com 4K",
    resolutions: ["480p", "720p", "1080p", "4k"],
    price: { "480p": 0.0598, "720p": 0.129, "1080p": 0.318, "4k": 0.661 },
    // Com vídeo de referência (movimento): todos os segundos (saída + referência) saem por este preço.
    priceVideoInput: { "480p": 0.0359, "720p": 0.0774, "1080p": 0.191, "4k": 0.397 },
    maxDuration: 15,
  },
  "seedance-2.5": {
    name: "Seedance 2.5",
    note: "O mais capaz; versão final em 1080p, até 30s",
    resolutions: ["480p", "720p", "1080p"],
    price: { "480p": 0.0874, "720p": 0.196, "1080p": 0.483 },
    maxDuration: 30,
    framesAdaptiveOnly: true,
  },
  "grok-imagine-video-1.5": {
    name: "Grok Imagine Video 1.5",
    note: "Aceita first/last frame junto com imagens de referência (ex.: as vistas do logo); até 720p",
    // Com last frame ou referências o máximo é 720p (1080p só com o first frame sozinho).
    resolutions: ["480p", "720p"],
    price: { "480p": 0.032, "720p": 0.056 },
    maxDuration: 15,
    api: "grok", // campos image / last_frame / reference_images em vez de start_image / end_image
    acceptsRefs: true,
  },
  "minimax-h3": {
    name: "MiniMax H3",
    note: "O mais baratinho por segundo; gera som sempre (o estúdio tira do arquivo)",
    resolutions: ["768p", "2k"],
    price: { "768p": 0.039, "2k": 0.064 },
    maxDuration: 15,
    framesAdaptiveOnly: true,
    alwaysAudio: true,
  },
};

// Etapas do fluxo: rascunho barato → comparar modelos → final em alta.
export const STAGES = {
  rascunho: {
    label: "Rascunho",
    hint: "Seedance 2.0 em 480p para testar o prompt",
    runs: [{ model: "seedance-2.0", resolution: "480p" }],
  },
  comparar: {
    label: "Comparar 4",
    hint: "O mesmo prompt nos 4 modelos, na resolução mais barata de cada um",
    runs: [
      { model: "seedance-2.0", resolution: "480p" },
      { model: "seedance-2.5", resolution: "480p" },
      { model: "minimax-h3", resolution: "768p" },
      { model: "seedance-2.0-fast", resolution: "480p" },
    ],
  },
  final: {
    label: "Final",
    hint: "Seedance 2.5 em 1080p quando o rascunho estiver bom",
    runs: [{ model: "seedance-2.5", resolution: "1080p" }],
  },
  final4k: {
    label: "Final 4K",
    hint: "Seedance 2.0 em 4K (o 2.5 vai até 1080p)",
    runs: [{ model: "seedance-2.0", resolution: "4k" }],
  },
  manual: {
    label: "Manual",
    hint: "Você escolhe modelo e resolução",
    runs: null,
  },
};

export const RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];

// Atalhos no seletor de modelo, seguindo o fluxo: rascunho barato → final em alta.
export const PRESETS = [
  { label: "Rascunho", hint: "testar o prompt", model: "seedance-2.0", resolution: "480p" },
  { label: "Final", hint: "quando o rascunho estiver bom", model: "seedance-2.5", resolution: "1080p" },
  { label: "Final 4K", hint: "o 2.5 vai até 1080p", model: "seedance-2.0", resolution: "4k" },
];

// "Comparar modelos": o mesmo pedido nestes modelos, na resolução mais barata de cada um.
export const COMPARE = [
  { model: "seedance-2.0", resolution: "480p" },
  { model: "seedance-2.5", resolution: "480p" },
  { model: "minimax-h3", resolution: "768p" },
  { model: "seedance-2.0-fast", resolution: "480p" },
];

export const DURATIONS = [4, 5, 6, 8, 10, 12, 15, 20, 25, 30];
