// Exercise quote checks and the drafting boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countsIn, numbersIn, verifyQuotes } from './verify-quotes.ts';
import { draftLines } from './draft-lines.ts';
import { DEMO_CASES } from './demo-cases.ts';
import { OPENROUTER_URL, routeClaudeToSession, testEndpoint, TEST_MODELS } from './model-endpoint.ts';
import type { Endpoint } from './model-endpoint.ts';

const STUB_KEY = 'stub';
const inputs = { log: 'Start Work  2 hours. Work  2 hours.', prices: 'Start Rate USD 50.00' };
const line = { description: 'Work', quantity: '2', rate: '50', work_quote: 'Work  2 hours.', price_quote: 'Rate USD 50.00' };

test('checks exact quotes and rejection reasons', () => {
  assert.deepEqual(verifyQuotes(inputs, [line])[0], { status: 'accepted', line, work_offset: 6, price_offset: 6 });
  const cases: [unknown, string][] = [
    [null, 'MALFORMED_LINE'], [{ ...line, rate: '1 USD' }, 'MALFORMED_LINE'],
    [{ ...line, work_quote: ' ' }, 'EMPTY_QUOTE'],
    [{ ...line, work_quote: line.price_quote }, 'WORK_QUOTE_NOT_FOUND'],
    [{ ...line, work_quote: 'Work 2 hours.' }, 'WORK_QUOTE_NOT_FOUND'],
    [{ ...line, price_quote: line.work_quote }, 'PRICE_QUOTE_NOT_FOUND'],
    [{ ...line, quantity: '3' }, 'QUANTITY_NOT_IN_WORK_QUOTE'],
    [{ ...line, rate: '75' }, 'RATE_NOT_IN_PRICE_QUOTE'],
    [{ ...line, work_quote: '2 hours.\nWork' }, 'QUOTE_SPANS_LINES'],
  ];
  for (const [candidate, reason] of cases) assert.deepEqual(verifyQuotes(inputs, [candidate])[0], { status: 'rejected', line: candidate, reason });
});

test('one stretch of the work log supports one line', () => {
  // The log holds the quoted words twice, so two lines pass (each on its own occurrence) and a third is refused.
  const results = verifyQuotes(inputs, [line, line, line]);
  assert.deepEqual(results.map(result => result.status === 'accepted' ? result.work_offset : result.reason), [6, 21, 'WORK_QUOTE_REUSED']);
  // A longer quote that covers words an accepted line already used is refused as well.
  assert.equal((verifyQuotes(inputs, [line, { ...line, work_quote: 'Start Work  2 hours.' }])[1] as { reason: string }).reason, 'WORK_QUOTE_REUSED');
  // A quote that crosses a line break is refused even when the pasted text contains it.
  assert.equal((verifyQuotes({ log: 'Mon 2 hours\nTue 3 hours', prices: inputs.prices }, [{ ...line, work_quote: '2 hours\nTue 3' }])[0] as { reason: string }).reason, 'QUOTE_SPANS_LINES');
});

test('canonicalises numbers without floating point', () => {
  assert.deepEqual(numbersIn('50.00 50 050 1,200.50 1.5'), ['50', '50', '50', '1200.5', '1.5']);
});

test('sends inputs and parses model lines and cost', async () => {
  const stub: typeof fetch = async (url, init) => {
    assert.equal(url, OPENROUTER_URL);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'test-model'); assert.equal(body.temperature, 0);
    assert.deepEqual(body.response_format, { type: 'json_object' }); assert.deepEqual(body.usage, { include: true });
    assert.ok(body.messages[1].content.includes(inputs.log)); assert.ok(body.messages[1].content.includes(inputs.prices));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ lines: [line] }) } }], usage: { cost: 0.01 } });
  };
  assert.deepEqual(await draftLines(inputs, { apiKey: STUB_KEY, model: 'test-model', fetch: stub }), { lines: [line], model: 'test-model', cost_usd: 0.01 });
});

test('reports safe errors without making a call for a missing key', async () => {
  const key = 'secret-key'; let calls = 0;
  const stub: typeof fetch = async () => { calls++; return new Response('', { status: 500 }); };
  for (const [fetcher, expected] of [[stub, 'MODEL_HTTP_500'], [async () => Response.json({ choices: [{ message: { content: 'prose' } }] }), 'MODEL_OUTPUT_NOT_JSON'], [async () => { throw new Error(key); }, 'MODEL_REQUEST_FAILED']] as [typeof fetch, string][]) {
    await assert.rejects(draftLines(inputs, { apiKey: key, fetch: fetcher }), (error: Error) => error.message === expected && !error.message.includes(key));
  }
  const before = calls;
  await assert.rejects(draftLines(inputs, { apiKey: '', fetch: stub }), { message: 'MISSING_API_KEY' });
  assert.equal(calls, before);
});

