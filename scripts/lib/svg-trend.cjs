// Gráfico de tendência em SVG puro (sem CDN, sem dependências). Uma série [{date, value}].

const WIDTH = 640;
const HEIGHT = 220;
const PAD = { top: 16, right: 24, bottom: 32, left: 48 };

const escapeXml = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

function domainOf(values) {
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  return { min: min - span * 0.1, max: max + span * 0.1 };
}

function renderTrendSvg(points, { title = 'Tendência', unit = '%' } = {}) {
  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeXml(title)}">`;
  const text = (x, y, value, anchor = 'start') =>
    `<text x="${x}" y="${y}" font-size="11" fill="#64748b" text-anchor="${anchor}">${escapeXml(value)}</text>`;
  if (points.length < 2) {
    return `${head}<title>${escapeXml(title)}</title>${text(PAD.left, HEIGHT / 2, 'sem dados suficientes para a tendência')}</svg>`;
  }
  const values = points.map((p) => p.value);
  const { min, max } = domainOf(values);
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i) => PAD.left + (points.length === 1 ? 0 : (i / (points.length - 1)) * innerW);
  const y = (v) => PAD.top + innerH - ((v - min) / (max - min)) * innerH;
  const coords = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`);
  const dots = points
    .map(
      (p, i) =>
        `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3" fill="#2563eb"><title>${escapeXml(p.date)}: ${escapeXml(p.value)}${escapeXml(unit)}</title></circle>`,
    )
    .join('');
  const axis = `<line x1="${PAD.left}" y1="${PAD.top + innerH}" x2="${WIDTH - PAD.right}" y2="${PAD.top + innerH}" stroke="#cbd5e1"/>`;
  const yLabels = [max, min]
    .map((v) => text(PAD.left - 6, y(v).toFixed(1), `${v.toFixed(1)}${unit}`, 'end'))
    .join('');
  const xLabels =
    text(PAD.left, HEIGHT - 10, points[0].date) +
    text(WIDTH - PAD.right, HEIGHT - 10, points[points.length - 1].date, 'end');
  return `${head}<title>${escapeXml(title)}</title>${axis}<polyline points="${coords.join(' ')}" fill="none" stroke="#2563eb" stroke-width="2"/>${dots}${yLabels}${xLabels}</svg>`;
}

module.exports = { escapeXml, renderTrendSvg };
