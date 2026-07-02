// Unit tests for the hardened grounding validator — exercises the Codex-flagged cases.
import { buildSourceIndex, isGrounded, groundData } from '../dist/extract.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL:', name); } };

// --- Codex MAJOR #1: digit-concatenation false-keep ---
{
  const src = buildSourceIndex('Order 12 and item 34 shipped. Price £51.77. Built in 1931.');
  ok('invented 1234 NOT grounded (12+34 must not vouch)', isGrounded(1234, src) === false);
  ok('real number 12 grounded', isGrounded(12, src) === true);
  ok('single-digit 3 not falsely grounded', isGrounded(3, src) === false);
  ok('price "£51.77" grounded via number token', isGrounded('£51.77', src) === true);
  ok('year 1931 grounded', isGrounded(1931, src) === true);
  ok('invented year 1879 NOT grounded', isGrounded(1879, src) === false);
}
// --- Codex MAJOR #2: repeated-token gaming ---
{
  const src = buildSourceIndex('The alpha protocol document describes systems.');
  ok('repeated-token gaming rejected', isGrounded('alpha alpha alpha alpha invented invented', src) === false);
  ok('genuine paraphrase (>=60% real tokens) kept', isGrounded('document describes alpha systems protocol', src) === true);
}
// --- Codex MAJOR #3: booleans pass through (documented) ---
{
  const src = buildSourceIndex('nothing relevant here');
  const nulled = [];
  const out = groundData({ flag: true, missing: 'zzdefinitelynotonpage' }, src, '', nulled);
  ok('boolean passes through', out.flag === true);
  ok('invented string nulled', out.missing === null && nulled.includes('missing'));
}
// --- Codex MAJOR #4: prototype pollution ---
{
  const src = buildSourceIndex('safe content');
  const malicious = JSON.parse('{"__proto__":{"polluted":1},"safe":"content"}');
  const out = groundData(malicious, src, '', []);
  ok('no prototype pollution', ({}).polluted === undefined);
  ok('dangerous key dropped from output', out.__proto__ === Object.prototype || !Object.prototype.hasOwnProperty.call(out, 'polluted'));
  ok('safe key preserved + grounded', out.safe === 'content');
}
// --- Codex MAJOR #5: deep nesting does not crash ---
{
  const src = buildSourceIndex('content');
  let deep = 'x';
  for (let i = 0; i < 200; i++) deep = { nested: deep };
  let crashed = false;
  try { groundData(deep, src, '', []); } catch { crashed = true; }
  ok('deep nesting does not crash', crashed === false);
}
// --- Codex MINOR #6: unicode/accent ---
{
  const src = buildSourceIndex('We met at the Café in München for B2B talks.');
  ok('deaccented "cafe" grounded against "Café"', isGrounded('cafe', src) === true);
  ok('"münchen" grounded', isGrounded('münchen', src) === true);
}
// --- regression: real on-page date kept, invented date nulled ---
{
  const src = buildSourceIndex('Last updated April 2023. Topic: web scraping.');
  ok('on-page "April 2023" kept', isGrounded('April 2023', src) === true);
  const src2 = buildSourceIndex('Topic: web scraping. No date here. References to 2023 archive.');
  ok('invented "April 2023" nulled when phrase absent', isGrounded('April 2023', src2) === false);
}

