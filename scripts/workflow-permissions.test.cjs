const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const workflowsDir = path.join(root, '.github/workflows');

// Leitura por linha, sem parser de YAML: o bloco de nível superior é a linha
// que começa com `permissions:` sem indentação. Blocos de job são indentados.
function hasTopLevelPermissions(yamlText) {
  return yamlText.split(/\r?\n/).some((line) => /^permissions:/.test(line));
}

function listWorkflowFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => path.join(dir, name));
}

const workflows = listWorkflowFiles(workflowsDir);

test('há workflows para verificar', () => {
  assert.ok(workflows.length > 0, `nenhum workflow em ${workflowsDir}`);
});

for (const file of workflows) {
  test(`${path.basename(file)} declara permissions no nível superior`, () => {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(
      hasTopLevelPermissions(text),
      `${path.basename(file)} não tem bloco "permissions:" sem indentação no topo`,
    );
  });
}

test('detector ignora permissions indentado dentro de job', () => {
  const onlyJobLevel = ['name: x', 'jobs:', '  build:', '    permissions:', '      contents: read'].join(
    '\n',
  );
  assert.equal(hasTopLevelPermissions(onlyJobLevel), false);
});

test('detector aceita permissions no topo, em bloco ou como valor único', () => {
  assert.equal(hasTopLevelPermissions('name: x\npermissions:\n  contents: read\n'), true);
  assert.equal(hasTopLevelPermissions('name: x\npermissions: read-all\n'), true);
});
