const assert = require('node:assert/strict');
const test = require('node:test');

const {
  calculateDiffCoverage,
  evaluateDiffCoverage,
  isGatedSource,
  parseAddedLines,
  parseDiffLineNumbers,
  parseLcovCoverageMap,
} = require('./lib/diff-coverage.cjs');

// Monta um diff com uma unica secao "+++ b/<file>" e linhas adicionadas a partir da linha 1.
function diffFor(file, lines) {
  return [`+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n');
}

// Monta um LCOV com um registro por arquivo; hits[i] vira DA:(i+1),hits[i].
function lcovFor(file, hits) {
  return [`SF:${file}`, ...hits.map((h, i) => `DA:${i + 1},${h}`), 'end_of_record'].join('\n');
}

test('parseDiffLineNumbers extracts added line numbers per file', () => {
  const sampleDiff = [
    'diff --git a/src/index.js b/src/index.js',
    '--- a/src/index.js',
    '+++ b/src/index.js',
    '@@ -10,3 +10,4 @@ function test() {',
    '   const a = 1;',
    '+  const b = 2;',
    '+  return a + b;',
    ' }',
  ].join('\n');

  const map = parseDiffLineNumbers(sampleDiff);
  assert.ok(map.has('src/index.js'));
  assert.deepEqual(Array.from(map.get('src/index.js')), [11, 12]);
});

test('calculateDiffCoverage calculates percentage and passes/fails against threshold', () => {
  const diff = ['+++ b/src/util.js', '@@ -1,2 +1,3 @@', '+function add(x) {', '+  return x + 1;', '+}'].join(
    '\n',
  );

  const lcovCovered = ['SF:src/util.js', 'DA:1,1', 'DA:2,1', 'DA:3,1', 'end_of_record'].join('\n');

  const resCovered = calculateDiffCoverage({ diffText: diff, lcovText: lcovCovered, minDiffCoverage: 80 });
  assert.equal(resCovered.pct, 100);
  assert.equal(resCovered.passed, true);
  assert.equal(resCovered.uncovered.length, 0);

  const lcovUncovered = ['SF:src/util.js', 'DA:1,1', 'DA:2,0', 'DA:3,1', 'end_of_record'].join('\n');

  const resUncovered = calculateDiffCoverage({
    diffText: diff,
    lcovText: lcovUncovered,
    minDiffCoverage: 80,
  });
  assert.equal(resUncovered.pct, 66.67);
  assert.equal(resUncovered.passed, false);
  assert.equal(resUncovered.uncovered.length, 1);
  assert.deepEqual(resUncovered.uncovered[0], { file: 'src/util.js', line: 2, status: 'uncovered' });
});

test('calculateDiffCoverage returns 100% when no executable lines changed', () => {
  const res = calculateDiffCoverage({ diffText: '', lcovText: '' });
  assert.equal(res.pct, 100);
  assert.equal(res.passed, true);
});

test('evaluateDiffCoverage: linha com 0 hits nao conta como coberta; 1 hit conta', () => {
  const diff = diffFor('src/a.js', ['const a = 1;', 'return a;']);
  const lcov = lcovFor('src/a.js', [0, 1]);

  const res = evaluateDiffCoverage({ diffText: diff, lcovText: lcov, minDiffCoverage: 50 });
  assert.equal(res.totalLines, 2);
  assert.equal(res.coveredLines, 1);
  assert.equal(res.pct, 50);
  assert.deepEqual(res.uncovered, [{ file: 'src/a.js', line: 1, status: 'uncovered' }]);
});

test('evaluateDiffCoverage: so hits 0 em todas as linhas resulta em 0%', () => {
  const diff = diffFor('src/a.js', ['x();', 'y();']);
  const res = evaluateDiffCoverage({
    diffText: diff,
    lcovText: lcovFor('src/a.js', [0, 0]),
    minDiffCoverage: 1,
  });
  assert.equal(res.coveredLines, 0);
  assert.equal(res.pct, 0);
  assert.equal(res.passed, false);
  assert.equal(res.uncovered.length, 2);
});

test('evaluateDiffCoverage: passed e true exatamente no limiar e false logo acima', () => {
  // 3 de 4 linhas cobertas = 75%.
  const diff = diffFor('src/b.js', ['l1;', 'l2;', 'l3;', 'l4;']);
  const lcov = lcovFor('src/b.js', [1, 1, 1, 0]);

  const atThreshold = evaluateDiffCoverage({ diffText: diff, lcovText: lcov, minDiffCoverage: 75 });
  assert.equal(atThreshold.pct, 75);
  assert.equal(atThreshold.passed, true);

  const abovePct = evaluateDiffCoverage({ diffText: diff, lcovText: lcov, minDiffCoverage: 75.01 });
  assert.equal(abovePct.passed, false);

  const belowPct = evaluateDiffCoverage({ diffText: diff, lcovText: lcov, minDiffCoverage: 74.99 });
  assert.equal(belowPct.passed, true);
});

test('evaluateDiffCoverage: limiar padrao e 90%', () => {
  const diff = diffFor(
    'src/c.js',
    Array.from({ length: 10 }, (_, i) => `f${i}();`),
  );

  const nine = evaluateDiffCoverage({
    diffText: diff,
    lcovText: lcovFor('src/c.js', [1, 1, 1, 1, 1, 1, 1, 1, 1, 0]),
  });
  assert.equal(nine.minDiffCoverage, 90);
  assert.equal(nine.pct, 90);
  assert.equal(nine.passed, true);

  const eight = evaluateDiffCoverage({
    diffText: diff,
    lcovText: lcovFor('src/c.js', [1, 1, 1, 1, 1, 1, 1, 1, 0, 0]),
  });
  assert.equal(eight.pct, 80);
  assert.equal(eight.passed, false);
});

test('evaluateDiffCoverage: sem linhas executaveis alteradas retorna 100% e passa', () => {
  const empty = evaluateDiffCoverage({ diffText: '', lcovText: '' });
  assert.equal(empty.pct, 100);
  assert.equal(empty.totalLines, 0);
  assert.equal(empty.passed, true);

  // Arquivo com registro LCOV mas nenhuma das linhas alteradas aparece em DA.
  const noDa = evaluateDiffCoverage({
    diffText: diffFor('src/d.js', ['x;']),
    lcovText: 'SF:src/d.js\nend_of_record',
    minDiffCoverage: 90,
  });
  assert.equal(noDa.totalLines, 0);
  assert.equal(noDa.pct, 100);
  assert.equal(noDa.passed, true);
});

test('evaluateDiffCoverage: arquivo sem registro LCOV conta linhas nao em branco como descobertas', () => {
  const diff = diffFor('src/new.js', ['const x = 1;', '   ', '']);
  const res = evaluateDiffCoverage({ diffText: diff, lcovText: '', minDiffCoverage: 80 });

  assert.equal(res.totalLines, 1);
  assert.equal(res.coveredLines, 0);
  assert.equal(res.pct, 0);
  assert.equal(res.passed, false);
  assert.deepEqual(res.untestedFiles, ['src/new.js']);
  assert.deepEqual(res.uncovered, [{ file: 'src/new.js', line: 1, status: 'no-coverage-record' }]);
});

test('evaluateDiffCoverage: arquivo sem registro LCOV so com linhas em branco nao entra no calculo', () => {
  const res = evaluateDiffCoverage({ diffText: diffFor('src/blank.js', ['  ', '']), lcovText: '' });
  assert.equal(res.totalLines, 0);
  assert.equal(res.pct, 100);
  assert.deepEqual(res.untestedFiles, []);
});

test('evaluateDiffCoverage: include restringe arquivos e nao-fontes sao ignorados', () => {
  const diff = [
    diffFor('src/in.js', ['a;']),
    diffFor('lib/out.js', ['b;']),
    diffFor('README.md', ['c']),
  ].join('\n');
  const lcov = [lcovFor('src/in.js', [0]), lcovFor('lib/out.js', [0])].join('\n');

  const filtered = evaluateDiffCoverage({ diffText: diff, lcovText: lcov, include: ['src/'] });
  assert.equal(filtered.totalLines, 1);
  assert.deepEqual(
    filtered.uncovered.map((u) => u.file),
    ['src/in.js'],
  );

  const all = evaluateDiffCoverage({ diffText: diff, lcovText: lcov });
  assert.equal(all.totalLines, 2);
});

test('evaluateDiffCoverage: casamento de caminho respeita limite de diretorio', () => {
  // "x.cjs" no LCOV nao pode casar com "scripts/ax.cjs" (sufixo sem barra).
  const res = evaluateDiffCoverage({
    diffText: diffFor('scripts/ax.cjs', ['a;']),
    lcovText: lcovFor('x.cjs', [1]),
    minDiffCoverage: 80,
  });
  assert.deepEqual(res.untestedFiles, ['scripts/ax.cjs']);

  // "scripts/x.cjs" no LCOV casa com "x.cjs" no diff (sufixo com barra).
  const matched = evaluateDiffCoverage({
    diffText: diffFor('x.cjs', ['a;']),
    lcovText: lcovFor('scripts/x.cjs', [1]),
    minDiffCoverage: 80,
  });
  assert.deepEqual(matched.untestedFiles, []);
  assert.equal(matched.pct, 100);
});

test('isGatedSource aceita codigo de producao e recusa testes, artefatos e docs', () => {
  for (const file of ['scripts/x.cjs', 'a.mjs', 'a.js', 'a.ts', 'a.tsx', 'a.jsx', 'mycoverage/a.js']) {
    assert.equal(isGatedSource(file), true, file);
  }
  for (const file of [
    'README.md',
    'src/a.json',
    'scripts/x.test.cjs',
    'src/x.spec.ts',
    'node_modules/a/b.js',
    'coverage/a.js',
    'dist/a.js',
    'build/a.js',
    '.semgrep/rule.js',
  ]) {
    assert.equal(isGatedSource(file), false, file);
  }
});

test('parseAddedLines guarda conteudo sem o prefixo e ignora linhas removidas', () => {
  const diff = ['+++ b/a.js', '@@ -1,3 +1,3 @@', ' keep', '-old', '+new', ' end'].join('\n');
  const map = parseAddedLines(diff);
  assert.deepEqual(Array.from(map.get('a.js').entries()), [[2, 'new']]);
});

test('parseLcovCoverageMap normaliza barras, ignora DA fora de SF e le hits', () => {
  const lcov = ['DA:9,9', 'SF:src\\win.js', 'DA:1,0', 'DA:2,3', 'end_of_record'].join('\n');
  const map = parseLcovCoverageMap(lcov);
  assert.deepEqual(Array.from(map.keys()), ['src/win.js']);
  assert.deepEqual(Array.from(map.get('src/win.js').entries()), [
    [1, 0],
    [2, 3],
  ]);
});

test('parseDiffLineNumbers: hunks com multiplos digitos, linhas removidas e cabecalho repetido', () => {
  const diff = [
    '+++ b/a.js',
    '@@ -100,2 +120,3 @@',
    '-old',
    '+new1',
    ' ctx',
    '+new2',
    '+++ b/a.js',
    '@@ -1 +7 @@',
    '+again',
  ].join('\n');
  assert.deepEqual(Array.from(parseDiffLineNumbers(diff).get('a.js')), [120, 122, 7]);
});

test('parseDiffLineNumbers: linha "+++" fora do cabecalho nao conta como adicionada', () => {
  const diff = ['+++ b/a.js', '@@ -0,0 +1,3 @@', '+one', '+++ /dev/null', '+two'].join('\n');
  assert.deepEqual(Array.from(parseDiffLineNumbers(diff).get('a.js')), [1, 3]);
});

test('parseDiffLineNumbers e parseAddedLines ignoram "+" antes de qualquer cabecalho', () => {
  const diff = '@@ -0,0 +1 @@\n+x';
  assert.equal(parseDiffLineNumbers(diff).size, 0);
  assert.equal(parseAddedLines(diff).size, 0);
});

test('parseDiffLineNumbers e parseAddedLines normalizam barras invertidas no caminho', () => {
  const diff = '+++ b/src\\win.js\n@@ -0,0 +1 @@\n+x';
  assert.ok(parseDiffLineNumbers(diff).has('src/win.js'));
  assert.ok(parseAddedLines(diff).has('src/win.js'));
});

test('parseAddedLines: linha removida antes de linha adicionada nao desloca a numeracao', () => {
  const diff = ['+++ b/a.js', '@@ -1,1 +1,1 @@', '-old', '+new'].join('\n');
  assert.deepEqual(Array.from(parseAddedLines(diff).get('a.js').entries()), [[1, 'new']]);
});

// Hunks com inicio e contagens de varios digitos, e um hunk sem contagem.
const MULTI_DIGIT_HUNKS = [
  '+++ b/a.js',
  '@@ -100,2 +120,3 @@',
  '+one',
  '@@ -1,12 +5,12 @@',
  '+two',
  '@@ -1 +9 @@',
  '+three',
].join('\n');

test('parseDiffLineNumbers: aceita hunks com varios digitos e sem contagem', () => {
  assert.deepEqual(Array.from(parseDiffLineNumbers(MULTI_DIGIT_HUNKS).get('a.js')), [120, 5, 9]);
});

test('parseAddedLines: aceita hunks com varios digitos e sem contagem', () => {
  assert.deepEqual(Array.from(parseAddedLines(MULTI_DIGIT_HUNKS).get('a.js').entries()), [
    [120, 'one'],
    [5, 'two'],
    [9, 'three'],
  ]);
});

test('parseDiffLineNumbers e parseAddedLines exigem hunk no inicio da linha', () => {
  // Linha adicionada cujo texto contem um cabecalho de hunk nao reinicia a numeracao.
  const diff = ['+++ b/a.js', '@@ -0,0 +1,2 @@', '+const s = "@@ -9 +9 @@";', '+next'].join('\n');
  assert.deepEqual(Array.from(parseDiffLineNumbers(diff).get('a.js')), [1, 2]);
  assert.deepEqual(Array.from(parseAddedLines(diff).get('a.js').keys()), [1, 2]);
});

test('parseAddedLines: cabecalho repetido do mesmo arquivo preserva linhas anteriores', () => {
  const diff = ['+++ b/a.js', '@@ -0,0 +1 @@', '+one', '+++ b/a.js', '@@ -0,0 +5 @@', '+two'].join('\n');
  assert.deepEqual(Array.from(parseAddedLines(diff).get('a.js').entries()), [
    [1, 'one'],
    [5, 'two'],
  ]);
});

test('parseAddedLines: linha "+++" fora do cabecalho nao conta como adicionada', () => {
  const diff = ['+++ b/a.js', '@@ -0,0 +1,3 @@', '+one', '+++ /dev/null', '+two'].join('\n');
  assert.deepEqual(Array.from(parseAddedLines(diff).get('a.js').entries()), [
    [1, 'one'],
    [3, 'two'],
  ]);
});

test('parseLcovCoverageMap: remove espacos finais e mescla secoes repetidas do mesmo arquivo', () => {
  const lcov = ['SF:src\\a.js  ', 'DA:1,1', 'end_of_record', 'SF:src/a.js', 'DA:2,0', 'end_of_record'].join(
    '\n',
  );
  const map = parseLcovCoverageMap(lcov);
  assert.deepEqual(Array.from(map.keys()), ['src/a.js']);
  assert.deepEqual(Array.from(map.get('src/a.js').entries()), [
    [1, 1],
    [2, 0],
  ]);
});

test('calculateDiffCoverage: limiar exato e casamento de caminho por sufixo', () => {
  const diff = diffFor('scripts/a.js', ['a;', 'b;', 'c;', 'd;']);
  const lcov = lcovFor('scripts/a.js', [1, 1, 1, 0]);
  assert.equal(calculateDiffCoverage({ diffText: diff, lcovText: lcov, minDiffCoverage: 75 }).passed, true);
  assert.equal(
    calculateDiffCoverage({ diffText: diff, lcovText: lcov, minDiffCoverage: 75.01 }).passed,
    false,
  );

  // LCOV com caminho mais longo que o do diff, e o contrario.
  const longer = calculateDiffCoverage({
    diffText: diff,
    lcovText: lcovFor('project/scripts/a.js', [1, 1, 1, 0]),
  });
  assert.equal(longer.totalLines, 4);
  const shorter = calculateDiffCoverage({
    diffText: diffFor('project/scripts/a.js', ['a;', 'b;', 'c;', 'd;']),
    lcovText: lcovFor('scripts/a.js', [1, 1, 1, 0]),
  });
  assert.equal(shorter.totalLines, 4);

  // Arquivo sem registro LCOV e linha alterada ausente de DA nao entram no calculo.
  const unrelated = calculateDiffCoverage({ diffText: diff, lcovText: lcovFor('scripts/b.js', [0]) });
  assert.equal(unrelated.totalLines, 0);
  assert.equal(unrelated.pct, 100);

  const partialDa = calculateDiffCoverage({
    diffText: diffFor('scripts/a.js', ['a;', 'b;', 'c;', 'd;']),
    lcovText: lcovFor('scripts/a.js', [1, 1, 0]),
  });
  assert.equal(partialDa.totalLines, 3);
  assert.equal(partialDa.coveredLines, 2);
  assert.equal(partialDa.pct, 66.67);
});

test('evaluateDiffCoverage: include com varios prefixos aceita qualquer um deles', () => {
  const diff = [diffFor('src/in.js', ['a;']), diffFor('lib/also.js', ['b;'])].join('\n');
  const lcov = [lcovFor('src/in.js', [1]), lcovFor('lib/also.js', [1])].join('\n');
  const res = evaluateDiffCoverage({ diffText: diff, lcovText: lcov, include: ['src/', 'lib/'] });
  assert.equal(res.totalLines, 2);
  assert.equal(res.coveredLines, 2);
});

test('evaluateDiffCoverage: casamento de caminho nao aceita sufixo sem limite de diretorio nos dois sentidos', () => {
  // LCOV "scripts/ax.cjs" nao casa com diff "x.cjs".
  const noMatch = evaluateDiffCoverage({
    diffText: diffFor('x.cjs', ['a;']),
    lcovText: lcovFor('scripts/ax.cjs', [1]),
    minDiffCoverage: 80,
  });
  assert.deepEqual(noMatch.untestedFiles, ['x.cjs']);

  // LCOV "x.cjs" casa com diff "scripts/x.cjs" (sufixo com barra no sentido inverso).
  const reverse = evaluateDiffCoverage({
    diffText: diffFor('scripts/x.cjs', ['a;']),
    lcovText: lcovFor('x.cjs', [1]),
    minDiffCoverage: 80,
  });
  assert.deepEqual(reverse.untestedFiles, []);
  assert.equal(reverse.pct, 100);
});

test('isGatedSource recusa sufixos compostos e aceita variantes de extensao', () => {
  for (const file of ['a.cjs', 'a.mjs', 'a.tsx', 'a.jsx', 'a.ts']) {
    assert.equal(isGatedSource(file), true, file);
  }
  for (const file of ['src/a.js.map', 'src/a.cjsx', 'src/a.tsx.bak', 'src/a.ts.orig', 'src/a.mjs.txt']) {
    assert.equal(isGatedSource(file), false, file);
  }
});
