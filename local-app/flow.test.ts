import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalApp } from './server.ts';
import { DEMO_CASES } from './demo-cases.ts';
import { RECORDED_AT } from './recorded-replies.ts';

const LINE = { description: 'Design', quantity: '2', rate: '50', work_quote: '2 hours', price_quote: '50 per hour' };
const INPUTS = { log: '2 hours', prices: '50 per hour' };
const INVOICE = 'INV2-FAKE';
const SUPPORTS_ALL = async (lines: unknown[]) => ({ reviews: lines.map((_, index) => ({ index, verdict: 'supports' as const, reason: 'Supported.' })), model: 'fake-review', cost_usd: null });
type Post = (path: string, data: unknown) => Promise<Response>;

/** Starts the app with a fake model and a fake provider, drafts the one accepted line, then runs the scenario. */
async function withDraftedApp(provider: Record<string, unknown>, scenario: (post: Post) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'invoice-flow-'));
  const paypal = { readInvoice: async () => ({ kind: 'invoice', remoteId: INVOICE, status: 'DRAFT' }), findByOperation: async () => ({ kind: 'none' }), ...provider };
  const app = await startLocalApp({ dbPath: join(dir, 'ledger.sqlite'), draft: async () => ({ model: 'fake', lines: [LINE], cost_usd: null }), audit: SUPPORTS_ALL, paypal: paypal as never });
  try {
    const post: Post = (path, data) => fetch(app.origin + path, { method: 'POST', headers: { origin: app.origin, 'content-type': 'application/json' }, body: JSON.stringify(data) });
    const drafted = await (await post('/api/draft', INPUTS)).json();
    assert.equal(drafted.results[0].status, 'accepted');
    // An approval names the draft it reviewed, as the page does; a scenario may name another one itself.
    await scenario((path, data) => post(path, path === '/api/flow-approve' ? { draft: drafted.draft_id, ...(data as object) } : data));
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('draft verifies quotes and rejects unsupported edited rates before create', async () => {
  let creates = 0;
  await withDraftedApp({ createDraft: async () => { creates++; return { kind: 'receipt', remoteId: INVOICE, format: 'representation' }; } }, async post => {
    const rejected = await post('/api/flow-approve', { lines: [{ ...LINE, rate: '75' }], reviewed: [true] });
    assert.equal(rejected.status, 422); assert.equal(creates, 0);
    const approved = await (await post('/api/flow-approve', { lines: [LINE], reviewed: [true] })).json();
    assert.equal(approved.mode, 'sandbox'); assert.equal(approved.invoice_id, INVOICE); assert.equal(creates, 1);
  });
});

test('a work-log line already on a live invoice is billed again only with a reason', async () => {
  let creates = 0;
  await withDraftedApp({ createDraft: async () => { creates++; return { kind: 'receipt', remoteId: `${INVOICE}-${creates}`, format: 'representation' }; }, readInvoice: async (id: string) => ({ kind: 'invoice', remoteId: id, status: 'DRAFT' }) }, async post => {
    assert.equal((await post('/api/flow-approve', { lines: [LINE], reviewed: [true] })).status, 200);
    // The same log drafted again: the line names the invoice that already bills it.
    const again = await (await post('/api/draft', INPUTS)).json();
    assert.equal(again.billed[0].ref, 'L1'); assert.match(again.billed[0].invoice_number, /\S/);
    const refused = await post('/api/flow-approve', { draft: again.draft_id, lines: [LINE], reviewed: [true] });
    assert.equal(refused.status, 422); assert.equal((await refused.json()).errorCode, 'ALREADY_INVOICED'); assert.equal(creates, 1);
    const kept = await post('/api/flow-approve', { draft: again.draft_id, lines: [LINE], reviewed: [true], overrides: ['Second session on the same day, agreed by e-mail.'] });
    assert.equal(kept.status, 200); assert.equal(creates, 2);
    // A different work-log line is not flagged.
    assert.equal((await (await post('/api/draft', { log: 'Tue: 2 hours', prices: INPUTS.prices })).json()).billed[0], null);
  });
});

test('the duplicate check names the exact log line billed, and counts an invoice whose outcome is unknown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'invoice-flow-'));
  let creates = 0, outcome: 'unknown' | 'receipt' = 'receipt';
  const paypal = { createDraft: async () => { creates++; return outcome === 'unknown' ? { kind: 'unknown' } : { kind: 'receipt', remoteId: `${INVOICE}-${creates}`, format: 'representation' }; }, readInvoice: async (id: string) => ({ kind: 'invoice', remoteId: id, status: 'DRAFT' }), findByOperation: async () => ({ kind: 'none' }) };
  // Both lines quote "2 hours": the quote check places the second on Tuesday, and the proof must remember Tuesday.
  let reply = [LINE, LINE];
  const app = await startLocalApp({ dbPath: join(dir, 'ledger.sqlite'), draft: async () => ({ model: 'fake', lines: reply, cost_usd: null }), audit: SUPPORTS_ALL, paypal: paypal as never });
  try {
    const post: Post = (path, data) => fetch(app.origin + path, { method: 'POST', headers: { origin: app.origin, 'content-type': 'application/json' }, body: JSON.stringify(data) });
    const first = await (await post('/api/draft', { log: 'Mon: 2 hours\nTue: 2 hours', prices: INPUTS.prices })).json();
    assert.equal((await post('/api/flow-approve', { draft: first.draft_id, lines: [LINE, LINE], reviewed: [true, true] })).status, 200);
    // A later log repeats Tuesday and adds Thursday: Tuesday is flagged as L2 of the first invoice, Thursday is not.
    const again = await (await post('/api/draft', { log: 'Tue: 2 hours\nThu: 2 hours', prices: INPUTS.prices })).json();
    assert.deepEqual(again.billed.map((b: { ref: string } | null) => b?.ref ?? null), ['L2', null]);
    // An unknown create outcome still counts as billed for the next draft of the same log.
    outcome = 'unknown'; reply = [LINE];
    const third = await (await post('/api/draft', { log: 'Wed: 2 hours', prices: INPUTS.prices })).json();
    assert.equal((await post('/api/flow-approve', { draft: third.draft_id, lines: [LINE], reviewed: [true] })).status, 409);
    const fourth = await (await post('/api/draft', { log: 'Wed: 2 hours', prices: INPUTS.prices })).json();
    assert.notEqual(fourth.billed[0], null);
    const refused = await post('/api/flow-approve', { draft: fourth.draft_id, lines: [LINE], reviewed: [true] });
    assert.equal((await refused.json()).errorCode, 'ALREADY_INVOICED');
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a proof saved before refused creates were revoked is judged by the ledger outcome', async () => {
  // Each outcome is made by a real approval, then the proof is rewritten as an older version saved it:
  // not revoked, no billed_lines, no remote id.
  for (const [kind, flagged] of [['failed', false], ['unknown', true]] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'invoice-flow-'));
    const db = join(dir, 'ledger.sqlite');
    const paypal = { createDraft: async () => ({ kind }), readInvoice: async () => ({ kind: 'unavailable' }), findByOperation: async () => ({ kind: 'none' }) };
    const options = { dbPath: db, draft: async () => ({ model: 'fake', lines: [LINE], cost_usd: null }), audit: SUPPORTS_ALL, paypal: paypal as never };
    const draftOn = async (app: { origin: string }) => (await fetch(app.origin + '/api/draft', { method: 'POST', headers: { origin: app.origin, 'content-type': 'application/json' }, body: JSON.stringify(INPUTS) })).json();
    let app = await startLocalApp(options);
    try {
      const drafted = await draftOn(app);
      await fetch(app.origin + '/api/flow-approve', { method: 'POST', headers: { origin: app.origin, 'content-type': 'application/json' }, body: JSON.stringify({ draft: drafted.draft_id, lines: [LINE], reviewed: [true] }) });
    } finally { await app.close(); }
    const file = `${db}.proofs.json`;
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    for (const proof of saved) { proof.revoked_at = null; proof.remote_id = null; delete proof.billed_lines; }
    writeFileSync(file, JSON.stringify(saved));
    app = await startLocalApp(options);
    try { assert.equal((await draftOn(app)).billed[0] !== null, flagged, `legacy proof after a ${kind} create`); }
    finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a line the person has not marked as compared stops the approval before any create', async () => {
  let creates = 0;
  await withDraftedApp({ createDraft: async () => { creates++; return { kind: 'receipt', remoteId: INVOICE, format: 'representation' }; } }, async post => {
    for (const reviewed of [[false], [], [true, true], 'yes']) {
      const refused = await post('/api/flow-approve', { lines: [LINE], reviewed });
      assert.equal(refused.status, 422); assert.equal((await refused.json()).errorCode, 'LINES_NOT_REVIEWED');
    }
    assert.equal((await post('/api/flow-approve', { lines: [LINE] })).status, 400, 'a request without the marks is malformed');
    assert.equal(creates, 0);
  });
});

