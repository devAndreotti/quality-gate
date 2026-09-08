const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { collectScriptFiles, checkSyntax, writeEmptyEslintReport } = require("./check-syntax.cjs");

test("collectScriptFiles returns JS and CJS files below scripts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qg-syntax-"));
  fs.mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts/a.cjs"), "module.exports = {};\n");
  fs.writeFileSync(path.join(root, "scripts/lib/b.js"), "console.log(\"ok\");\n");
  fs.writeFileSync(path.join(root, "scripts/readme.txt"), "ignore\n");

  const files = collectScriptFiles(root).map((file) => path.relative(root, file).replace(/\\/g, "/"));

  assert.deepEqual(files, ["scripts/a.cjs", "scripts/lib/b.js"]);
});

test("writeEmptyEslintReport creates empty array JSON in coverage dir", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qg-syntax-"));
  writeEmptyEslintReport(root);
  const report = JSON.parse(fs.readFileSync(path.join(root, "coverage/eslint-report.json"), "utf8"));
  assert.deepEqual(report, []);
});

test("checkSyntax passes on valid scripts and catches invalid syntax", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qg-syntax-"));
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
