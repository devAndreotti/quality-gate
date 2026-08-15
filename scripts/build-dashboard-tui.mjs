#!/usr/bin/env node
// Gera scripts/dashboard-tui.mjs a partir de dashboard-src/app.jsx (ink + React).
// Dev-only: roda aqui no repo-fonte do quality-gate, nunca em projeto-alvo.
// npm run build:dashboard-tui  (ou: node scripts/build-dashboard-tui.mjs)
//
// Receita validada por spike manual (ver plano floating-singing-scroll.md):
// - format 'esm' e obrigatorio -- yoga-layout (engine de layout do ink) usa top-level
//   await pra carregar um WASM; formato 'cjs' quebra com essa combinacao.
// - alias de 'react-devtools-core' pra um stub vazio -- e opcional em uso, mas o import
//   estatico do ink por ele resolve incondicionalmente; sem alias o build falha.
// - banner com createRequire -- uma dependencia interna (signal-exit) usa require('assert')
//   que o bundle ESM puro nao resolve em runtime sem esse shim.
import * as esbuild from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const entry = path.join(root, 'dashboard-src', 'app.jsx');
const outfile = path.join(root, 'scripts', 'dashboard-tui.mjs');
const stubPath = path.join(here, '.build-stub-react-devtools-core.mjs');

fs.writeFileSync(stubPath, 'export default null;\n');

try {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    outfile,
    alias: { 'react-devtools-core': stubPath },
    banner: {
      js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
    },
  });
} finally {
  fs.rmSync(stubPath, { force: true });
}

const header = '// GERADO por scripts/build-dashboard-tui.mjs a partir de dashboard-src/app.jsx -- NAO EDITE A MAO.\n// Para regenerar: node scripts/build-dashboard-tui.mjs\n';
fs.writeFileSync(outfile, header + fs.readFileSync(outfile, 'utf8'));

console.log(`dashboard-tui.mjs gerado (${(fs.statSync(outfile).size / 1024).toFixed(0)} KB)`);
