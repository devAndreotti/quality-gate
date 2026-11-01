// Alertas de code scanning (Semgrep, CodeQL...) de um repositório. Somente leitura, via gh.
// Sem permissão ou sem code scanning habilitado, devolve null (indisponível), nunca lança.

const SEVERITY_FROM_RULE = { error: 'high', warning: 'medium', note: 'low' };

function normalizeSeverity(securityLevel, ruleSeverity) {
  if (securityLevel) return String(securityLevel).toLowerCase();
  return SEVERITY_FROM_RULE[String(ruleSeverity || '').toLowerCase()] || 'none';
}

function parseAlertLines(text) {
  return String(text || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [tool, securityLevel, ruleSeverity, ruleId, number, createdAt] = line.split('\t');
      return {
        tool: tool || 'desconhecida',
        severity: normalizeSeverity(securityLevel, ruleSeverity),
        rule: ruleId || '',
        number: Number(number) || 0,
        createdAt: createdAt || '',
      };
    });
}

function fetchCodeScanningAlerts(full, exec) {
  const jq =
    '.[] | [.tool.name, (.rule.security_severity_level // ""), (.rule.severity // ""), .rule.id, (.number|tostring), .created_at] | @tsv';
  try {
    const out = exec('gh', [
      'api',
      '--paginate',
      `repos/${full}/code-scanning/alerts?state=open&per_page=100`,
      '--jq',
      jq,
    ]);
    return parseAlertLines(out);
  } catch {
    return null;
  }
}

const TOP_OLDEST = 10;

function summarizeAlerts(alerts) {
  if (!alerts) return null;
  const byTool = {};
  for (const alert of alerts) {
    if (!byTool[alert.tool]) byTool[alert.tool] = { total: 0, bySeverity: {}, oldest: [] };
    const group = byTool[alert.tool];
    group.total++;
    group.bySeverity[alert.severity] = (group.bySeverity[alert.severity] || 0) + 1;
    group.oldest.push(alert);
  }
  for (const group of Object.values(byTool)) {
    group.oldest = group.oldest.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, TOP_OLDEST);
  }
  return { total: alerts.length, byTool };
}

module.exports = { fetchCodeScanningAlerts, normalizeSeverity, parseAlertLines, summarizeAlerts };
