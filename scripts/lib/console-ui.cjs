// Pequeno kit de UI de console compartilhado (quality-gate.js e doctor.cjs), no mesmo
// estilo visual do wrapper PowerShell (QualityGate.ps1) — caixa com icone+titulo,
// secoes maiusculas com separador, colunas alinhadas por largura real do conteudo.
function displayWidth(value) {
  const str = String(value);
  let width = 0;
  for (const char of str) {
    const codePoint = char.codePointAt(0);
    if (codePoint === 0xfe0f) continue;
    const isPictograph = codePoint >= 0x1f300 && codePoint <= 0x1faff;
    const isDingbat = codePoint >= 0x2600 && codePoint <= 0x27bf;
    const isMiscSymbolArrow = codePoint >= 0x2b00 && codePoint <= 0x2bff;
    if (isPictograph || isDingbat || isMiscSymbolArrow) {
      width += 2;
      continue;
    }
    width += 1;
  }
  return width;
}

function padEnd(value, width) {
  const str = String(value);
  const visible = displayWidth(str);
  return visible >= width ? str : str + ' '.repeat(width - visible);
}

function renderTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(displayWidth(header), ...rows.map((line) => displayWidth(line[index]))),
  );
  const renderRow = (cells) => `│ ${cells.map((cell, index) => padEnd(cell, widths[index])).join(' │ ')} │`;
  const separator = (left, mid, right) => `${left}${widths.map((w) => '─'.repeat(w + 2)).join(mid)}${right}`;
  return [
    separator('┌', '┬', '┐'),
    renderRow(headers),
    separator('├', '┼', '┤'),
    ...rows.map(renderRow),
    separator('└', '┴', '┘'),
  ].join('\n');
}

function renderHeaderBox(title, { icon = '◆', right = '', width = 60 } = {}) {
  const left = ` ${icon} ${title}`;
  const pad = Math.max(1, width - displayWidth(left) - displayWidth(right));
  const line = left + ' '.repeat(pad) + right;
  const tailPad = Math.max(0, width - displayWidth(line));
  const filled = line + ' '.repeat(tailPad);
  return [
    `  ╭${'─'.repeat(width)}╮`,
    `  │${filled}│`,
    `  ╰${'─'.repeat(width)}╯`,
  ].join('\n');
}

function renderSection(title, icon = '◆') {
  return [
    `  ${icon} ${title.toUpperCase()}`,
    `  ${'─'.repeat(60)}`,
  ].join('\n');
}

module.exports = { displayWidth, padEnd, renderTable, renderHeaderBox, renderSection };
