const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchCodeScanningAlerts,
  normalizeSeverity,
  parseAlertLines,
  summarizeAlerts,
} = require('./code-alerts.cjs');

test('normalizeSeverity prefers security level and maps code-quality levels', () => {
  assert.equal(normalizeSeverity('CRITICAL', ''), 'critical');
  assert.equal(normalizeSeverity('', 'error'), 'high');
  assert.equal(normalizeSeverity('', 'warning'), 'medium');
  assert.equal(normalizeSeverity('', 'note'), 'low');
  assert.equal(normalizeSeverity('', ''), 'none');
});

test('parseAlertLines reads tab separated rows and ignores blank lines', () => {
  const rows = parseAlertLines(
    'semgrep\thigh\t\trule.a\t7\t2026-01-02T00:00:00Z\n\ncodeql\t\twarning\trule.b\t8\t2026-01-01T00:00:00Z\n',
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    tool: 'semgrep',
    severity: 'high',
    rule: 'rule.a',
    number: 7,
    createdAt: '2026-01-02T00:00:00Z',
  });
  assert.equal(rows[1].severity, 'medium');
});

test('parseAlertLines fills defaults for missing fields', () => {
  const [row] = parseAlertLines('\t\t\t\t\t');
  assert.equal(row.tool, 'desconhecida');
  assert.equal(row.severity, 'none');
  assert.equal(row.number, 0);
});

test('fetchCodeScanningAlerts calls gh api with pagination and parses the result', () => {
  const calls = [];
  const alerts = fetchCodeScanningAlerts('o/r', (file, args) => {
    calls.push([file, args]);
    return 'semgrep\thigh\t\tr1\t1\t2026-01-01T00:00:00Z';
  });
  assert.equal(calls[0][0], 'gh');
  assert.ok(calls[0][1].includes('--paginate'));
  assert.ok(calls[0][1].some((a) => a.startsWith('repos/o/r/code-scanning/alerts?state=open')));
  assert.equal(alerts.length, 1);
});

test('fetchCodeScanningAlerts returns null when gh fails (no permission or disabled)', () => {
  const alerts = fetchCodeScanningAlerts('o/r', () => {
    throw new Error('403');
  });
  assert.equal(alerts, null);
});

test('summarizeAlerts groups by tool, counts severities and keeps the 10 oldest', () => {
  const alerts = Array.from({ length: 12 }, (_, i) => ({
    tool: 'semgrep',
    severity: i % 2 ? 'high' : 'low',
    rule: `r${i}`,
    number: i,
    createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
  }));
  alerts.push({
    tool: 'codeql',
    severity: 'critical',
    rule: 'c',
    number: 99,
    createdAt: '2025-12-31T00:00:00Z',
  });
  const s = summarizeAlerts(alerts);
  assert.equal(s.total, 13);
  assert.equal(s.byTool.semgrep.total, 12);
  assert.equal(s.byTool.semgrep.oldest.length, 10);
  assert.equal(s.byTool.semgrep.oldest[0].number, 0);
  assert.equal(s.byTool.codeql.bySeverity.critical, 1);
});

test('summarizeAlerts returns null when alerts are unavailable', () => {
  assert.equal(summarizeAlerts(null), null);
});
