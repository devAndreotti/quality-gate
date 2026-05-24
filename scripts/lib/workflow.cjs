function unquote(value) {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function parseWorkflowJobNames(workflowText) {
  const jobs = [];
  let inJobs = false;
  let current = null;

  for (const line of workflowText.split(/\r?\n/)) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;

    if (/^\S/.test(line) && line.trim() && !line.trim().startsWith('#')) break;

    const jobMatch = line.match(/^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$/);
    if (jobMatch) {
      current = { id: jobMatch[1], name: null };
      jobs.push(current);
      continue;
    }

    const nameMatch = line.match(/^    name:\s*(.+?)\s*$/);
    if (current && nameMatch) {
      current.name = unquote(nameMatch[1].replace(/\s+#.*$/, ''));
    }
  }

  return jobs.map((job) => job.name || job.id);
}

function parseStringArrayBody(arrayBody) {
  const contexts = [];
  const stringPattern = /['"]([^'"]+)['"]/g;
  let stringMatch;
  while ((stringMatch = stringPattern.exec(arrayBody)) !== null) {
    contexts.push(stringMatch[1]);
  }
  return contexts;
}

function parseSetupRequiredContexts(setupText) {
  const match = setupText.match(/contexts:\s*\[([\s\S]*?)\]/m);
  if (match) return parseStringArrayBody(match[1]);

  const variableMatch = setupText.match(/contexts:\s*([A-Z0-9_]+)\s*,/m);
  if (!variableMatch) {
    const defaultMatch = setupText.match(/const\s+DEFAULT_REQUIRED_STATUS_CHECKS\s*=\s*\[([\s\S]*?)\]/m);
    return defaultMatch ? parseStringArrayBody(defaultMatch[1]) : [];
  }

  const variableName = variableMatch[1];
  const arrayMatch = setupText.match(new RegExp(`const\\s+${variableName}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm'))
    || setupText.match(new RegExp(`const\\s+DEFAULT_${variableName}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm'))
    || setupText.match(/const\s+DEFAULT_REQUIRED_STATUS_CHECKS\s*=\s*\[([\s\S]*?)\]/m);
  if (!arrayMatch) return [];

  return parseStringArrayBody(arrayMatch[1]);
}

function findMissingRequiredContexts(requiredContexts, workflowJobNames) {
  const available = new Set(workflowJobNames);
  return requiredContexts.filter((context) => !available.has(context));
}

module.exports = {
  findMissingRequiredContexts,
  parseSetupRequiredContexts,
  parseWorkflowJobNames,
};