// --- S15: absence sentinels → JSON null (always-on, pre-grounding) ---
{
  const { normalizeAbsenceSentinels } = await import('../dist/extract.js');
  const out = normalizeAbsenceSentinels({
    a: 'null', b: 'N/A', e: '', f: 'Not specified',
    keep1: 'none of the above', keep2: 'nullable field docs', keep3: 0, keep4: false,
    keepNone: 'None', keepUnknown: 'unknown', keepNa: 'Na',
    nested: { g: 'n/a', arr: ['real value', 'not found'] },
  });
  ok('sentinel "null" → null', out.a === null);
  ok('sentinel "N/A" → null (case-insensitive)', out.b === null);
  ok('empty string → null', out.e === null);
  ok('sentinel "Not specified" → null', out.f === null);
  ok('non-sentinel phrase kept', out.keep1 === 'none of the above');
  ok('non-sentinel containing word kept', out.keep2 === 'nullable field docs');
  ok('number 0 passes through untouched (not a string sentinel)', out.keep3 === 0);
  ok('boolean passes through', out.keep4 === false);
  ok('high-collision "None" KEPT (Codex/Kimi gate)', out.keepNone === 'None');
  ok('high-collision "unknown" KEPT', out.keepUnknown === 'unknown');
  ok('high-collision "Na" KEPT (sodium!)', out.keepNa === 'Na');
  ok('nested sentinel → null', out.nested.g === null);
  ok('array: real kept, sentinel → null', out.nested.arr[0] === 'real value' && out.nested.arr[1] === null);
  // prototype pollution + depth safety (same bar as groundData)
  const malicious = JSON.parse('{"__proto__":{"polluted2":1},"safe":"null"}');
  const m = normalizeAbsenceSentinels(malicious);
  ok('sentinel-normalizer: no prototype pollution', ({}).polluted2 === undefined && m.safe === null);
  let deep = 'null';
  for (let i = 0; i < 200; i++) deep = { nested: deep };
  let crashed = false;
  try { normalizeAbsenceSentinels(deep); } catch { crashed = true; }
  ok('sentinel-normalizer: deep nesting does not crash', crashed === false);
}

// --- S15: nullableSchema — enforced grammar must always permit null ---
{
  const { nullableSchema } = await import('../dist/extract.js');
  const orig = { type: 'object', properties: {
    n: { type: 'number', description: 'd' },
    s: { type: 'string' },
    already: { type: ['string', 'null'] },
    e: { type: 'string', enum: ['a', 'b'] },
    nested: { type: 'object', properties: { deep: { type: 'number' } } },
    arr: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' } } } },
  }, required: ['n'] };
  const w = nullableSchema(orig);
  ok('number widened to [number,null]', JSON.stringify(w.properties.n.type) === '["number","null"]');
  ok('description preserved', w.properties.n.description === 'd');
  ok('string widened', JSON.stringify(w.properties.s.type) === '["string","null"]');
  ok('already-nullable untouched', JSON.stringify(w.properties.already.type) === '["string","null"]');
  ok('enum property NOT widened', JSON.stringify(w.properties.e.type) === '"string"');
  ok('nested object property widened', JSON.stringify(w.properties.nested.properties.deep.type) === '["number","null"]');
  ok('array items widened', JSON.stringify(w.properties.arr.items.properties.x.type) === '["number","null"]');
  ok('required list preserved', JSON.stringify(w.required) === '["n"]');
  ok('original schema NOT mutated', orig.properties.n.type === 'number');
  ok('non-object passthrough', nullableSchema('x') === 'x' && nullableSchema(null) === null);
  // Codex-gate additions: $defs / definitions / additionalProperties reachability
  const w2 = nullableSchema({ type: 'object',
    properties: { price: { $ref: '#/$defs/money' } },
    additionalProperties: { type: 'number' },
    $defs: { money: { type: 'number' }, obj: { type: 'object', properties: { d: { type: 'string' } } } },
    definitions: { legacy: { type: 'string' } } });
  ok('$ref property left untouched', JSON.stringify(w2.properties.price) === '{"$ref":"#/$defs/money"}');
  ok('bare-leaf $defs target widened', JSON.stringify(w2.$defs.money.type) === '["number","null"]');
  ok('$defs nested object properties widened', JSON.stringify(w2.$defs.obj.properties.d.type) === '["string","null"]');
  ok('definitions widened too', JSON.stringify(w2.definitions.legacy.type) === '["string","null"]');
  ok('additionalProperties schema widened', JSON.stringify(w2.additionalProperties.type) === '["number","null"]');
}

console.log(`\nground_unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
