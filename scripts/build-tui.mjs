#!/usr/bin/env node
// Gera scripts/dashboard-tui.mjs e scripts/menu-tui.mjs a partir de dashboard-src/*.jsx
// (ink + React). Dev-only: roda aqui no repo-fonte do quality-gate, nunca em projeto-alvo.
// npm run build:tui  (ou: node scripts/build-tui.mjs)
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
const stubPath = path.join(here, '.build-stub-react-devtools-core.mjs');

const BUNDLES = [
  { entry: 'app.jsx', outfile: 'dashboard-tui.mjs' },
  { entry: 'menu.jsx', outfile: 'menu-tui.mjs' },
];

fs.writeFileSync(stubPath, 'export default null;\n');

try {
  for (const { entry, outfile } of BUNDLES) {
    const entryPath = path.join(root, 'dashboard-src', entry);
    const outPath = path.join(root, 'scripts', outfile);
    await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      platform: 'node',
      format: 'esm',
      jsx: 'automatic',
      outfile: outPath,
      alias: { 'react-devtools-core': stubPath },
      banner: {
        js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
      },
    });
    const header = `// GERADO por scripts/build-tui.mjs a partir de dashboard-src/${entry} -- NAO EDITE A MAO.\n// Para regenerar: node scripts/build-tui.mjs\n`;
    fs.writeFileSync(outPath, header + fs.readFileSync(outPath, 'utf8'));
    console.log(`${outfile} gerado (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
  }
} finally {
  fs.rmSync(stubPath, { force: true });
}
