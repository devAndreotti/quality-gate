const { test } = require('node:test');
const assert = require('node:assert/strict');
const { escapeXml, renderTrendSvg } = require('./lib/svg-trend.cjs');

const series = [
  { date: '2026-11-01', value: 90 },
  { date: '2026-11-02', value: 91.5 },
  { date: '2026-11-03', value: 92 },
];

test('escapeXml escapes markup characters', () => {
  assert.equal(escapeXml(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeXml(null), '');
});

test('renderTrendSvg draws one polyline point and one dot per value', () => {
  const svg = renderTrendSvg(series, { title: 'Cobertura' });
  assert.match(svg, /^<svg /);
  const points = svg.match(/points="([^"]+)"/)[1].split(' ');
  assert.equal(points.length, 3);
  assert.equal((svg.match(/<circle /g) || []).length, 3);
  assert.match(svg, /<title>Cobertura<\/title>/);
});

test('renderTrendSvg labels the axis extremes with the unit and the date range', () => {
  const svg = renderTrendSvg(series);
  assert.match(svg, />2026-11-01</);
  assert.match(svg, />2026-11-03</);
  assert.match(svg, /%<\/text>/);
});

test('renderTrendSvg handles a flat series without dividing by zero', () => {
  const svg = renderTrendSvg([
    { date: '2026-11-01', value: 80 },
    { date: '2026-11-02', value: 80 },
  ]);
  assert.doesNotMatch(svg, /NaN/);
});

test('renderTrendSvg shows a message with fewer than two points', () => {
  const svg = renderTrendSvg([{ date: '2026-11-01', value: 80 }]);
  assert.match(svg, /sem dados suficientes/);
  assert.doesNotMatch(svg, /<polyline/);
});

test('renderTrendSvg escapes the title and the dates', () => {
  const svg = renderTrendSvg(
    [
      { date: '<x>', value: 1 },
      { date: 'y', value: 2 },
    ],
    { title: '<script>' },
  );
  assert.equal(svg.includes('<script>'), false);
  assert.match(svg, /&lt;x&gt;/);
});

test('renderTrendSvg places points, axis and labels at exact coordinates', () => {
  const svg = renderTrendSvg(series, { title: 'Cobertura', unit: '%' });
  assert.match(svg, /<polyline points="48\.0,173\.7 332\.0,66\.2 616\.0,30\.3" /);
  assert.match(svg, /<line x1="48" y1="188" x2="616" y2="188" /);
  assert.match(svg, /<text x="42" y="16\.0" font-size="11" fill="#64748b" text-anchor="end">92\.2%<\/text>/);
  assert.match(svg, /<text x="42" y="188\.0" font-size="11" fill="#64748b" text-anchor="end">89\.8%<\/text>/);
  assert.match(
    svg,
    /<text x="48" y="210" font-size="11" fill="#64748b" text-anchor="start">2026-11-01<\/text>/,
  );
  assert.match(
    svg,
    /<text x="616" y="210" font-size="11" fill="#64748b" text-anchor="end">2026-11-03<\/text>/,
  );
});

test('renderTrendSvg pads the domain by 10% of the span on each side', () => {
  const svg = renderTrendSvg([
    { date: '2026-11-01', value: 10 },
    { date: '2026-11-02', value: 20 },
  ]);
  assert.match(svg, />21\.0%<\/text>/);
  assert.match(svg, />9\.0%<\/text>/);
});

test('renderTrendSvg widens a flat series by one unit on each side', () => {
  const svg = renderTrendSvg([
    { date: '2026-11-01', value: 80 },
    { date: '2026-11-02', value: 80 },
  ]);
  assert.match(svg, />81\.2%<\/text>/);
  assert.match(svg, />78\.8%<\/text>/);
});

test('renderTrendSvg uses Tendência and % as defaults', () => {
  const svg = renderTrendSvg(series);
  assert.match(svg, /aria-label="Tendência"/);
  assert.match(svg, /<title>Tendência<\/title>/);
  assert.match(svg, /<title>2026-11-01: 90%<\/title>/);
});

test('renderTrendSvg writes no stray text between dots or labels', () => {
  const svg = renderTrendSvg(series);
  assert.doesNotMatch(svg, /<\/circle>[^<]/);
  assert.doesNotMatch(svg, /<\/text>[^<]/);
});

test('renderTrendSvg puts the no-data message at the vertical middle, start-anchored', () => {
  const svg = renderTrendSvg([]);
  assert.match(
    svg,
    /<text x="48" y="110" font-size="11" fill="#64748b" text-anchor="start">sem dados suficientes para a tendência<\/text>/,
  );
});
