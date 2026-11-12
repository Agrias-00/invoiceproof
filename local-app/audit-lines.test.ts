import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditLines, sourceLine } from './audit-lines.ts';

const line = { description: 'Design', quantity: '2', rate: '50', work_quote: '2 hours design', price_quote: 'Design USD 50 per hour' };
const reply = (value: unknown) => (async () => new Response(JSON.stringify({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }), { status: 200 })) as typeof fetch;
test('preserves supplied line count and parses both verdicts', async () => {
  const result = await auditLines([line, line], { apiKey: 'stub', fetch: reply({ reviews: [{ index: 0, verdict: 'supports', reason: 'The quotes support it.' }, { index: 1, verdict: 'disputes', reason: 'The rate does not apply.' }, { index: 2, verdict: 'supports', reason: 'Extra.' }] }) });
  assert.deepEqual(result.reviews.map(r => r.verdict), ['supports', 'disputes']);
});
test('bad JSON and missing indexes are not reviewed', async () => {
  const bad = await auditLines([line], { apiKey: 'stub', fetch: reply('{') });
  assert.equal(bad.reviews[0].reason, 'AI review unavailable.');
  const missing = await auditLines([line, line], { apiKey: 'stub', fetch: reply({ reviews: [{ index: 0, verdict: 'supports', reason: 'Supported.' }] }) });
  assert.equal(missing.reviews[1].verdict, 'not_reviewed');
});
test('transport failures leave every line unreviewed', async () => {
  const result = await auditLines([line], { apiKey: 'stub', fetch: (async () => { throw new Error('offline'); }) as typeof fetch });
  assert.equal(result.reviews[0].verdict, 'not_reviewed');
});
test('the review sees the whole source line a quote was cut from', async () => {
  let sent = '';
  const capture: typeof fetch = async (_url, init) => { sent = JSON.parse(String(init!.body)).messages[1].content; return new Response(JSON.stringify({ choices: [{ message: { content: '{"reviews":[]}' } }] })); };
  const sources = { log: 'Thu: 2 hours design, mostly waiting for feedback', prices: 'Design USD 50 per hour, minimum one hour' };
  await auditLines([line], { apiKey: 'stub', fetch: capture, sources });
  assert.deepEqual(JSON.parse(sent)[0], { ...line, work_line: sources.log, price_line: sources.prices });
  assert.equal(sourceLine('a\nb 2 hours design c\nd', '2 hours design'), 'b 2 hours design c');
});
test('the same quote on two log lines is reviewed in the context of the line the check found', async () => {
  let sent = '';
  const capture: typeof fetch = async (_url, init) => { sent = JSON.parse(String(init!.body)).messages[1].content; return new Response(JSON.stringify({ choices: [{ message: { content: '{"reviews":[]}' } }] })); };
  const log = 'Mon: 2 hours design, finished\nTue: 2 hours design, mostly waiting';
  const prices = 'Design USD 50 per hour';
  await auditLines([line, line], { apiKey: 'stub', fetch: capture, sources: { log, prices, offsets: [{ work: log.indexOf('2 hours design'), price: 0 }, { work: log.lastIndexOf('2 hours design'), price: 0 }] } });
  assert.deepEqual(JSON.parse(sent).map((l: { work_line: string }) => l.work_line), ['Mon: 2 hours design, finished', 'Tue: 2 hours design, mostly waiting']);
  // An offset that does not point at the quote falls back to the first occurrence.
  assert.equal(sourceLine(log, '2 hours design', 3), 'Mon: 2 hours design, finished');
});