// Live runs use the test proxy only, never OpenRouter (model-endpoint.ts).
const LIVE = process.env.INVOICEPROOF_LIVE_MODEL ? testEndpoint() : 'set INVOICEPROOF_LIVE_MODEL=1 to run live model tests (test proxy only)';
if (typeof LIVE !== 'string') routeClaudeToSession(LIVE);
for (const demo of DEMO_CASES) {
  test(`live ${demo.id}`, { skip: typeof LIVE === 'string' ? LIVE : false }, async (t) => {
    const result = await draftLines(demo, { endpoint: LIVE as Endpoint, model: process.env.INVOICEPROOF_MODEL ?? TEST_MODELS.draft });
    const checked = verifyQuotes(demo, result.lines);
    const accepted = checked.filter((item) => item.status === 'accepted');
    for (const item of checked) {
      const draft = item.line as typeof line;
      t.diagnostic(`${item.status} ${item.status === 'rejected' ? item.reason : 'ok'} | ${draft?.description} | qty ${draft?.quantity} | rate ${draft?.rate}`);
    }
    t.diagnostic(`model=${result.model} cost_usd=${result.cost_usd}`);
    assert.ok(accepted.length > 0);
    for (const item of accepted) {
      assert.equal(demo.log.slice(item.work_offset, item.work_offset + item.line.work_quote.length), item.line.work_quote);
      assert.equal(demo.prices.slice(item.price_offset, item.price_offset + item.line.price_quote.length), item.line.price_quote);
    }
  });
}

test('reads count words, never "a"/"an", and a flat price as one delivery', () => {
  assert.deepEqual(countsIn('two hours, a call, an edit'), ['2']);
  // A rate is read from digits only: "minimum one hour" never makes 1 a rate.
  assert.deepEqual(numbersIn('Design: USD 50 per hour, minimum one hour'), ['50']);
  const minimum = { log: 'Mon: 1 hour of design', prices: 'Design: USD 50 per hour, minimum one hour' };
  assert.equal(verifyQuotes(minimum, [{ description: 'Design', quantity: '1', rate: '1', work_quote: '1 hour of design', price_quote: 'Design: USD 50 per hour, minimum one hour' }])[0]!.status, 'rejected');
  const words = { log: 'Mon: two hours of copy editing', prices: 'Copy editing: USD 40.00 per hour' };
  assert.equal(verifyQuotes(words, [{ description: 'Copy', quantity: '2', rate: '40', work_quote: 'two hours of copy editing', price_quote: 'Copy editing: USD 40.00 per hour' }])[0]!.status, 'accepted');
  const flat = { log: 'Thu: delivered the logo package\nFri: worked on the site', prices: 'Logo package: USD 400.00 fixed price\nDesign: USD 50.00 per hour' };
  const logo = { description: 'Logo', quantity: '1', rate: '400', work_quote: 'delivered the logo package', price_quote: 'Logo package: USD 400.00 fixed price' };
  assert.equal(verifyQuotes(flat, [logo])[0]!.status, 'accepted');
  // No count in the work and a per-unit price: one hour would be invented, so it stays blocked.
  assert.deepEqual(verifyQuotes(flat, [{ description: 'Site', quantity: '1', rate: '50', work_quote: 'worked on the site', price_quote: 'Design: USD 50.00 per hour' }])[0], { status: 'rejected', line: { description: 'Site', quantity: '1', rate: '50', work_quote: 'worked on the site', price_quote: 'Design: USD 50.00 per hour' }, reason: 'QUANTITY_NOT_IN_WORK_QUOTE' });
  assert.equal(verifyQuotes(flat, [{ ...logo, quantity: '2' }])[0]!.status, 'rejected');
});

test('asks once more for an unparseable reply and reads a fenced one', async () => {
  let calls = 0;
  const flaky: typeof fetch = async () => Response.json({ choices: [{ message: { content: ++calls === 1 ? 'prose' : '```json\n{"lines":[]}\n```' } }], usage: { cost: calls === 1 ? 0.25 : 0.5 } });
  const retried = await draftLines(inputs, { apiKey: STUB_KEY, fetch: flaky });
  assert.deepEqual(retried.lines, []);
  assert.equal(calls, 2);
  assert.equal(retried.cost_usd, 0.75, 'the unparseable reply was paid for too');
  let failing = 0;
  await assert.rejects(draftLines(inputs, { apiKey: STUB_KEY, fetch: async () => { failing++; return new Response('', { status: 500 }); } }), { message: 'MODEL_HTTP_500' });
  assert.equal(failing, 1, 'an HTTP failure is not retried');
});
