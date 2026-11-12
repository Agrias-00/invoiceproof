import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalApp } from './server.ts';
import { ProofStore, compare, fingerprint, refundRetryExpired, REFUND_RETRY_DAYS } from './proof-store.ts';
import { payerViewUrl } from './paypal-contract.ts';

const LINE = { description: 'Design', quantity: '2', rate: '50', work_quote: '2 hours', price_quote: '50 per hour' };
const INPUTS = { log: '2 hours', prices: '50 per hour' };
const INVOICE = 'INV2-FAKE';
const proofLine = { ref: 'L1', description: 'Design', quantity: '2', rate: '50', currency: 'USD' as const, work_quote: '2 hours', price_quote: '50 per hour', review: { verdict: 'supports' as const, reason: 'ok', model: null }, override: null };
const item = (over: Record<string, unknown> = {}) => ({ name: 'Design', quantity: '2', unit_amount: { currency_code: 'USD', value: '50.00' }, ...over });

test('compare: match, changed rate, and a failed read is never a match', () => {
  const store = new ProofStore(null);
  const proof = store.create({ invoice_number: 'IP-1', fingerprint: fingerprint(INPUTS, [proofLine]), lines: [proofLine] });
  assert.equal(compare(proof, { kind: 'invoice', status: 'UNPAID', items: [item()], currency: 'USD', value: '100.00' }).state, 'match');
  const changed = compare(proof, { kind: 'invoice', status: 'UNPAID', items: [item({ unit_amount: { currency_code: 'USD', value: '55.00' } })], currency: 'USD', value: '110.00' });
  assert.equal(changed.state, 'changed');
  assert.deepEqual(changed.differences.map(d => d.field), ['rate', 'total']);
  assert.equal(compare(proof, { kind: 'invoice', status: 'UNPAID', items: [item(), item({ name: 'Extra' })], currency: 'USD', value: '200.00' }).state, 'changed');
  assert.equal(compare(proof, { kind: 'unavailable', code: 'READ_TIMEOUT' }).state, 'could_not_check');
  assert.equal(compare(proof, null).state, 'could_not_check');
  assert.equal(compare(proof, { kind: 'invoice', status: 'UNPAID' }).state, 'could_not_check', 'a read without items is not a match');
  assert.equal(compare(proof, { kind: 'invoice', status: 'UNPAID', items: [item()] }).state, 'could_not_check', 'a read without a total is not a match');
});

test('a revision whose save fails is undone in memory too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'invoice-proof-'));
  const store = new ProofStore(join(dir, 'proofs.json'));
  const extra = { ...proofLine, ref: 'L2', description: 'Extra' };
  const proof = store.create({ invoice_number: 'IP-1', fingerprint: 'a'.repeat(64), lines: [proofLine, extra] });
  rmSync(dir, { recursive: true, force: true });   // the next save cannot be written
  assert.throws(() => store.revise(proof.token, { action: 'remove', ref: 'L2', reason: 'x', lines: [proofLine], fingerprint: 'b'.repeat(64) }));
  const kept = store.get(proof.token)!;
  assert.equal(kept.lines.length, 2); assert.equal(kept.fingerprint, 'a'.repeat(64)); assert.equal(kept.revisions, undefined);
});

test('fingerprint changes with any source text or line field', () => {
  const base = fingerprint(INPUTS, [proofLine]);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.notEqual(fingerprint({ ...INPUTS, log: '2 hours.' }, [proofLine]), base);
  assert.notEqual(fingerprint(INPUTS, [{ ...proofLine, rate: '51' }]), base);
  assert.equal(fingerprint(INPUTS, [proofLine]), base);
});

test('payer view links are accepted only on the sandbox payer page', () => {
  assert.equal(payerViewUrl('https://www.sandbox.paypal.com/invoice/p/#ABCD1234'), 'https://www.sandbox.paypal.com/invoice/p/#ABCD1234');
  for (const bad of ['https://www.paypal.com/invoice/p/#ABCD', 'https://evil.example/invoice/p/#ABCD', 'https://www.sandbox.paypal.com/invoice/p/?x=1#ABCD', 'javascript:alert(1)', 'https://www.sandbox.paypal.com/invoice/p/#<b>', 42])
    assert.equal(payerViewUrl(bad), null);
});

