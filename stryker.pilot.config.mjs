// Piloto descartavel de mutation testing (Stryker) — experimento local, NAO e gate.
// Limitacao: o runner oficial do Stryker nao suporta node:test. Usamos o test runner
// "command" embutido no @stryker-mutator/core, que roda `node --test <arquivos>` por mutante
// e considera o mutante morto quando o comando sai com codigo != 0.
// Thresholds com break: null — nunca quebra build.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  testRunner: 'command',
  commandRunner: {
    command: 'node --test scripts/lib-diff-coverage.test.cjs scripts/lib-utilities.test.cjs',
  },
  coverageAnalysis: 'off',
  mutate: ['scripts/lib/diff-coverage.cjs', 'scripts/lib/console-ui.cjs'],
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  thresholds: { high: 80, low: 60, break: null },
  timeoutMS: 60000,
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
};
