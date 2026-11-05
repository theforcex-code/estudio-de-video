#!/usr/bin/env node
// Abre o estúdio para convidados: liga um túnel do Cloudflare até http://localhost:4321 e monta o link
// com o código de acesso. Quem recebe o link gera pelo ArgoLink com a chave deste computador.
// O link muda a cada vez que isto é aberto; o código de acesso fica o mesmo (ACESSO.txt).
//
//   node estudio/compartilhar.mjs

import { spawn, execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4321;
const EXE = join(HERE, "ferramentas", "cloudflared.exe");
const ACCESS_FILE = join(HERE, "ACESSO.txt");
const LINK_FILE = join(HERE, "LINK-COMPARTILHAR.txt");

if (!existsSync(EXE)) {
  console.log(`Falta o cloudflared: baixe cloudflared-windows-amd64.exe em\nhttps://github.com/cloudflare/cloudflared/releases e salve como\n${EXE}`);
  process.exit(1);
}

let code = process.env.ESTUDIO_ACESSO || (existsSync(ACCESS_FILE) ? readFileSync(ACCESS_FILE, "utf8").trim() : "");
if (!code) {
  code = randomBytes(18).toString("base64url");
  writeFileSync(ACCESS_FILE, code + "\n");
}

try {
  await fetch(`http://localhost:${PORT}/api/status`);
} catch {
  console.log(`O estúdio não está ligado em http://localhost:${PORT}. Abra o estúdio antes.`);
  process.exit(1);
}

console.log("Abrindo o túnel…");
const tunnel = spawn(EXE, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${PORT}`], { windowsHide: true });
let shown = false;
const watch = (chunk) => {
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(chunk));
  if (!m || shown) return;
  shown = true;
  const link = `${m[0]}/?acesso=${code}`;
  writeFileSync(LINK_FILE, link + "\n");
  execFile("cmd", ["/c", `echo|set /p="${link}"| clip`], () => {});
  console.log(`\nLink para mandar (já copiado):\n\n  ${link}\n\nQuem abrir gera com o saldo do seu ArgoLink, sem limite.`);
  console.log("O link funciona enquanto esta janela e o estúdio estiverem abertos. Feche esta janela para cortar o acesso.");
  console.log("Para trocar o código (cortar quem já tem o link), apague estudio/ACESSO.txt e abra de novo.\n");
};
tunnel.stdout.on("data", watch);
tunnel.stderr.on("data", watch);
tunnel.on("exit", (c) => { console.log(`O túnel fechou (código ${c}).`); process.exit(c || 0); });
process.on("SIGINT", () => tunnel.kill());