test('a line keeps its review label on the proof and the PayPal item after a blocked line before it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'invoice-proof-'));
  let created: any = null;
  const paypal = {
    createDraft: async (_draft: unknown, _op: string, presentation: unknown) => { created = presentation; return { kind: 'receipt', remoteId: INVOICE, format: 'representation' }; },
    findByOperation: async () => ({ kind: 'none' }),
    readInvoice: async () => ({ kind: 'invoice', remoteId: INVOICE, status: 'DRAFT', items: [item()], currency: 'USD', value: '100.00', total: 'USD 100.00', recipient_view_url: null }),
  };
  const rush = { description: 'Rush fee', quantity: '1', rate: '75', work_quote: 'rush fee', price_quote: 'no quote' };
  const app = await startLocalApp({ dbPath: join(dir, 'ledger.sqlite'), draft: async () => ({ model: 'fake', lines: [rush, LINE], cost_usd: null }), audit: async lines => ({ reviews: lines.map((_, index) => ({ index, verdict: 'supports' as const, reason: 'ok' })), model: 'fake', cost_usd: null }), paypal: paypal as never });
  const post = (path: string, data: unknown) => fetch(app.origin + path, { method: 'POST', headers: { origin: app.origin, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  try {
    const drafted = await (await post('/api/draft', { log: '2 hours; rush fee', prices: '50 per hour' })).json();
    assert.deepEqual(drafted.results.map((r: { status: string }) => r.status), ['rejected', 'accepted']);
    const approved = await (await post('/api/flow-approve', { draft: drafted.draft_id, lines: [LINE], reviewed: [true] })).json();
    const shown = await (await fetch(`${app.origin}/api/proof/${approved.proof_path.split('/').pop()}`)).json();
    assert.deepEqual(shown.lines.map((l: { ref: string }) => l.ref), ['L2']);
    assert.match(created.itemDescriptions[0], /^L2 · /);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('of two lines with the same quotes, the kept one keeps its own label', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'invoice-proof-'));
  const paypal = {
    createDraft: async () => ({ kind: 'receipt', remoteId: INVOICE, format: 'representation' }),
    findByOperation: async () => ({ kind: 'none' }),
    readInvoice: async () => ({ kind: 'invoice', remoteId: INVOICE, status: 'DRAFT', items: [item()], currency: 'USD', value: '100.00', total: 'USD 100.00', recipient_view_url: null }),
  };
  const app = await startLocalApp({ dbPath: join(dir, 'ledger.sqlite'), draft: async () => ({ model: 'fake', lines: [LINE, LINE], cost_usd: null }), audit: async lines => ({ reviews: lines.map((_, index) => ({ index, verdict: 'supports' as const, reason: 'ok' })), model: 'fake', cost_usd: null }), paypal: paypal as never });
  const post = (path: string, data: unknown) => fetch(app.origin + path, { method: 'POST', headers: { origin: app.origin, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  try {
    const drafted = await (await post('/api/draft', { log: 'Mon 2 hours\nTue 2 hours', prices: '50 per hour' })).json();
    assert.deepEqual(drafted.results.map((r: { status: string; reason?: string }) => r.reason ?? r.status), ['accepted', 'accepted']);
    const approved = await (await post('/api/flow-approve', { draft: drafted.draft_id, lines: [LINE], origins: [1], reviewed: [true], overrides: [`Billed once for both entries.`] })).json();
    assert.ok(approved.proof_path, JSON.stringify(approved));
    const shown = await (await fetch(`${app.origin}/api/proof/${approved.proof_path.split('/').pop()}`)).json();
    assert.deepEqual(shown.lines.map((l: { ref: string }) => l.ref), ['L2']);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('approve, send once, read the proof, ask a question, revoke', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'invoice-proof-'));
  let sends = 0, created: any = null;
  const paypal = {
    createDraft: async (_draft: unknown, _op: string, presentation: unknown) => { created = presentation; return { kind: 'receipt', remoteId: INVOICE, format: 'representation' }; },
    findByOperation: async () => ({ kind: 'none' }),
    readInvoice: async () => ({ kind: 'invoice', remoteId: INVOICE, status: sends ? 'UNPAID' : 'DRAFT', items: [item()], currency: 'USD', value: '100.00', total: 'USD 100.00', recipient_view_url: sends ? 'https://www.sandbox.paypal.com/invoice/p/#FAKE' : null }),
    sendInvoice: async () => { sends++; return 'https://www.sandbox.paypal.com/invoice/p/#FAKE'; },
    generateQrCode: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  };
  const app = await startLocalApp({ dbPath: join(dir, 'ledger.sqlite'), draft: async () => ({ model: 'fake', lines: [LINE], cost_usd: null }), audit: async lines => ({ reviews: lines.map((_, index) => ({ index, verdict: 'supports' as const, reason: 'ok' })), model: 'fake', cost_usd: null }), answer: async ({ line }) => ({ text: 'From the log.', quote: line.work_quote, grounded: true, model: 'fake' }), paypal: paypal as never });
  const post = (path: string, data: unknown) => fetch(app.origin + path, { method: 'POST', headers: { origin: app.origin, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  try {
    const drafted = await (await post('/api/draft', INPUTS)).json();
    assert.equal(drafted.reviews[0].verdict, 'supports');
    const approved = await (await post('/api/flow-approve', { draft: drafted.draft_id, lines: [LINE], reviewed: [true] })).json();
    const token = approved.proof_path.split('/').pop();
    // The invoice carries the quotes per item and a note naming the proof page and the fingerprint.
    assert.match(created.itemDescriptions[0], /^L1 · Work: "2 hours" · Price: "50 per hour"$/);
    assert.match(created.note, new RegExp(`/proof/${token} · Fingerprint ${approved.fingerprint.slice(0, 16)}$`));
    const first = await (await post('/api/flow-send', { draft: drafted.draft_id })).json();
    const again = await (await post('/api/flow-send', { draft: drafted.draft_id })).json();
    assert.equal(sends, 1, 'a second press reads again without sending again');
    assert.equal(first.status, 'UNPAID'); assert.equal(again.payer_view_url, 'https://www.sandbox.paypal.com/invoice/p/#FAKE');
    const qr = await fetch(app.origin + first.qr_path);
    assert.equal(qr.headers.get('content-type'), 'image/png');
    // The client arrives from the PayPal page: a cross-site navigation to the proof page is served.
    const page = await fetch(`${app.origin}/proof/${token}`, { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(page.status, 200);
    const proof = await (await fetch(`${app.origin}/api/proof/${token}`)).json();
    assert.equal(proof.paypal.state, 'match'); assert.equal(proof.lines[0].work_quote, '2 hours');
    assert.equal((await post(`/api/proof/${token}/question`, { ref: 'L9', note: 'x' })).status, 400);
    const asked = await (await post(`/api/proof/${token}/question`, { ref: 'L1', note: 'Which page was this?' })).json();
    assert.equal(asked.questions[0].note, 'Which page was this?');
    // The answer agent drafts from the stored texts; a published quote must be found in them.
    const draftedAnswer = await (await post(`/api/proof/${token}/answer-draft`, { index: 0 })).json();
    assert.equal(draftedAnswer.quote, '2 hours'); assert.equal(draftedAnswer.grounded, true);
    // Beside the reply the app suggests what to do with the line, with its own sums.
    assert.equal(draftedAnswer.resolution.ref, 'L1'); assert.equal(draftedAnswer.resolution.total, proof.lines.reduce((sum: number, l: any) => sum + Number(l.quantity) * Number(l.rate), 0).toFixed(2));
    assert.equal(draftedAnswer.resolution.action, proof.lines[0].review.verdict === 'supports' ? 'keep' : 'give_back');
    assert.equal((await post(`/api/proof/${token}/answer`, { index: 0, text: 'Pages 1 and 2.', quote: '3 hours', drafted_by: null })).status, 400);
    const answered = await (await post(`/api/proof/${token}/answer`, { index: 0, text: 'Pages 1 and 2.', quote: '2 hours', drafted_by: 'fake' })).json();
    assert.equal(answered.questions[0].answer.quote, '2 hours');
    const shown = await (await fetch(`${app.origin}/api/proof/${token}`)).json();
    assert.equal(shown.questions[0].answer.text, 'Pages 1 and 2.'); assert.equal(shown.sources, undefined, 'the client never receives the whole texts');
    const listed = await (await fetch(`${app.origin}/api/proofs`)).json();
    assert.equal(listed.proofs[0].token, token); assert.equal(listed.proofs[0].unanswered, 0);
    assert.equal((await post(`/api/proof/${token}/revoke`, {})).status, 200);
    assert.equal((await fetch(`${app.origin}/api/proof/${token}`)).status, 404);
    assert.equal((await fetch(`${app.origin}/api/proof/${'0'.repeat(32)}`)).status, 404);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a sent invoice is revised in place: PayPal first, then the proof keeps v1 beside v2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'invoice-proof-'));
  const inputs = { log: 'Mon: 2 hours design, 1.5 billable\nTue: 1 rush request', prices: '50 per hour\n75 rush fee' };
  const design = { description: 'Design', quantity: '2', rate: '50', work_quote: '2 hours design, 1.5 billable', price_quote: '50 per hour' };
  const rush = { description: 'Rush handling', quantity: '1', rate: '75', work_quote: '1 rush request', price_quote: '75 rush fee' };
  // A fake PayPal that holds the items it was given, so the read-back after an update is PayPal's own state.
  let status = 'DRAFT', items: any[] = [], note = '', refuse = false, loseReply = false, gate: Promise<void> | null = null;
  const updates: unknown[] = [];
  const paypal = {
    createDraft: async (draft: any, _op: string, presentation: any) => { items = draft.lines.map((l: any) => item({ name: l.description, quantity: l.quantity, unit_amount: { currency_code: 'USD', value: l.rate } })); note = presentation.note; return { kind: 'receipt', remoteId: INVOICE, format: 'representation' }; },
    findByOperation: async () => ({ kind: 'none' }),
    readInvoice: async () => ({ kind: 'invoice', remoteId: INVOICE, status, items, currency: 'USD', value: items.reduce((s, i) => s + Number(i.quantity) * Number(i.unit_amount.value), 0).toFixed(2), recipient_view_url: null }),
    sendInvoice: async () => { status = 'UNPAID'; return null; },
    updateInvoice: async (_id: string, next: any[], nextNote: string, expect?: { note: string }) => {
      if (gate) await gate;
      if (refuse) throw new Error('UPDATE_REFUSED');
      if (expect && expect.note !== note) throw new Error('UPDATE_CONFLICT');
      updates.push(next); items = next.map(l => item({ name: l.name, quantity: l.quantity, unit_amount: { currency_code: 'USD', value: l.rate } })); note = nextNote; status = 'SENT';
      if (loseReply) throw new Error('UPDATE_UNKNOWN');   // PayPal applied it, but the reply never arrived
    },
    generateQrCode: async () => Buffer.from([137, 80, 78, 71]),
  };
  const app = await startLocalApp({ dbPath: join(dir, 'ledger.sqlite'), draft: async () => ({ model: 'fake', lines: [design, rush], cost_usd: null }), audit: async lines => ({ reviews: lines.map((_, index) => ({ index, verdict: 'supports' as const, reason: 'ok' })), model: 'fake', cost_usd: null }), answer: async ({ line }) => ({ text: 'x', quote: line.work_quote, grounded: true, model: 'fake' }), paypal: paypal as never });
  const post = (path: string, data: unknown) => fetch(app.origin + path, { method: 'POST', headers: { origin: app.origin, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const revise = (token: string, data: Record<string, unknown>) => post(`/api/proof/${token}/revise`, { quantity: null, rate: null, reason: 'Client asked; no rush was agreed.', ...data });
  try {
    const drafted = await (await post('/api/draft', inputs)).json();
    const approved = await (await post('/api/flow-approve', { draft: drafted.draft_id, lines: [design, rush], reviewed: [true, true] })).json();
    const token = approved.proof_path.split('/').pop();
    await post('/api/flow-send', { proof: token });
    await post(`/api/proof/${token}/question`, { ref: 'L2', note: 'We never asked for rush work.' });
    // Paid, or PayPal refusing the update, leaves the proof exactly as approved.
    status = 'PAID';
    const paid = await revise(token, { ref: 'L2', action: 'remove' });
    assert.equal(paid.status, 409); assert.equal((await paid.json()).errorCode, 'INVOICE_NOT_REVISABLE');
    status = 'UNPAID'; refuse = true;
    assert.equal((await revise(token, { ref: 'L2', action: 'remove' })).status, 502);
    refuse = false;
    let shown = await (await fetch(`${app.origin}/api/proof/${token}`)).json();
    assert.equal(shown.lines.length, 2); assert.deepEqual(shown.revisions, []); assert.equal(shown.fingerprint, approved.fingerprint);
    assert.equal((await revise(token, { ref: 'L2', action: 'remove', reason: ' ' })).status, 400, 'a revision needs a reason');
    // An invoice changed elsewhere in PayPal is not overwritten.
    const kept = items; items = [items[0]];
    const elsewhere = await revise(token, { ref: 'L2', action: 'remove' });
    assert.equal(elsewhere.status, 409); assert.equal((await elsewhere.json()).errorCode, 'INVOICE_CHANGED_ELSEWHERE'); assert.equal(updates.length, 0);
    items = kept;
    // A note edited elsewhere in PayPal is not overwritten either, and nothing is left pending.
    const ownNote = note; note = 'Edited in PayPal';
    const noted = await revise(token, { ref: 'L2', action: 'remove' });
    assert.equal(noted.status, 409); assert.equal((await noted.json()).errorCode, 'INVOICE_CHANGED_ELSEWHERE'); assert.equal(updates.length, 0);
    assert.equal((await (await fetch(`${app.origin}/api/proof/${token}`)).json()).lines.length, 2);
    note = ownNote;
    // While a revision waits on PayPal, a second revision and a revoke are refused.
    let open!: () => void; gate = new Promise(done => { open = done; });
    const running = revise(token, { ref: 'L2', action: 'remove' });
    await new Promise(done => setTimeout(done, 50));
    assert.equal((await (await revise(token, { ref: 'L1', action: 'change', quantity: '1.5', rate: '50' })).json()).errorCode, 'REVISION_IN_PROGRESS');
    assert.equal((await post(`/api/proof/${token}/revoke`, {})).status, 409);
    refuse = true; open(); assert.equal((await running).status, 502); refuse = false; gate = null;
    // Remove the disputed line: PayPal is updated in place, the proof shows v1 -> v2 and PayPal's read matches v2.
    // The reply is lost after PayPal applied it: PayPal's read settles the pending revision as applied.
    loseReply = true;
    const removed = await (await revise(token, { ref: 'L2', action: 'remove' })).json();
    loseReply = false;
    assert.deepEqual(removed.lines.map((l: any) => l.ref), ['L1']);
    assert.equal(removed.revisions[0].version, 2); assert.equal(removed.revisions[0].total_before, '175.00'); assert.equal(removed.revisions[0].total_after, '100.00');
    assert.equal(removed.revisions[0].before.description, 'Rush handling'); assert.equal(removed.revisions[0].after, null);
    assert.equal(removed.revisions[0].fingerprint_before, approved.fingerprint); assert.notEqual(removed.fingerprint, approved.fingerprint);
    assert.equal(removed.paypal.state, 'match');
    assert.deepEqual(updates[0], [{ name: 'Design', description: 'L1 · Work: "2 hours design, 1.5 billable" · Price: "50 per hour"', quantity: '2', rate: '50' }]);
    assert.match(note, new RegExp(`Fingerprint ${removed.fingerprint.slice(0, 16)}$`), 'the PayPal note names the new fingerprint');
    // The question about the removed line can still be answered.
    const afterRemoval = await post(`/api/proof/${token}/answer-draft`, { index: 0 });
    assert.equal(afterRemoval.status, 200); assert.equal((await afterRemoval.json()).resolution, null, 'a removed line has nothing to give back');
    // A published reply may quote only the entries behind the questioned line (L2): L1's log entry is genuine but not its source.
    const offLine = await post(`/api/proof/${token}/answer`, { index: 0, text: 'See the log.', quote: '2 hours design', drafted_by: null });
    assert.equal(offLine.status, 400); assert.match((await offLine.json()).error ?? '', /another log or price entry/);
    assert.equal((await post(`/api/proof/${token}/answer`, { index: 0, text: 'See the log.', quote: '1 rush request', drafted_by: null })).status, 200);
    // A change must still be found in the same quotes; the last line cannot be removed.
    const unquoted = await revise(token, { ref: 'L1', action: 'change', quantity: '3', rate: '50' });
    assert.equal(unquoted.status, 422); assert.equal((await unquoted.json()).errorCode, 'QUOTE_CHECK_FAILED');
    const changed = await (await revise(token, { ref: 'L1', action: 'change', quantity: '1.5', rate: '50', reason: 'Only 1.5 hours were billable.' })).json();
    assert.equal(changed.lines[0].quantity, '1.5'); assert.equal(changed.revisions[1].version, 3); assert.equal(changed.revisions[1].total_after, '75.00'); assert.equal(changed.paypal.state, 'match');
    assert.equal((await (await revise(token, { ref: 'L1', action: 'remove' })).json()).errorCode, 'LAST_LINE');
    // The removed work is no longer billed, so a later invoice may bill it without a reason.
    const later = await (await post('/api/draft', inputs)).json();
    assert.notEqual(later.billed[0], null); assert.equal(later.billed[1], null);
    shown = await (await fetch(`${app.origin}/api/proofs`)).json();
    assert.equal(shown.proofs[0].version, 3); assert.equal(shown.proofs[0].total, '75.00');
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a paid line is refunded for exactly its amount, once, with the request id saved before the call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'invoice-proof-')), db = join(dir, 'ledger.sqlite');
  const inputs = { log: 'Mon: 2 hours design\nTue: 1 rush request', prices: '50 per hour\n75 rush fee' };
  const design = { description: 'Design', quantity: '2', rate: '50', work_quote: '2 hours design', price_quote: '50 per hour' };
  const rush = { description: 'Rush handling', quantity: '1', rate: '75', work_quote: '1 rush request', price_quote: '75 rush fee' };
  // A fake PayPal that keeps payments and refunds, and like PayPal returns the same refund for a repeated request id.
  let status = 'DRAFT', items: any[] = [], paid: any = null, mode: 'ok' | 'lose' | 'refuse' = 'ok', refundStatus = 'COMPLETED';
  const refunds = new Map<string, { id: string; amount: string }>(), calls: { capture: string; amount: string; request: string }[] = [];
  const refundedValue = () => [...refunds.values()].reduce((s, r) => s + Number(r.amount), 0).toFixed(2);
  const paypal = {
    createDraft: async (draft: any) => { items = draft.lines.map((l: any) => item({ name: l.description, quantity: l.quantity, unit_amount: { currency_code: 'USD', value: l.rate } })); return { kind: 'receipt', remoteId: INVOICE, format: 'representation' }; },
    findByOperation: async () => ({ kind: 'none' }),
    readInvoice: async () => ({ kind: 'invoice', remoteId: INVOICE, status, items, currency: 'USD', value: '175.00', recipient_view_url: null, ...(paid ? { paid } : {}), ...(refunds.size ? { refunded: { value: refundedValue(), ids: [...refunds.values()].map(r => r.id) } } : {}) }),
    sendInvoice: async () => { status = 'UNPAID'; return null; },
    refundCapture: async (capture: string, amount: string, request: string) => {
      calls.push({ capture, amount, request });
      if (mode === 'refuse') throw Object.assign(new Error('REFUND_REFUSED'), { issue: 'REFUND_AMOUNT_EXCEEDED' });
      if (refundStatus === 'FAILED') return { id: 'RFFAILED', status: 'FAILED', amount };   // accepted, then failed: no money moved
      if (!refunds.has(request)) { refunds.set(request, { id: `RF${refunds.size + 1}`, amount }); status = 'PARTIALLY_REFUNDED'; }
      if (mode === 'lose') throw new Error('REFUND_UNKNOWN');   // PayPal refunded, but the reply never arrived
      return { id: refunds.get(request)!.id, status: refundStatus, amount };
    },
    readRefund: async (id: string) => { calls.push({ capture: 'read', amount: '', request: id }); return { id, status: refundStatus, amount: [...refunds.values()].find(r => r.id === id)?.amount ?? null }; },
  };
  const options = { draft: async () => ({ model: 'fake', lines: [design, rush], cost_usd: null }), audit: async (lines: unknown[]) => ({ reviews: lines.map((_, index) => ({ index, verdict: 'supports' as const, reason: 'ok' })), model: 'fake', cost_usd: null }), paypal: paypal as never };
  let app = await startLocalApp({ dbPath: db, ...options } as never);
  const post = (path: string, data: unknown) => fetch(app.origin + path, { method: 'POST', headers: { origin: app.origin, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  try {
    const drafted = await (await post('/api/draft', inputs)).json();
    const approved = await (await post('/api/flow-approve', { draft: drafted.draft_id, lines: [design, rush], reviewed: [true, true] })).json();
    const token = approved.proof_path.split('/').pop();
    const refund = (ref: string, reason = 'No rush was agreed; refunded.') => post(`/api/proof/${token}/refund`, { ref, reason });
    await post('/api/flow-send', { proof: token });
    // Not paid yet: nothing to refund, and nothing is called.
    let r = await refund('L2'); assert.equal(r.status, 409); assert.equal((await r.json()).errorCode, 'INVOICE_NOT_PAID'); assert.equal(calls.length, 0);
    status = 'PAID';
    // A payment recorded outside PayPal (no PayPal transaction id) is not refundable from here.
    paid = { value: '175.00', transactions: [{ payment_id: null, method: 'CASH', amount: '175.00' }] };
    r = await refund('L2'); assert.equal((await r.json()).errorCode, 'PAYMENT_NOT_REFUNDABLE');
    paid = { value: '175.00', transactions: [{ payment_id: 'CAPTURE123', method: 'PAYPAL', amount: '175.00' }] };
    assert.equal((await refund('L2', ' ')).status, 400, 'a refund needs a reason');
    // Items changed elsewhere in PayPal: not refunded from this proof.
    const kept = items; items = [items[0]];
    assert.equal((await (await refund('L2')).json()).errorCode, 'INVOICE_CHANGED_ELSEWHERE'); items = kept;
    // PayPal refuses: nothing recorded, nothing left pending.
    mode = 'refuse'; r = await refund('L2'); assert.equal(r.status, 502); assert.equal((await r.json()).issue, 'REFUND_AMOUNT_EXCEEDED');
    assert.deepEqual((await (await fetch(`${app.origin}/api/proof/${token}`)).json()).refunds, []);
    // PayPal reports the refund FAILED: shown nowhere as money returned, and nothing stays pending.
    mode = 'ok'; refundStatus = 'FAILED'; r = await refund('L2'); assert.equal(r.status, 502); assert.equal((await r.json()).issue, 'FAILED');
    let proofNow = await (await fetch(`${app.origin}/api/proof/${token}`)).json();
    assert.deepEqual(proofNow.refunds, []); assert.equal(proofNow.refund_pending, null);
    refundStatus = 'COMPLETED';
    // The reply is lost after PayPal refunded, and the app restarts. The pending refund blocks revoke, and the retry
    // sends the same request id, so PayPal answers with the refund it already made instead of a second one.
    mode = 'lose'; r = await refund('L2'); assert.deepEqual(await r.json(), { errorCode: 'PAYPAL_REFUND_UNCONFIRMED', simulated: false }, 'a real lost reply is never labelled simulated');
    await app.close(); app = await startLocalApp({ dbPath: db, ...options } as never);
    let shown = await (await fetch(`${app.origin}/api/proof/${token}`)).json();
    assert.equal(shown.refund_pending, 'L2');
    assert.equal((await (await post(`/api/proof/${token}/revoke`, {})).json()).errorCode, 'REFUND_UNCONFIRMED');
    assert.equal((await (await refund('L1')).json()).errorCode, 'REFUND_UNCONFIRMED', 'another line waits for the open refund');
    const differs = await (await post(`/api/proof/${token}/refund`, { ref: 'L2', reason: 'x', quantity: '0.5' })).json();
    assert.equal(differs.errorCode, 'REFUND_STAGED_DIFFERS', 'a retry with another quantity is refused, never sent at the staged amount');
    assert.equal(differs.quantity, null); assert.match(differs.amount, /^\d+\.\d{2}$/);
    assert.equal((await (await post(`/api/proof/${token}/refund`, { ref: 'L2', reason: 'x', quantity: '0.5', not_refunded: true })).json()).errorCode, 'REFUND_STAGED_DIFFERS', 'a settlement field inside the retry window does not skip the amount check');
    // Past the retry window the request is never resent. A person settles it from PayPal: an unknown refund id and
    // "no refund" are both checked against PayPal, and the refund id PayPal holds is read back, not requested again.
    await app.close();
    const store = `${db}.proofs.json`, fresh = readFileSync(store, 'utf8'), aged = JSON.parse(fresh);
    aged[0].pending_refund.staged_at = '2020-01-01T00:00:00.000Z'; writeFileSync(store, JSON.stringify(aged));
    app = await startLocalApp({ dbPath: db, ...options } as never);
    const sent = calls.length, settle = (extra: object) => post(`/api/proof/${token}/refund`, { ref: 'L2', reason: 'x', ...extra });
    assert.equal((await (await refund('L2')).json()).errorCode, 'REFUND_RETRY_EXPIRED');
    assert.equal((await (await settle({ refund_id: 'RF9' })).json()).errorCode, 'REFUND_ID_NOT_MATCHING');
    assert.equal((await (await settle({ not_refunded: true })).json()).errorCode, 'REFUND_FOUND_ON_PAYPAL', 'PayPal shows the refund, so the stage is not released');
    // A refund of the same amount that PayPal does not list on this invoice is not taken, and a failed read releases nothing.
    refunds.set('other-invoice', { id: 'RF7', amount: '75.00' }); const listed = paypal.readInvoice;
    paypal.readInvoice = (async () => { const read: any = await listed(); return { ...read, refunded: { value: '75.00', ids: ['RF1'] } }; }) as never;
    assert.equal((await (await settle({ refund_id: 'RF7' })).json()).errorCode, 'REFUND_ID_NOT_MATCHING');
    paypal.readInvoice = (async () => ({ kind: 'unavailable', code: 'READ_FAILED' })) as never;
    assert.equal((await settle({ not_refunded: true })).status, 409, 'an unreadable invoice is not taken as no refund');
    assert.equal((await (await fetch(`${app.origin}/api/proof/${token}`)).json()).refund_pending, 'L2');
    paypal.readInvoice = listed; refunds.delete('other-invoice');
    assert.equal(calls.slice(sent).every(call => call.capture === 'read'), true, 'nothing was requested again');
    refundStatus = 'PENDING'; assert.equal((await (await settle({ refund_id: 'RF1' })).json()).errorCode, 'PAYPAL_REFUND_PENDING', 'the named refund is followed by its id');
    refundStatus = 'COMPLETED'; calls.length = sent;
    await app.close(); writeFileSync(store, fresh); app = await startLocalApp({ dbPath: db, ...options } as never);
    // The retry finds the refund PENDING at PayPal: it stays staged and is not shown as money returned.
    mode = 'ok'; refundStatus = 'PENDING'; r = await refund('L2');
    assert.equal(r.status, 409, 'an error status, so the page shows the pending message'); assert.equal((await r.json()).errorCode, 'PAYPAL_REFUND_PENDING');
    proofNow = await (await fetch(`${app.origin}/api/proof/${token}`)).json();
    assert.deepEqual(proofNow.refunds, []); assert.equal(proofNow.refund_pending, 'L2');
    assert.equal((await (await post(`/api/proof/${token}/revoke`, {})).json()).errorCode, 'REFUND_UNCONFIRMED');
    assert.equal(refunds.size, 1, 'one refund at PayPal'); assert.equal(calls.at(-1)!.request, calls.at(-2)!.request, 'the retry reuses the lost call’s request id');
    assert.notEqual(calls.at(-2)!.request, calls.at(-3)!.request, 'a refused refund is not reused');
    assert.deepEqual(calls.at(-1), { capture: 'CAPTURE123', amount: '75.00', request: calls.at(-1)!.request });
    // Once completed, the next press reads the refund by its id instead of asking PayPal again.
    refundStatus = 'COMPLETED'; const done = await (await refund('L2')).json();
    assert.deepEqual(calls.at(-1), { capture: 'read', amount: '', request: 'RF1' });
    assert.deepEqual(done.refunds.map((x: any) => [x.ref, x.amount, x.refund_id, x.status]), [['L2', '75.00', 'RF1', 'COMPLETED']]);
    assert.equal(done.refunds[0].request_id, undefined, 'the client never sees request or capture ids');
    assert.equal(done.paypal.state, 'match'); assert.equal(done.paypal.paid, '175.00'); assert.equal(done.paypal.refunded, '75.00'); assert.equal(done.refund_pending, null);
    // The same line is not refunded twice; the rest must fit what is still paid.
    assert.equal((await (await refund('L2')).json()).errorCode, 'ALREADY_REFUNDED');
    paid = { ...paid, value: '150.00' };
    assert.equal((await (await refund('L1')).json()).errorCode, 'REFUND_EXCEEDS_PAID');
    shown = await (await fetch(`${app.origin}/api/proof/${token}`)).json();
    assert.equal(shown.refunds.length, 1); assert.equal(shown.lines.length, 2, 'the paid invoice keeps its lines');
    // Part of a line: one of its two hours at the line's own rate, named in PayPal's note; never more than the line.
    paid = { ...paid, value: '175.00' };
    const part = (quantity: unknown) => post(`/api/proof/${token}/refund`, { ref: 'L1', reason: 'One hour was waiting.', quantity });
    for (const bad of ['0', '2.5', '1.234', 1]) assert.equal((await part(bad)).status, 400, `quantity ${bad}`);
    const half = await (await part('1')).json();
    assert.deepEqual(half.refunds.map((x: any) => [x.ref, x.amount, x.quantity ?? null]), [['L2', '75.00', null], ['L1', '50.00', '1']]);
    assert.equal(calls.findLast(call => call.capture === 'CAPTURE123')!.amount, '50.00');
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a revision left pending by a restart is settled from PayPal on the next read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'invoice-proof-')), db = join(dir, 'ledger.sqlite');
  const extra = { ...proofLine, ref: 'L2', description: 'Extra', quantity: '1', rate: '75' };
  let held = [item()];   // PayPal already holds the revised invoice: L1 only
  const paypal = { readInvoice: async () => ({ kind: 'invoice', remoteId: INVOICE, status: 'SENT', items: held, currency: 'USD', value: held.length === 1 ? '100.00' : '175.00', recipient_view_url: null }) };
  const store = new ProofStore(`${db}.proofs.json`);
  const proof = store.create({ invoice_number: 'IP-1', fingerprint: 'a'.repeat(64), lines: [proofLine, extra], sources: INPUTS });
  store.update(proof.token, { remote_id: INVOICE, sent: true });
  store.stage(proof.token, { action: 'remove', ref: 'L2', reason: 'Not agreed.', lines: [proofLine], fingerprint: 'b'.repeat(64) });
  const app = await startLocalApp({ dbPath: db, paypal: paypal as never });
  try {
    const shown = await (await fetch(`${app.origin}/api/proof/${proof.token}`)).json();
    assert.deepEqual(shown.lines.map((l: any) => l.ref), ['L1']); assert.equal(shown.revisions.length, 1); assert.equal(shown.paypal.state, 'match');
    assert.equal(shown.pending, undefined, 'the pending revision is never sent to the client');
    // PayPal still holding the approved lines drops the pending revision instead.
    const other = store.create({ invoice_number: 'IP-2', fingerprint: 'c'.repeat(64), lines: [proofLine, extra], sources: INPUTS });
    held = [item(), item({ name: 'Extra', quantity: '1', unit_amount: { currency_code: 'USD', value: '75.00' } })];
    store.update(other.token, { remote_id: INVOICE }); store.stage(other.token, { action: 'remove', ref: 'L2', reason: 'x', lines: [proofLine], fingerprint: 'd'.repeat(64) });
  } finally { await app.close(); }
  let again = await startLocalApp({ dbPath: db, paypal: paypal as never });
  const file = `${db}.proofs.json`;
  const token = JSON.parse(readFileSync(file, 'utf8')).find((p: any) => p.invoice_number === 'IP-2').token;
  try {
    // Staged moments ago, the update may still land: it stays pending even though PayPal shows the approved lines.
    await fetch(`${again.origin}/api/proof/${token}`);
    assert.notEqual(JSON.parse(readFileSync(file, 'utf8')).find((p: any) => p.token === token).pending, null);
    // Nor can the proof be revoked: a revoked proof could no longer be settled against PayPal.
    const revoke = await fetch(`${again.origin}/api/proof/${token}/revoke`, { method: 'POST', headers: { origin: again.origin, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(revoke.status, 409); assert.equal((await revoke.json()).errorCode, 'REVISION_UNCONFIRMED');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).find((p: any) => p.token === token).revoked_at, null);
  } finally { await again.close(); }
  const saved = JSON.parse(readFileSync(file, 'utf8')); saved.find((p: any) => p.token === token).pending.staged_at = new Date(Date.now() - 120_000).toISOString(); writeFileSync(file, JSON.stringify(saved));
  again = await startLocalApp({ dbPath: db, paypal: paypal as never });
  try {
    const shown = await (await fetch(`${again.origin}/api/proof/${token}`)).json();
    assert.equal(shown.lines.length, 2); assert.equal(shown.revisions.length, 0); assert.equal(shown.paypal.state, 'match');
    assert.equal(JSON.parse(readFileSync(`${db}.proofs.json`, 'utf8')).find((p: any) => p.token === token).pending, null);
  } finally { await again.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an edited line is reviewed again; the old verdict is not reused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'invoice-proof-'));
  const audited: string[] = [];
  const audit = async (lines: { description: string }[]) => { audited.push(...lines.map(l => l.description)); return { reviews: lines.map((l, index) => ({ index, verdict: l.description === 'Design' ? 'supports' as const : 'disputes' as const, reason: 'checked' })), model: 'fake', cost_usd: null }; };
  const app = await startLocalApp({ dbPath: join(dir, 'ledger.sqlite'), draft: async () => ({ model: 'fake', lines: [LINE], cost_usd: null }), audit: audit as never });
  const post = (path: string, data: unknown) => fetch(app.origin + path, { method: 'POST', headers: { origin: app.origin, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  try {
    const drafted = await (await post('/api/draft', INPUTS)).json();
    const edited = { ...LINE, description: 'Strategy consulting' };
    const refused = await post('/api/flow-approve', { draft: drafted.draft_id, lines: [edited], reviewed: [true] });
    assert.equal(refused.status, 422);
    const body = await refused.json();
    assert.equal(body.errorCode, 'REVIEW_OVERRIDE_REQUIRED'); assert.equal(body.reviews[0].verdict, 'disputes');
    assert.deepEqual(audited, ['Design', 'Strategy consulting']);
    await post('/api/flow-approve', { draft: drafted.draft_id, lines: [edited], reviewed: [true] });
    assert.equal(audited.length, 2, 'the same edit is not reviewed twice');
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an edited example line is not given the recorded verdict when the review fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'invoice-proof-'));
  const { DEMO_CASES } = await import('./demo-cases.ts');
  const example = DEMO_CASES.find(c => c.id === 'clean')!;
  // No model key for drafting (recorded reply), and the review call fails: only the recorded review is left.
  let reviewUp = false;
  const app = await startLocalApp({ dbPath: join(dir, 'ledger.sqlite'), draft: async () => { throw new Error('MISSING_API_KEY'); }, audit: async (lines: unknown[]) => { if (!reviewUp) throw new Error('down'); return { reviews: lines.map((_, index) => ({ index, verdict: 'supports' as const, reason: 'ok' })), model: 'fake', cost_usd: null }; } });
  const post = (path: string, data: unknown) => fetch(app.origin + path, { method: 'POST', headers: { origin: app.origin, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  try {
    const drafted = await (await post('/api/draft', { log: example.log, prices: example.prices })).json();
    const lines = drafted.results.filter((r: { status: string }) => r.status === 'accepted').map((r: { line: unknown }) => r.line);
    lines[0] = { ...lines[0], description: `${lines[0].description} (rush)` };
    const refused = await post('/api/flow-approve', { draft: drafted.draft_id, lines, reviewed: lines.map(() => true) });
    assert.equal(refused.status, 422);
    const body = await refused.json();
    assert.equal(body.reviews[0].verdict, 'not_reviewed'); assert.deepEqual(body.indexes, [0]);
    // The failure is not remembered: once the review answers, the same edit is reviewed and can pass.
    reviewUp = true;
    const again = await post('/api/flow-approve', { draft: drafted.draft_id, lines, reviewed: lines.map(() => true) });
    assert.equal(again.status, 200);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a reopened draft is sent by its proof, and a proof saved without texts can still be answered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'invoice-proof-'));
  const db = join(dir, 'ledger.sqlite');
  let sends = 0, given: { log: string; prices: string } | null = null;
  const paypal = {
    createDraft: async () => ({ kind: 'receipt', remoteId: INVOICE, format: 'representation' }),
    findByOperation: async () => ({ kind: 'none' }),
    readInvoice: async () => ({ kind: 'invoice', remoteId: INVOICE, status: sends ? 'UNPAID' : 'DRAFT', items: [item()], currency: 'USD', value: '100.00', total: 'USD 100.00', recipient_view_url: null }),
    sendInvoice: async () => { sends++; return null; },
    generateQrCode: async () => Buffer.from([137, 80, 78, 71]),
  };
  const options = { draft: async () => ({ model: 'fake', lines: [LINE], cost_usd: null }), audit: async (lines: unknown[]) => ({ reviews: lines.map((_, index) => ({ index, verdict: 'supports' as const, reason: 'ok' })), model: 'fake', cost_usd: null }), answer: async ({ line, sources }: any) => { given = sources; return { text: 'x', quote: line.work_quote, grounded: true, model: 'fake' }; }, paypal: paypal as never };
  let app = await startLocalApp({ dbPath: db, ...options } as never);
  let post = (path: string, data: unknown) => fetch(app.origin + path, { method: 'POST', headers: { origin: app.origin, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  let token = '';
  try {
    const drafted = await (await post('/api/draft', INPUTS)).json();
    token = (await (await post('/api/flow-approve', { draft: drafted.draft_id, lines: [LINE], reviewed: [true] })).json()).proof_path.split('/').pop();
  } finally { await app.close(); }
  // As if saved by the earlier version: no source texts.
  const file = `${db}.proofs.json`; const saved = JSON.parse(readFileSync(file, 'utf8')); delete saved[0].sources; writeFileSync(file, JSON.stringify(saved));
  app = await startLocalApp({ dbPath: db, ...options } as never);
  post = (path: string, data: unknown) => fetch(app.origin + path, { method: 'POST', headers: { origin: app.origin, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  try {
    const sent = await (await post('/api/flow-send', { proof: token })).json();
    assert.equal(sent.status, 'UNPAID'); assert.equal(sends, 1);
    await post(`/api/proof/${token}/question`, { ref: 'L1', note: 'Which page?' });
    assert.equal((await post(`/api/proof/${token}/answer-draft`, { index: 0 })).status, 200);
    assert.deepEqual(given, { log: '2 hours', prices: '50 per hour' }, 'the quotes stand in for the texts');
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the public origin serves only the client routes', async () => {
  const PUBLIC = 'https://proof.example.ts.net:8443';
  const dir = mkdtempSync(join(tmpdir(), 'invoice-proof-'));
  const app = await startLocalApp({ dbPath: join(dir, 'ledger.sqlite'), publicOrigin: PUBLIC });
  const host = new URL(PUBLIC).host;
  // fetch() refuses to set Host, so the proxy's request is replayed with node:http.
  const { request } = await import('node:http');
  const call = (method: string, path: string, headers: Record<string, string> = {}, data?: string) => new Promise<number>((resolve, reject) => {
    const r = request(app.origin + path, { method, headers: { host, ...headers } }, res => { res.resume(); resolve(res.statusCode!); });
    r.on('error', reject); r.end(data);
  });
  try {
    const token = '0'.repeat(32);
    assert.equal(await call('GET', `/proof/${token}`), 200, 'the proof page is served through the public host');
    assert.equal(await call('GET', `/api/proof/${token}`), 404, 'unknown proof, but not a host refusal');
    assert.equal(await call('POST', `/api/proof/${token}/question`, { origin: PUBLIC, 'content-type': 'application/json' }, '{"ref":"L1","note":"x"}'), 404, 'a question from the public origin reaches the proof lookup');
    assert.equal(await call('GET', '/'), 404, 'the freelancer page is not served publicly');
    assert.equal(await call('GET', '/api/proofs'), 404);
    assert.equal(await call('POST', `/api/proof/${token}/revoke`, { origin: PUBLIC, 'content-type': 'application/json' }, '{}'), 404);
    assert.equal(await call('POST', `/api/proof/${token}/revise`, { origin: PUBLIC, 'content-type': 'application/json' }, '{}'), 404, 'only the freelancer revises');
    assert.equal(await call('GET', '/', { host: 'evil.example' }), 403);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a long reply is cut at a sentence end and freelancer-only advice stays out of the client text', async () => {
  const { clip, draftAnswer } = await import('./answer-question.ts');
  assert.equal(clip('One. Two is long', 9), 'One.');
  assert.equal(clip('no stop here at all', 12), 'no stop…');
  const fake = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'I logged 2 hours.', quote: '2 hours', note: 'Add the date.' }) } }] }))) as typeof fetch;
  const drafted = await draftAnswer({ question: 'Why?', line: { ref: 'L1', ...LINE, override: null }, sources: INPUTS }, { apiKey: 'k', fetch: fake });
  assert.deepEqual([drafted.text, drafted.quote, drafted.note], ['I logged 2 hours.', '2 hours', 'Add the date.']);
  // A number no source states (a "5 hours" the log never records) is flagged to the freelancer before publishing.
  const padded = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'I logged 5 hours.', quote: '2 hours', note: '' }) } }] }))) as typeof fetch;
  const flagged = await draftAnswer({ question: 'Why?', line: { ref: 'L1', ...LINE, override: null }, sources: INPUTS }, { apiKey: 'k', fetch: padded });
  assert.match(flagged.warnings.join(' '), /states 5, which neither the log nor the price list contains/);
  // The quote is real and on this line, so the draft stays grounded, yet the warning says the text needs correcting.
  assert.deepEqual([flagged.grounded, flagged.note, drafted.warnings], [true, null, []]);
});

test('the client summary counts every PayPal refund, and one PayPal has not shown yet', async () => {
  const { createRequire } = await import('node:module');
  const { proofMoney } = createRequire(import.meta.url)('../integrated-ui/proof.js');
  const app = [{ amount: '100.00', refund_id: 'R-APP' }];
  // PayPal already lists this app's refund beside one made elsewhere: counted once.
  assert.deepEqual(proofMoney({ paid: '296.00', refunded: '150.00', refund_ids: ['R-APP', 'R-OUT'] }, app), { paid: 29600, refunded: 15000, kept: 14600, lag: false });
  // Just confirmed here, not yet on PayPal's invoice: the confirmed refund counts and the lag is said.
  assert.deepEqual(proofMoney({ paid: '296.00', refund_ids: [] }, app), { paid: 29600, refunded: 10000, kept: 19600, lag: true });
  // A refund made elsewhere is on PayPal's invoice and this app's newer one is not yet: both count.
  assert.deepEqual(proofMoney({ paid: '296.00', refunded: '150.00', refund_ids: ['R-OUT'] }, app), { paid: 29600, refunded: 25000, kept: 4600, lag: true });
  // Nothing refunded.
  assert.deepEqual(proofMoney({ paid: '296.00' }, []), { paid: 29600, refunded: 0, kept: 29600, lag: false });
});

test('a staged refund is resent only inside the window PayPal remembers its request id', () => {
  const day = 86_400_000, staged_at = '2026-11-01T00:00:00.000Z', at = Date.parse(staged_at);
  assert.equal(refundRetryExpired({ staged_at }, at + (REFUND_RETRY_DAYS - 1) * day), false);
  assert.equal(refundRetryExpired({ staged_at }, at + (REFUND_RETRY_DAYS + 1) * day), true, 'an older resend could refund twice');
  // A refund PayPal already accepted is read back by its id, never requested again, so its age does not matter.
  assert.equal(refundRetryExpired({ staged_at, refund_id: 'RF1' }, at + 400 * day), false);
  assert.ok(REFUND_RETRY_DAYS < 45, 'inside the 45 days PayPal documents');
});
