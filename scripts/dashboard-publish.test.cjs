const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { publishDashboard, scrubPaths } = require('./dashboard-publish.cjs');

const SCRIPT = path.join(__dirname, 'dashboard-publish.cjs');

function makeTempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-dashboard-publish-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('publishDashboard cria dashboard/index.html dentro da raiz temporária', (t) => {
  const root = makeTempRoot(t);
  const target = publishDashboard({ root });
  assert.equal(target, path.join(root, 'dashboard', 'index.html'));
  assert.ok(fs.existsSync(target), 'arquivo HTML deve existir');
});

test('o HTML gerado é estruturalmente válido (html de abertura e fechamento)', (t) => {
  const root = makeTempRoot(t);
  const html = fs.readFileSync(publishDashboard({ root }), 'utf8');
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes('<html'), 'deve conter <html');
  assert.ok(html.includes('</html>'), 'deve conter </html>');
  assert.ok(html.includes('<title>Quality Gate Dashboard</title>'));
});

test('o HTML não contém caminho absoluto da máquina', (t) => {
  const root = makeTempRoot(t);
  const html = fs.readFileSync(publishDashboard({ root }), 'utf8');
  assert.ok(!html.includes(root), 'raiz temporária não pode aparecer no HTML');
  assert.ok(!html.includes(os.homedir()), 'home do usuário não pode aparecer no HTML');
  assert.doesNotMatch(html, /\/(?:home|Users|root)\//);
});

test('scrubPaths remove raiz, home e caminhos típicos de erro', () => {
  const root = '/srv/projetos/meu-repo';
  const text = `falhou em ${root}/scripts/x.js e em /home/alguem/arquivo e em C:\\Users\\alguem\\y`;
  const out = scrubPaths(text, root);
  assert.ok(!out.includes(root));
  assert.ok(!out.includes('/home/alguem'));
  assert.ok(!out.includes('C:\\Users'));
  assert.ok(out.includes('<repo>'));
});

test('CLI aceita --root e --out e grava o arquivo no caminho pedido', (t) => {
  const root = makeTempRoot(t);
  const out = path.join(root, 'saida', 'painel.html');
  execFileSync(process.execPath, [SCRIPT, '--root', root, '--out', out], { stdio: 'ignore' });
  assert.ok(fs.existsSync(out));
});

test('renderChecks shows counts, a row per check with status, and escapes names', () => {
  const { renderChecks } = require('./dashboard-publish.cjs');
  const html = renderChecks({
    sha: 'abc1234567',
    counts: { ok: 1, fail: 1, running: 0, other: 0 },
    checks: [
      { name: 'Lint', status: 'completed', conclusion: 'success', url: 'https://github.com/a/b/runs/1' },
      { name: '<script>x</script>', status: 'completed', conclusion: 'failure', url: 'javascript:alert(1)' },
    ],
  });
  assert.match(html, /abc1234/);
  assert.match(html, /<tr class="ok">/);
  assert.match(html, /<tr class="fail">/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>x/);
  assert.doesNotMatch(html, /href="javascript:/);
});

test('renderChecks shows the error message when checks could not be collected', () => {
  const { renderChecks } = require('./dashboard-publish.cjs');
  assert.match(renderChecks({ error: 'gh indisponível' }), /gh indisponível/);
});
