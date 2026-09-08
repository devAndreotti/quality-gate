// diff-coverage.cjs — calcula cobertura sobre linhas alteradas no git diff
const fs = require('node:fs');
const path = require('node:path');

function parseDiffLineNumbers(diffText) {
  const fileChanges = new Map();
  let currentFile = null;
  let currentLineNumber = 0;

  for (const line of String(diffText || '').split(/\r?\n/)) {
    const diffHeader = line.match(/^\+\+\+ b\/(.+)$/);
    if (diffHeader) {
      currentFile = diffHeader[1].replace(/\\/g, '/');
      if (!fileChanges.has(currentFile)) fileChanges.set(currentFile, new Set());
      continue;
    }

    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      currentLineNumber = parseInt(hunk[1], 10);
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (currentFile) fileChanges.get(currentFile).add(currentLineNumber);
      currentLineNumber++;
    } else if (!line.startsWith('-')) {
      currentLineNumber++;
    }
  }

  return fileChanges;
}

function parseLcovCoverageMap(lcovText) {
  const coverageMap = new Map();
  let currentFile = null;

  for (const line of String(lcovText || '').split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      currentFile = line.slice(3).trim().replace(/\\/g, '/');
      if (!coverageMap.has(currentFile)) coverageMap.set(currentFile, new Map());
      continue;
    }
    if (line.startsWith('DA:')) {
      const [lineNum, hits] = line.slice(3).split(',').map(Number);
      if (currentFile) coverageMap.get(currentFile).set(lineNum, hits);
    }
  }

  return coverageMap;
}

function calculateDiffCoverage({ diffText, lcovText, minDiffCoverage = 80 }) {
  const diffMap = parseDiffLineNumbers(diffText);
  const lcovMap = parseLcovCoverageMap(lcovText);

  let totalChangedExecutableLines = 0;
  let coveredChangedLines = 0;
  const details = [];

  for (const [diffFile, changedLines] of diffMap.entries()) {
    // Tenta casar nome de arquivo exato ou sufixo
    let fileCoverage = null;
    for (const [lcovFile, hitsMap] of lcovMap.entries()) {
      if (lcovFile === diffFile || lcovFile.endsWith(diffFile) || diffFile.endsWith(lcovFile)) {
        fileCoverage = hitsMap;
        break;
      }
    }

    if (!fileCoverage) continue;

    for (const lineNum of changedLines) {
      if (fileCoverage.has(lineNum)) {
        totalChangedExecutableLines++;
        const hits = fileCoverage.get(lineNum);
        if (hits > 0) {
          coveredChangedLines++;
        } else {
          details.push({ file: diffFile, line: lineNum, status: 'uncovered' });
        }
      }
    }
  }

  const pct = totalChangedExecutableLines === 0
    ? 100
    : Number(((coveredChangedLines / totalChangedExecutableLines) * 100).toFixed(2));

  return {
    pct,
    totalLines: totalChangedExecutableLines,
    coveredLines: coveredChangedLines,
    passed: pct >= minDiffCoverage,
    minDiffCoverage,
    uncovered: details,
  };
}

module.exports = {
  calculateDiffCoverage,
  parseDiffLineNumbers,
  parseLcovCoverageMap,
};