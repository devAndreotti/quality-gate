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
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&lt;x&gt;/);
});
