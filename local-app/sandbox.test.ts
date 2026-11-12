// Sandbox only; draft only; synthetic data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from '../offline-core/fixture.ts';
import { LOST_REFUND_REPLY, SANDBOX_ORIGIN, SandboxPayPal, sandboxFromEnv, withLostRefundReply } from './paypal-sandbox.ts';
import { invoiceNumberFor } from './paypal-contract.ts';

const id = 'INV2-SYNTHETIC-0001';
function stub(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('Unexpected call');
    return next;
  };
  return { calls, fetcher };
}
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
const STUB_BEARER = 'stub-bearer';
const token = () => json(200, { access_token: STUB_BEARER, expires_in: 3600 });
const adapter = (fetcher: typeof fetch) => new SandboxPayPal({ clientId: 'test-id', clientSecret: 'test-secret', fetch: fetcher });

test('refund sends the amount with the saved request id and tells a refusal from a lost reply', async () => {
  const request = randomUUID();
  let s = stub([token(), json(201, { id: 'REFUND1', status: 'COMPLETED', amount: { value: '75.00' } })]);
  assert.deepEqual(await adapter(s.fetcher).refundCapture('CAPTURE123', '75.00', request, 'L2 Rush: not agreed'), { id: 'REFUND1', status: 'COMPLETED', amount: '75.00' });
  assert.equal(s.calls[1].url, `${SANDBOX_ORIGIN}/v2/payments/captures/CAPTURE123/refund`);
  assert.equal((s.calls[1].init.headers as Record<string, string>)['PayPal-Request-Id'], request);
  assert.deepEqual(JSON.parse(String(s.calls[1].init.body)).amount, { currency_code: 'USD', value: '75.00' });
  s = stub([token(), json(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'REFUND_AMOUNT_EXCEEDED' }] })]);
  await assert.rejects(adapter(s.fetcher).refundCapture('CAPTURE123', '75.00', request, 'x'), (e: any) => e.message === 'REFUND_REFUSED' && e.issue === 'REFUND_AMOUNT_EXCEEDED');
  for (const reply of [json(500, {}), json(429, {}), new Error('socket hang up')]) {
    s = stub([token(), reply]);
    await assert.rejects(adapter(s.fetcher).refundCapture('CAPTURE123', '75.00', request, 'x'), /REFUND_UNKNOWN/);
  }
  await assert.rejects(adapter(stub([]).fetcher).refundCapture('../x', '75.00', request, 'x'), /Invalid refund/);
  await assert.rejects(adapter(stub([]).fetcher).refundCapture('CAPTURE123', '75', request, 'x'), /Invalid refund/);
});

