// ESLint 9 (flat config) para os scripts CommonJS deste repositório.
// Regras: js.configs.recommended. Globais de Node declaradas aqui para não
// depender do pacote transitivo "globals".
'use strict';

const js = require('@eslint/js');

const nodeGlobals = {
  __dirname: 'readonly',
  __filename: 'readonly',
  AbortController: 'readonly',
  Buffer: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  clearImmediate: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  exports: 'writable',
  fetch: 'readonly',
  global: 'readonly',
  globalThis: 'readonly',
  module: 'writable',
  process: 'readonly',
  queueMicrotask: 'readonly',
  require: 'readonly',
  setImmediate: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  structuredClone: 'readonly',
};

module.exports = [
  {
    ignores: [
      'coverage/**',
      'node_modules/**',
      '.quality-gate/**',
      // Bundles gerados por scripts/build-tui.mjs (esbuild a partir de dashboard-src/).
      // Não são código fonte editável; o lint não se aplica a eles.
      'scripts/dashboard-tui.mjs',
      'scripts/menu-tui.mjs',
    ],
  },
  {
    // DÍVIDA CONHECIDA: arquivos de scripts/ com erros de lint ainda não corrigidos.
    // Remover cada entrada conforme o erro for corrigido. Issue de acompanhamento:
    // "lint: corrigir erros em scripts/".
    ignores: [
      'scripts/commit-lint.cjs',
      'scripts/commit-lint.test.cjs',
      'scripts/configure-project.cjs',
      'scripts/git-hooks.test.cjs',
      'scripts/lib-diff-coverage.test.cjs',
      'scripts/lib/diff-coverage.cjs',
      'scripts/lib/workflow.cjs',
      'scripts/secret-scan.cjs',
      'scripts/secret-scan.test.cjs',
    ],
  },
  {
    files: ['scripts/**/*.{js,cjs}', 'test/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
  },
];
