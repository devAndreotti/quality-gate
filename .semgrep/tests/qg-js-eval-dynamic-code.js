function load(src, body) {
  // ruleid: qg-js-eval-dynamic-code
  eval(src);
  // ruleid: qg-js-eval-dynamic-code
  const fn = new Function('a', body);
  // ok: qg-js-eval-dynamic-code
  const data = JSON.parse(src);
  // ok: qg-js-eval-dynamic-code
  const parser = { evaluate: (x) => x };
  parser.evaluate(src);
  return [fn, data];
}
module.exports = { load };