test('the opt-in lost-reply fault refunds for real, drops only the first reply per request id, and says it is simulated', async () => {
  const request = randomUUID(), done = { id: 'REFUND1', status: 'COMPLETED', amount: { value: '75.00' } };
  const s = stub([token(), json(201, done), json(200, done)]);
  const faulty = withLostRefundReply(adapter(s.fetcher));
  await assert.rejects(faulty.refundCapture('CAPTURE123', '75.00', request, 'x'), (e: any) => e.message === 'REFUND_UNKNOWN' && e.simulated === true);
  assert.equal(s.calls.length, 2, 'the first refund reached PayPal');
  assert.deepEqual(await faulty.refundCapture('CAPTURE123', '75.00', request, 'x'), { id: 'REFUND1', status: 'COMPLETED', amount: '75.00' });
  assert.equal((s.calls[2].init.headers as Record<string, string>)['PayPal-Request-Id'], request, 'the retry resends the same request id');
  // Off unless asked for by name.
  const env = { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' };
  assert.equal(Object.getPrototypeOf(sandboxFromEnv(env)), SandboxPayPal.prototype);
  assert.ok(Object.hasOwn(sandboxFromEnv({ ...env, INVOICEPROOF_FAULT: LOST_REFUND_REPLY })!, 'refundCapture'));
});

test('a pending refund is read back by its id; an unread one is unknown, never completed', async () => {
  const refundId = '39W48584022200207';
  let s = stub([token(), json(200, { id: refundId, status: 'COMPLETED', amount: { value: '75.00' } })]);
  assert.deepEqual(await adapter(s.fetcher).readRefund(refundId), { id: refundId, status: 'COMPLETED', amount: '75.00' });
  assert.equal(s.calls[1].url, `${SANDBOX_ORIGIN}/v2/payments/refunds/${refundId}`); assert.equal(s.calls[1].init.method, 'GET');
  for (const reply of [json(404, {}), json(200, {}), new Error('socket hang up')]) {
    s = stub([token(), reply]);
    await assert.rejects(adapter(s.fetcher).readRefund(refundId), /REFUND_UNKNOWN/);
  }
  await assert.rejects(adapter(stub([]).fetcher).readRefund('../x'), /Invalid refund/);
});

test('update replaces items and note in place, drops computed fields and e-mails no one', async () => {
  const sent = { id, status: 'UNPAID', detail: { invoice_number: 'IP-1', note: 'old', currency_code: 'USD' }, items: [{ name: 'A' }, { name: 'B' }], amount: { value: '175.00' }, due_amount: {}, links: [], payments: {} };
  const s = stub([token(), json(200, sent), new Response(null, { status: 200 })]);
  await adapter(s.fetcher).updateInvoice(id, [{ name: 'A', description: 'L1 · quotes', quantity: '2', rate: '50' }], 'new note');
  assert.equal(s.calls[2].init.method, 'PUT');
  assert.equal(s.calls[2].url, `${SANDBOX_ORIGIN}/v2/invoicing/invoices/${id}?send_to_recipient=false&send_to_invoicer=false`);
  const body = JSON.parse(String(s.calls[2].init.body));
  assert.deepEqual(body.items, [{ name: 'A', description: 'L1 · quotes', quantity: '2', unit_amount: { currency_code: 'USD', value: '50' } }]);
  assert.deepEqual(body.detail, { invoice_number: 'IP-1', note: 'new note', currency_code: 'USD' });
  for (const key of ['amount', 'due_amount', 'links', 'payments', 'status']) assert.equal(key in body, false, key);
  const refused = stub([token(), json(200, sent), json(422, { name: 'UNPROCESSABLE_ENTITY' })]);
  await assert.rejects(adapter(refused.fetcher).updateInvoice(id, [{ name: 'A', description: '', quantity: '1', rate: '1' }], 'n'), /UPDATE_REFUSED/);
  const lost = stub([token(), json(200, sent), new Error('socket hang up')]);
  await assert.rejects(adapter(lost.fetcher).updateInvoice(id, [{ name: 'A', description: '', quantity: '1', rate: '1' }], 'n'), /UPDATE_UNKNOWN/);
  const down = stub([token(), json(200, sent), json(503, {})]);
  await assert.rejects(adapter(down.fetcher).updateInvoice(id, [{ name: 'A', description: '', quantity: '1', rate: '1' }], 'n'), /UPDATE_UNKNOWN/);
  await assert.rejects(adapter(stub([]).fetcher).updateInvoice('bad', [], 'n'), /Invalid invoice/);
});
test('update with expect writes only when PayPal holds the descriptions and note this app wrote', async () => {
  const held = { id, status: 'UNPAID', detail: { note: 'app note' }, items: [{ name: 'A', description: 'L1 · app', quantity: '2', unit_amount: { currency_code: 'USD', value: '50.00' } }] };
  const wrote = { items: [{ name: 'A', description: 'L1 · app', quantity: '2', rate: '50' }], note: 'app note' };
  const ok = stub([token(), json(200, held), new Response(null, { status: 200 })]);
  await adapter(ok.fetcher).updateInvoice(id, [{ name: 'A', description: '', quantity: '1', rate: '1' }], 'n', wrote);
  assert.equal(ok.calls.length, 3);
  for (const [field, value] of [['note', { ...held, detail: { note: 'edited in PayPal' } }], ['description', { ...held, items: [{ ...held.items[0], description: 'edited' }] }], ['quantity', { ...held, items: [{ ...held.items[0], quantity: '3' }] }],
    ['rate', { ...held, items: [{ ...held.items[0], unit_amount: { currency_code: 'USD', value: '60.00' } }] }], ['name', { ...held, items: [{ ...held.items[0], name: 'B' }] }], ['count', { ...held, items: [] }]] as const) {
    const s = stub([token(), json(200, value)]);
    await assert.rejects(adapter(s.fetcher).updateInvoice(id, [{ name: 'A', description: '', quantity: '1', rate: '1' }], 'n', wrote), /UPDATE_CONFLICT/, field);
    assert.equal(s.calls.length, 2, field);
  }
});
test('constructor rejects other origins and missing credentials', () => {
  assert.throws(() => new SandboxPayPal({ clientId: 'id', clientSecret: 'secret', baseUrl: 'https://example.com' }));
  assert.throws(() => new SandboxPayPal({ clientId: '', clientSecret: 'secret' }));
  assert.equal(sandboxFromEnv({}), null);
});
test('create uses the converter request and caches the token for read', async () => {
  const s = stub([token(), json(201, { id, status: 'DRAFT' }), json(200, { id, status: 'DRAFT' })]);
  const api = adapter(s.fetcher);
  assert.deepEqual(await api.createDraft(fixture(), 'request-1'), { kind: 'receipt', remoteId: id, format: 'representation' });
  assert.deepEqual(await api.readInvoice(id), { kind: 'invoice', remoteId: id, status: 'DRAFT' });
  assert.equal(s.calls.length, 3);
  assert.equal(s.calls[0].url, `${SANDBOX_ORIGIN}/v1/oauth2/token`);
  assert.equal(s.calls[0].init.body, 'grant_type=client_credentials');
  const headers = new Headers(s.calls[1].init.headers);
  assert.equal(headers.get('PayPal-Request-Id'), 'request-1');
  assert.equal(headers.get('Prefer'), 'return=representation');
  assert.equal(headers.get('Authorization'), `Bearer ${STUB_BEARER}`);
  assert.equal(JSON.parse(String(s.calls[1].init.body)).invoicer.email_address, undefined);
});
test('self link becomes a receipt', async () => {
  const s = stub([token(), json(201, { href: `${SANDBOX_ORIGIN}/v2/invoicing/invoices/${id}`, rel: 'self', method: 'GET' })]);
  assert.deepEqual(await adapter(s.fetcher).createDraft(fixture(), 'op'), { kind: 'receipt', remoteId: id, format: 'self-link' });
});
test('live response shape: links on the older sandbox host are a receipt; another host is not', async () => {
  const links = (origin: string) => [{ href: `${origin}/v2/invoicing/invoices/${id}`, rel: 'self', method: 'GET' }, { href: `${origin}/v2/invoicing/invoices/${id}/send`, rel: 'send', method: 'POST' }];
  const s = stub([token(), json(201, { id, status: 'DRAFT', links: links('https://api.sandbox.paypal.com') }), json(201, { id, status: 'DRAFT', links: links('https://api.paypal.com') })]);
  const api = adapter(s.fetcher);
  assert.deepEqual(await api.createDraft(fixture(), 'op'), { kind: 'receipt', remoteId: id, format: 'representation' });
  assert.deepEqual(await api.createDraft(fixture(), 'op'), { kind: 'unknown', reason: 'CONFLICTING_CREATE_RECEIPT' });
});
test('one operation has one invoice number; a duplicate number is unknown, resolved by find', async () => {
  const number = invoiceNumberFor('op');
  assert.match(number, /^IP-[0-9A-F]{20}$/);
  assert.notEqual(number, invoiceNumberFor('op-2'));
  const hit = { id, status: 'DRAFT', detail: { invoice_number: number } };
  const s = stub([token(), json(422, { name: 'UNPROCESSABLE_ENTITY', debug_id: 'debug-2', details: [{ issue: 'DUPLICATE_INVOICE_NUMBER' }] }),
    json(200, { total_items: 1, items: [hit] }), json(200, { items: [] }), json(200, { items: [hit, { ...hit, id: 'INV2-SYNTHETIC-0002' }] }),
    json(200, { items: [{ ...hit, detail: { invoice_number: number + '1' } }] }), json(500, {}), json(200, { items: 'no' })]);
  const api = adapter(s.fetcher);
  assert.deepEqual(await api.createDraft(fixture(), 'op'), { kind: 'unknown', reason: 'CREATE_DUPLICATE_NUMBER' });
  assert.equal(JSON.parse(String(s.calls[1].init.body)).detail.invoice_number, number);
  assert.deepEqual(await api.findByOperation('op'), { kind: 'found', remoteId: id, status: 'DRAFT' });
  assert.equal(s.calls[2].url, `${SANDBOX_ORIGIN}/v2/invoicing/search-invoices?total_required=true&page_size=10`);
  assert.deepEqual(JSON.parse(String(s.calls[2].init.body)), { invoice_number: number });
  assert.deepEqual(await api.findByOperation('op'), { kind: 'none' });
  assert.deepEqual(await api.findByOperation('op'), { kind: 'ambiguous', count: 2 });
  assert.deepEqual(await api.findByOperation('op'), { kind: 'none' });
  assert.deepEqual(await api.findByOperation('op'), { kind: 'unavailable', code: 'FIND_UNAVAILABLE' });
  assert.deepEqual(await api.findByOperation('op'), { kind: 'unavailable', code: 'FIND_MALFORMED' });
});
test('server error stays unknown and rejection carries debug id', async () => {
  const s = stub([token(), json(500, {}), json(422, { debug_id: 'debug-1' })]);
  const api = adapter(s.fetcher);
  assert.deepEqual(await api.createDraft(fixture(), 'op'), { kind: 'unknown', reason: 'CREATE_SERVER_ERROR' });
  assert.deepEqual(await api.createDraft(fixture(), 'op'), { kind: 'failed', reason: 'PROVIDER_REJECTED', status: 422, debugId: 'debug-1' });
});
test('401 refreshes once and retries create once', async () => {
  const s = stub([token(), json(401, {}), token(), json(201, { id, status: 'DRAFT' })]);
  assert.equal((await adapter(s.fetcher).createDraft(fixture(), 'op')).kind, 'receipt');
  assert.equal(s.calls.length, 4);
  assert.equal(s.calls[1].init.body, s.calls[3].init.body);
});
test('read rejects invalid ids without calls and maps 404', async () => {
  const s = stub([token(), json(404, {})]); const api = adapter(s.fetcher);
  assert.deepEqual(await api.readInvoice('../bad'), { kind: 'unavailable', code: 'READ_MALFORMED' });
  assert.equal(s.calls.length, 0);
  assert.deepEqual(await api.readInvoice(id), { kind: 'unavailable', code: 'READ_NOT_FOUND' });
});
test('network rejection does not expose credentials', async () => {
  const s = stub([new Error('test-secret')]);
  const result = await adapter(s.fetcher).createDraft(fixture(), 'op');
  assert.deepEqual(result, { kind: 'unknown', reason: 'CREATE_NETWORK_ERROR' });
  assert.doesNotMatch(JSON.stringify(result), /test-secret/);
});

test('refused credentials are a definite failure, not an unknown outcome', async () => {
  const { calls, fetcher } = stub([json(401, { error: 'invalid_client' })]);
  const api = new SandboxPayPal({ clientId: 'id', clientSecret: 'secret-value', fetch: fetcher });
  const result = await api.createDraft(fixture(), 'request-1');
  assert.deepEqual(result, { kind: 'failed', reason: 'CREDENTIALS_REFUSED', status: 401, debugId: null });
  assert.equal(calls.length, 1);
});

test('live sandbox: one operation creates one draft, reads it back and finds it again', { skip: !process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET ? 'PayPal sandbox credentials are absent' : false }, async t => {
  const api = sandboxFromEnv()!;
  const requestId = randomUUID();
  assert.match(requestId, /^[A-Za-z0-9._:-]{1,38}$/);
  const created = await api.createDraft(fixture(), requestId);
  // The result carries a reason, a status and PayPal's debug id, never a credential.
  assert.equal(created.kind, 'receipt', JSON.stringify(created));
  if (created.kind !== 'receipt') return;
  t.diagnostic(`Created invoice ending ${created.remoteId.slice(-4)}`);
  const read = await api.readInvoice(created.remoteId);
  assert.equal(read.kind, 'invoice');
  if (read.kind !== 'invoice') return;
  assert.ok(read.remoteId === created.remoteId);
  assert.equal(read.status, 'DRAFT');
  // A repeat of the same operation must not make a second invoice; the first is found by its number.
  assert.deepEqual(await api.createDraft(fixture(), requestId), { kind: 'unknown', reason: 'CREATE_DUPLICATE_NUMBER' });
  const found = await api.findByOperation(requestId);
  assert.equal(found.kind, 'found');
  if (found.kind === 'found') { assert.ok(found.remoteId === created.remoteId); assert.equal(found.status, 'DRAFT'); }
  assert.deepEqual(await api.findByOperation(randomUUID()), { kind: 'none' });
});
