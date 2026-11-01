// Histórico de métricas do projeto em JSON Lines. Um snapshot por dia e commit.
// Linhas corrompidas são ignoradas, nunca quebram a leitura.

const fs = require('node:fs');
const path = require('node:path');

function makeSnapshot({ date, commit, coverage, codeScanningOpen, dependabotOpen }) {
  return {
    date: String(date).slice(0, 10),
    commit: String(commit || '').slice(0, 12),
    coverage: typeof coverage === 'number' ? coverage : null,
    codeScanningOpen: typeof codeScanningOpen === 'number' ? codeScanningOpen : null,
    dependabotOpen: typeof dependabotOpen === 'number' ? dependabotOpen : null,
  };
}

function readSnapshots(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const obj = JSON.parse(line);
        return obj && typeof obj === 'object' && typeof obj.date === 'string' ? [obj] : [];
      } catch {
        return [];
      }
    });
}

// Adiciona o snapshot se não existir outro do mesmo dia e commit. Devolve { added }.
function appendSnapshot(file, snapshot) {
  const existing = readSnapshots(file);
  const duplicate = existing.some((s) => s.date === snapshot.date && s.commit === snapshot.commit);
  if (duplicate) return { added: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(snapshot) + '\n');
  return { added: true };
}

// Série de uma métrica, ordenada por data, sem valores ausentes.
function series(snapshots, key) {
  return snapshots
    .filter((s) => typeof s[key] === 'number')
    .map((s) => ({ date: s.date, value: s[key] }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = { appendSnapshot, makeSnapshot, readSnapshots, series };