test('the read-back passes on the total and the number the provider returned', async () => {
  await withDraftedApp({
    createDraft: async () => ({ kind: 'receipt', remoteId: INVOICE, format: 'representation' }),
    readInvoice: async () => ({ kind: 'invoice', remoteId: INVOICE, status: 'DRAFT', number: 'IP-ABC', total: 'USD 100.00' }),
  }, async post => {
    const approved = await (await post('/api/flow-approve', { lines: [LINE], reviewed: [true] })).json();
    assert.equal(approved.read_total, 'USD 100.00'); assert.equal(approved.read_number, 'IP-ABC');
  });
});

test('an unknown create is resolved by lookup in the same request, without a second create', async () => {
  let creates = 0;
  await withDraftedApp({
    createDraft: async () => { creates++; return { kind: 'unknown', reason: 'CREATE_TIMEOUT' }; },
    findByOperation: async () => ({ kind: 'found', remoteId: INVOICE, status: 'DRAFT' }),
  }, async post => {
    const approved = await post('/api/flow-approve', { lines: [LINE], reviewed: [true] });
    assert.equal(approved.status, 200); assert.equal((await approved.json()).invoice_id, INVOICE); assert.equal(creates, 1);
  });
});

test('an unknown create that lookup cannot find stays unresolved, then a later lookup resolves it with no second create', async () => {
  let creates = 0, visible = false;
  await withDraftedApp({
    createDraft: async () => { creates++; return { kind: 'unknown', reason: 'CREATE_TIMEOUT' }; },
    findByOperation: async () => visible ? { kind: 'found', remoteId: INVOICE, status: 'DRAFT' } : { kind: 'none' },
  }, async post => {
    const unresolved = await post('/api/flow-approve', { lines: [LINE], reviewed: [true] });
    assert.equal(unresolved.status, 409); assert.match((await unresolved.json()).error, /unresolved/);
    visible = true;
    const resolved = await post('/api/flow-approve', { lines: [LINE], reviewed: [true] });
    assert.equal(resolved.status, 200); assert.equal((await resolved.json()).invoice_id, INVOICE); assert.equal(creates, 1);
  });
});

