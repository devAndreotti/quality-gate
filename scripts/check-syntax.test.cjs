const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const { collectScriptFiles, checkSyntax, writeEslintReport, resolveEslintBin } = require("./check-syntax.cjs");

const ESLINT_CONFIG = "module.exports = [{ files: [\"**/*.cjs\"], rules: { \"no-unused-vars\": \"error\" } }];\n";
const eslintAvailable = Boolean(resolveEslintBin(__dirname));

// Nome aleatorio (mkdtemp) para ser unico; removido em after() para nao sobrar em os.tmpdir().
const tempRoots = [];
after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qg-syntax-"));
  tempRoots.push(root);
  return root;
}

function readReport(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "coverage/eslint-report.json"), "utf8"));
}

test("collectScriptFiles returns JS and CJS files below scripts", () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts/a.cjs"), "module.exports = {};\n");
  fs.writeFileSync(path.join(root, "scripts/lib/b.js"), "console.log(\"ok\");\n");
  fs.writeFileSync(path.join(root, "scripts/readme.txt"), "ignore\n");

  const files = collectScriptFiles(root).map((file) => path.relative(root, file).replace(/\\/g, "/"));

  assert.deepEqual(files, ["scripts/a.cjs", "scripts/lib/b.js"]);
});

test("writeEslintReport writes the real ESLint result, not an empty array", { skip: eslintAvailable ? false : "eslint não instalado neste ambiente" }, () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "eslint.config.js"), ESLINT_CONFIG);
  fs.writeFileSync(path.join(root, "scripts/bad.cjs"), "const unused = 1;\nmodule.exports = {};\n");

  writeEslintReport(root, { files: [path.join(root, "scripts/bad.cjs")] });

  const report = readReport(root);
  assert.notDeepEqual(report, []);
  assert.ok(Array.isArray(report), "real report is ESLint JSON output (an array of results)");
  const entry = report.find((item) => item.filePath.endsWith("scripts/bad.cjs"));
  assert.ok(entry, "report has an entry for the file with the violation");
  assert.ok(entry.messages.some((message) => message.ruleId === "no-unused-vars"));
});

test("writeEslintReport writes skipped object, never [], when eslint is not installed", () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, "eslint.config.js"), ESLINT_CONFIG);

  writeEslintReport(root, { files: [], eslintBin: null });

  const report = readReport(root);
  assert.notDeepEqual(report, []);
  assert.deepEqual(report, { status: "skipped", reason: "eslint não instalado" });
});

test("writeEslintReport writes skipped object, never [], when eslint.config.js is missing", () => {
  const root = tempRoot();

  writeEslintReport(root, { files: [], eslintBin: "/unused/eslint.js" });

  const report = readReport(root);
  assert.notDeepEqual(report, []);
  assert.equal(report.status, "skipped");
  assert.match(report.reason, /eslint\.config\.js/);
});

test("checkSyntax passes on valid scripts and catches invalid syntax", () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts/valid.cjs"), "const x = 1; module.exports = { x };\n");

  const passedResult = checkSyntax(root);
  assert.equal(passedResult.status, "passed");
  assert.equal(passedResult.failures.length, 0);

  fs.writeFileSync(path.join(root, "scripts/broken.cjs"), "const broken = ;\n");
  const failedResult = checkSyntax(root);
  assert.equal(failedResult.status, "failed");
  assert.equal(failedResult.failures.length, 1);
  assert.match(failedResult.failures[0].file, /broken\.cjs/);
});