test('lines reviewed against an older draft are refused and create nothing', async () => {
  let creates = 0;
  await withDraftedApp({ createDraft: async () => { creates++; return { kind: 'receipt', remoteId: INVOICE, format: 'representation' }; } }, async post => {
    const again = await (await post('/api/draft', INPUTS)).json();   // a later draft replaces the one the page reviewed
    const stale = await post('/api/flow-approve', { lines: [LINE], reviewed: [true] });
    assert.equal(stale.status, 409); assert.equal((await stale.json()).errorCode, 'DRAFT_OUT_OF_DATE'); assert.equal(creates, 0);
    const current = await post('/api/flow-approve', { draft: again.draft_id, lines: [LINE], reviewed: [true] });
    assert.equal(current.status, 200); assert.equal(creates, 1);
  });
});

test('a provider exception never puts its message in the reply', async () => {
  await withDraftedApp({ createDraft: async () => { throw new Error('token=SECRET-LOOKING-TEXT'); } }, async post => {
    const failed = await post('/api/flow-approve', { lines: [LINE], reviewed: [true] });
    const text = await failed.text();
    assert.equal(failed.status, 409); assert.doesNotMatch(text, /SECRET-LOOKING-TEXT/); assert.match(text, /Request rejected\./);
  });
});

test('without a model key an example uses the recorded reply, other text is refused, and approval stays in the offline mock', async () => {
  const savedKey = process.env.OPENROUTER_API_KEY; delete process.env.OPENROUTER_API_KEY;
  const dir = mkdtempSync(join(tmpdir(), 'invoice-flow-'));
  const app = await startLocalApp({ dbPath: join(dir, 'ledger.sqlite') });
  try {
    const post: Post = (path, data) => fetch(app.origin + path, { method: 'POST', headers: { origin: app.origin, 'content-type': 'application/json' }, body: JSON.stringify(data) });
    const demo = DEMO_CASES.find(item => item.id === 'tempting')!;
    const drafted = await (await post('/api/draft', { log: demo.log, prices: demo.prices })).json();
    assert.equal(drafted.recorded_at, RECORDED_AT.tempting);
    assert.deepEqual(drafted.results.map((result: { status: string; reason?: string }) => result.reason ?? result.status), ['accepted', 'accepted', 'accepted', 'EMPTY_QUOTE', 'accepted']);
    // The recorded AI review goes with the recorded reply: the client-call line is disputed.
    assert.deepEqual(drafted.reviews.map((r: { verdict: string }) => r.verdict), ['supports', 'supports', 'supports', 'disputes']);
    const lines = drafted.results.filter((result: { status: string }) => result.status === 'accepted').map((result: { line: unknown }) => result.line);
    const unexplained = await post('/api/flow-approve', { draft: drafted.draft_id, lines, reviewed: lines.map(() => true) });
    assert.equal(unexplained.status, 422); const refusal = await unexplained.json();
    assert.equal(refusal.errorCode, 'REVIEW_OVERRIDE_REQUIRED'); assert.deepEqual(refusal.indexes, [3]);
    assert.deepEqual(refusal.reviews.map((r: { verdict: string }) => r.verdict), ['supports', 'supports', 'supports', 'disputes'], 'the verdicts the approval was judged on');
    const overrides = lines.map((_: unknown, i: number) => i === 3 ? 'Agreed with the client: review time is billable.' : null);
    const approved = await (await post('/api/flow-approve', { draft: drafted.draft_id, lines, reviewed: lines.map(() => true), overrides })).json();
    assert.equal(approved.mode, 'offline-mock'); assert.equal(approved.status, 'DRAFT');
    // The proof page JSON carries the quotes, the review and the override, never the whole work log or price list.
    assert.match(approved.proof_path, /^\/proof\/[0-9a-f]{32}$/);
    const proof = await (await fetch(app.origin + approved.proof_path.replace('/proof/', '/api/proof/'))).json();
    assert.equal(proof.lines[3].override, 'Agreed with the client: review time is billable.');
    assert.equal(proof.lines[3].review.verdict, 'disputes');
    assert.equal(proof.paypal.state, 'could_not_check', 'offline mode never claims a match');
    assert.doesNotMatch(JSON.stringify(proof), /Stock photo licence: USD 12\.00 each\\nDesign/);
    assert.equal('log' in proof || 'prices' in proof, false);
    assert.equal(approved.read_total, null, 'the mock holds no total, so none is shown');
    const own = await post('/api/draft', { log: `${demo.log} `, prices: demo.prices });
    assert.equal(own.status, 503); assert.equal((await own.json()).errorCode, 'MODEL_NOT_CONFIGURED');
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey; }
});
