import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { draftLines } from './draft-lines.ts';
import { verifyQuotes } from './verify-quotes.ts';
import { DEMO_CASES } from './demo-cases.ts';
import { recordedReplyFor, recordedReviewsFor } from './recorded-replies.ts';
import { auditLines, sourceLine } from './audit-lines.ts';
import type { Review } from './audit-lines.ts';
type Billed = { invoice_number: string; ref: string; created_at: string };
import { draftAnswer, groundedQuote, quoteOnLine, suggestResolution } from './answer-question.ts';
import { ProofStore, TOKEN, compare, fingerprint, totalOf, refundRetryExpired } from './proof-store.ts';
import type { Proof, ProofLine } from './proof-store.ts';
import { invoiceNumberFor } from './paypal-contract.ts';
import type { SandboxPayPal } from './paypal-sandbox.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DurableLedger } from '../offline-ledger/ledger.ts';
import { fixture } from '../offline-core/fixture.ts';
import { validate } from '../offline-core/core.ts';
import { OfflinePayPalMock, readScenarios } from './paypal-contract.ts';
import type { ReadScenario } from './paypal-contract.ts';

const DRAFT_ID = 'synthetic-ui-draft-1';
const OPERATION_ID = 'synthetic-ui-operation-1';
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const FLOW_ROUTES = ['/api/draft', '/api/flow-approve', '/api/flow-send'];
const PROOF_PAGE = /^\/proof\/[0-9a-f]{32}$/;
const PROOF_API = /^\/api\/proof\/([0-9a-f]{32})(?:\/(question|revoke|answer-draft|answer|revise|refund))?$/;
// A sent invoice is corrected in place only while nothing has been paid on it.
const REVISABLE = new Set(['DRAFT', 'SENT', 'UNPAID', 'SCHEDULED']);
// Once paid, a line is given back by a refund on the client's payment instead.
const REFUNDABLE = new Set(['PAID', 'PARTIALLY_REFUNDED']);
/** PayPal refund statuses after which no money moved: the staged refund is cleared. */
const REFUND_FAILED = new Set(['FAILED', 'CANCELLED']);
const cents = (value: string) => Math.round(Number(value) * 100);
// A pending revision whose update may still be in flight is never dropped; the adapter gives up after 15 s.
const SETTLE_AFTER_MS = 60_000;
const QR_API = /^\/api\/qr\/([0-9a-f]{32})$/;
// What the public origin may serve: the proof page, its assets, its read, the client's question and the QR code.
const CLIENT_ROUTE = /^(GET \/proof\/[0-9a-f]{32}|GET \/(proof\.js|product\.css|inter\.ttf)|GET \/api\/proof\/[0-9a-f]{32}|POST \/api\/proof\/[0-9a-f]{32}\/question|GET \/api\/qr\/[0-9a-f]{32})$/;
const isFlowRoute = (path: string) => FLOW_ROUTES.includes(path) || PROOF_API.test(path) || QR_API.test(path);
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/lab', ['lab.html', 'text/html; charset=utf-8']],
  ['/proof.js', ['proof.js', 'text/javascript; charset=utf-8']],
  ['/product.css', ['product.css', 'text/css; charset=utf-8']],
  ['/client.js', ['client.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/flow.js', ['flow.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  // OFL Inter, fetched by `node library/fonts/fonts.mjs fetch app/integrated-ui/fonts inter`; absent, the pages use system fonts.
  ['/inter.ttf', ['fonts/Inter[opsz,wght].ttf', 'font/ttf']],
]);
type Options = { dbPath: string; port?: number; ledgerOptions?: ConstructorParameters<typeof DurableLedger>[1]; paypal?: SandboxPayPal | null; draft?: typeof draftLines; audit?: typeof auditLines; answer?: typeof draftAnswer; publicOrigin?: string };
class InputError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
function expect(ok: unknown, message: string): asserts ok { if (!ok) throw new InputError(400, message); }
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  expect(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object.');
  expect(Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'Unexpected or missing fields.');
}
function positiveRevision(value: unknown): asserts value is number { expect(Number.isSafeInteger(value) && Number(value) > 0, 'Invalid revision.'); }
async function body(request: IncomingMessage, limit = 8192): Promise<unknown> {
  if (request.headers['content-type'] !== 'application/json') throw new InputError(415, 'Use application/json.');
  if (Number(request.headers['content-length']) > limit) { request.resume(); throw new InputError(413, 'Synthetic request is too large.'); }
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw new InputError(413, 'Synthetic request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new InputError(400, 'Malformed JSON.'); }
}

/** Loopback-only local demo. The offline simulation retains its fixed ledger IDs. */
export async function startLocalApp(options: Options) {
  const port = options.port ?? 0;
  expect(Number.isInteger(port) && port >= 0 && port <= 65535, 'Invalid port.');
  const ledger = new DurableLedger(options.dbPath, options.ledgerOptions);
  const provider = new OfflinePayPalMock();
  try {
    try { ledger.snapshot(DRAFT_ID); }
    catch (error) {
      if ((error as Error).message !== 'Draft not found') throw error;
      try { ledger.createDraft(DRAFT_ID, fixture()); }
      catch (conflict) { if ((conflict as Error).message !== 'Stable draft ID already exists; reopen it') throw conflict; }
    }
  } catch (error) { ledger.close(); throw error; }
  function state() {
    const snapshot = ledger.snapshot(DRAFT_ID);
    const hasReceipt = snapshot.remoteId !== null;
    const unresolved = ['CREATING','UNKNOWN'].includes(snapshot.status);
    let summary = 'Review and save the synthetic draft before mock approval.';
    let nextStep = 'No provider operation exists yet.';
    if (snapshot.status === 'APPROVED') { summary = 'This saved revision has a mock approval.'; nextStep = 'Only one durable synthetic create claim is allowed.'; }
    if (unresolved && !hasReceipt) { summary = 'Outcome unresolved: no durable invoice receipt is available.'; nextStep = 'Keep this operation ID. Do not create again or reset the database. This local demo cannot resolve a missing receipt.'; }
    if (unresolved && hasReceipt) { summary = 'A durable receipt exists, but a matching DRAFT read is not confirmed.'; nextStep = 'Use the explicitly simulated read-only lookup below. Timeout, 404, mismatch and malformed reads never authorize another create.'; }
    if (snapshot.status === 'DRAFT_VERIFIED') { summary = 'The saved synthetic receipt matched a simulated DRAFT read.'; nextStep = 'No real PayPal invoice exists. This operation cannot create again.'; }
    if (snapshot.status === 'FAILED') { summary = 'The synthetic operation failed definitively.'; nextStep = 'No automatic or new-ID create retry is available.'; }
    return { ...snapshot, total: validate(snapshot.draft).total, synthetic: true, storage: 'SQLite durable ledger', recovery: {
      summary, nextStep, canReadStoredReceipt: unresolved && hasReceipt, canCreateRetry: false,
      requestId: snapshot.operationId, reasonCode: snapshot.recoveryCode, readChecks: snapshot.readChecks,
      providerMode: 'LOCAL MOCK ONLY',
    } };
  }
  function readSavedReceipt(scenario: ReadScenario) {
    const saved = state(); expect(saved.remoteId !== null, 'No durable receipt; reconciliation is blocked.');
    const read = provider.readInvoice(saved.remoteId, scenario);
    if (read.kind === 'unavailable') ledger.recordReadFailure(OPERATION_ID, read.code);
    else {
      try { ledger.verify(OPERATION_ID, read.remoteId, read.status); }
      catch (error) { if ((error as Error).message !== 'Remote DRAFT not verified; halt') throw error; }
    }
  }
  function safeState() { try { return state(); } catch { return null; } }
  // Proofs live beside the ledger in their own file; the ledger refuses tables it does not own.
  const proofs = new ProofStore(options.dbPath === ':memory:' ? null : `${options.dbPath}.proofs.json`);
  const qrCache = new Map<string, Buffer>();
  // reviews[i] is the AI review of the i-th accepted result, in the order of results.
  // billed[i] names the live invoice that already bills the i-th accepted line's work-log line, or is null.
  let current: { inputs: { log: string; prices: string }; results: ReturnType<typeof verifyQuotes>; reviews: Review[]; reviewModel: string | null; billed: (Billed | null)[]; draftId: string; operationId: string; submitted?: string; proof?: string; rereviews: Map<string, Review> } | null = null;
  /**
   * The invoice whose proof already bills this work-log line: the same whole log line ("Mon 3 Nov: 2 hours design").
   * Approving the same log twice would otherwise create a second invoice for the same work. Every proof that is not
   * revoked counts, including one whose create outcome is still unknown; a create that definitely failed revokes its
   * proof. `except` is the approval's own proof, so a retried approval does not flag itself.
   */
  function billedBefore(log: string, result: { line: { work_quote: string }; work_offset: number }, except?: string): Billed | null {
    const here = sourceLine(log, result.line.work_quote, result.work_offset);
    // The ledger owns create outcomes: a proof saved before refused creates were revoked is skipped by its number here.
    const refused = new Set(ledger.refusedOperations().map(invoiceNumberFor));
    for (const proof of proofs.list()) {
      if (proof.revoked_at || proof.token === except || refused.has(proof.invoice_number)) continue;
      // A proof saved before billed_lines were kept falls back to the first log line holding each quote.
      const lines = proof.billed_lines ?? (proof.sources ? proof.lines.map(l => sourceLine(proof.sources!.log, l.work_quote)) : []);
      const at = lines.indexOf(here);
      if (at >= 0 && proof.lines[at]) return { invoice_number: proof.invoice_number, ref: proof.lines[at]!.ref, created_at: proof.created_at };
    }
    return null;
  }
  /** The AI review of the accepted lines. Without a model key the two examples use their recorded review; any failure leaves a line "not reviewed". */
  async function review(inputs: { log: string; prices: string }, accepted: { description: string; quantity: string; rate: string; work_quote: string; price_quote: string }[], offsets: { work: number; price: number }[], recordedAllowed = true): Promise<{ reviews: Review[]; model: string | null }> {
    if (accepted.length === 0) return { reviews: [], model: null };
    try { const result = await (options.audit ?? auditLines)(accepted, { sources: { ...inputs, offsets } }); return { reviews: result.reviews, model: result.model }; }
    catch {
      // A recorded review describes the example's original lines; an edited line never falls back to it.
      const recorded = recordedAllowed ? recordedReviewsFor(inputs) : null;
      if (recorded && recorded.reviews.length === accepted.length) return recorded;
      return { reviews: accepted.map((_, index) => ({ index, verdict: 'not_reviewed' as const, reason: 'AI review unavailable.' })), model: null };
    }
  }
  // A proof saved before the texts were kept has only its quotes; the reply agent then works from those.
  const sourcesOf = (proof: Proof) => proof.sources ?? { log: proof.lines.map(l => l.work_quote).join('\n'), prices: proof.lines.map(l => l.price_quote).join('\n') };
  const publicProof = (proof: Proof) => ({ token: proof.token, invoice_number: proof.invoice_number, fingerprint: proof.fingerprint, created_at: proof.created_at, sent: proof.sent, lines: proof.lines, questions: proof.questions, revisions: proof.revisions ?? [], refunds: (proof.refunds ?? []).map(({ request_id: _r, capture_id: _c, ...shown }) => shown), refund_pending: proof.pending_refund ? proof.pending_refund.ref : null });
  /** PayPal's own paid and refunded amounts, shown beside the proof; null when PayPal reports none. */
  const money = (read: Awaited<ReturnType<SandboxPayPal['readInvoice']>> | null) => read?.kind === 'invoice' ? { paid: read.paid?.value ?? null, refunded: read.refunded?.value ?? null, refund_ids: read.refunded?.ids ?? [] } : { paid: null, refunded: null, refund_ids: [] };
  // What the client reads inside PayPal: each item's quotes, and a note naming the proof page and its fingerprint.
  const itemDescription = (l: ProofLine) => `${l.ref} · Work: "${l.work_quote}" · Price: "${l.price_quote}"`;
  const itemsFor = (lines: ProofLine[]) => lines.map(l => ({ name: l.description, description: itemDescription(l), quantity: l.quantity, rate: l.rate }));
  const noteFor = (proof: Pick<Proof, 'token' | 'fingerprint'>) => `Every line quotes the work log and the price list. Check each line: ${options.publicOrigin ?? origin}/proof/${proof.token} · Fingerprint ${proof.fingerprint.slice(0, 16)}`;
  // A line whose question names a removed line still needs that line for the reply agent.
  const lineFor = (proof: Proof, ref: string) => proof.lines.find(l => l.ref === ref) ?? proof.revisions?.findLast(r => r.ref === ref)?.before;
  // The questioned line with the log line it was billed from, so a quote of an identical entry elsewhere is not its source.
  const questionedLine = (proof: Proof, ref: string) => {
    const at = proof.lines.findIndex(l => l.ref === ref);
    return { ...lineFor(proof, ref)!, work_line: proof.billed_lines?.[at] ?? null };
  };
  const revising = new Set<string>();
  /**
   * Settles a pending revision by PayPal's own read: applied when PayPal holds the revised lines; dropped when it still
   * holds the approved lines and the update is old enough that a slow request can no longer land (allowDrop);
   * otherwise left pending, and the page shows PayPal's difference. Without PayPal nothing is decided. The caller holds
   * the proof's lock; only the pending revision observed here is acted on.
   */
  async function settle(proof: Proof, allowDrop: boolean): Promise<{ state: 'applied' | 'dropped' | 'unknown'; read: Awaited<ReturnType<SandboxPayPal['readInvoice']>> | null }> {
    const pending = proof.pending;
    if (!pending || !options.paypal || !proof.remote_id) return { state: 'unknown', read: null };
    const read = await options.paypal.readInvoice(proof.remote_id);
    if (proof.pending !== pending) return { state: 'unknown', read };
    if (compare({ ...proof, lines: pending.lines }, read).state === 'match') { proofs.revise(proof.token, pending); return { state: 'applied', read }; }
    const old = !pending.staged_at || Date.now() - Date.parse(pending.staged_at) > SETTLE_AFTER_MS;
    if (allowDrop && old && compare(proof, read).state === 'match') { proofs.clearPending(proof.token); return { state: 'dropped', read }; }
    return { state: 'unknown', read };
  }
  let origin = '';
  const publicOrigin = options.publicOrigin ? new URL(options.publicOrigin) : null;
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('Content-Security-Policy', CSP);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const json = (status: number, value: unknown) => {
      response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(value));
    };
    try {
      // The client may reach the proof page through INVOICEPROOF_PUBLIC_ORIGIN (a proxy in front of this loopback
      // server). That host serves only the client's routes; the freelancer's routes stay on the loopback origin.
      const viaPublic = publicOrigin !== null && request.headers.host === publicOrigin.host;
      if (request.headers.host !== new URL(origin).host && !viaPublic) throw new InputError(403, 'Unrecognized local host.');
      const ownOrigin = viaPublic ? publicOrigin!.origin : origin;
      const requestOrigin = request.headers.origin;
      if (requestOrigin !== undefined && requestOrigin !== ownOrigin) throw new InputError(403, 'Cross-origin requests are blocked.');
      const site = request.headers['sec-fetch-site'];
      const url = new URL(request.url ?? '/', origin);
      if (viaPublic && !CLIENT_ROUTE.test(`${request.method} ${url.pathname}`)) throw new InputError(404, 'Not found.');
      // The client reaches the proof page from a link in the PayPal invoice note: a cross-site navigation. Only that page's GET is let through.
      const proofNavigation = request.method === 'GET' && PROOF_PAGE.test(url.pathname);
      if (!proofNavigation && site !== undefined && site !== 'same-origin' && site !== 'none') throw new InputError(403, 'Cross-site requests are blocked.');
      if (url.origin !== origin || url.search) throw new InputError(400, 'Unsupported request URL.');
      if (url.pathname === '/api/proofs' && request.method === 'GET') {
        json(200, { proofs: proofs.list().map(p => ({ token: p.token, invoice_number: p.invoice_number, remote_id: p.remote_id, created_at: p.created_at, sent: p.sent, revoked: p.revoked_at !== null, lines: p.lines.length, total: totalOf(p.lines), version: (p.revisions?.length ?? 0) + 1, questions: p.questions.length, unanswered: p.questions.filter(q => !q.answer).length })) }); return;
      }
      const resource = /^\/proof\/[0-9a-f]{32}$/.test(url.pathname) ? ['proof.html', 'text/html; charset=utf-8'] : files.get(url.pathname);
      if (resource && request.method === 'GET') {
        const file = fileURLToPath(new URL(`../integrated-ui/${resource[0]}`, import.meta.url));
        if (!existsSync(file)) throw new InputError(404, 'Not found.');
        response.setHeader('Content-Type', resource[1]);
        response.end(readFileSync(file)); return;
      }
      if (url.pathname === '/api/demo-cases' && request.method === 'GET') { json(200, DEMO_CASES); return; }
      if (FLOW_ROUTES.includes(url.pathname) && request.method === 'POST') {
        if (requestOrigin !== origin) throw new InputError(403, 'Same-origin mutation required.');
        const input = await body(request, 200000);
        if (url.pathname === '/api/draft') {
          object(input, ['log', 'prices']);
          for (const key of ['log', 'prices']) expect(typeof input[key] === 'string' && (input[key] as string).length > 0 && (input[key] as string).length <= 20000, 'Inputs must contain 1 to 20000 characters.');
          const inputs = { log: input.log as string, prices: input.prices as string };
          current = null;
          try {
            // Without a model key the two examples fall back to a recorded reply; any other text still needs the key.
            const drafted: { lines: unknown[]; model: string; recorded_at?: string } = await (options.draft ?? draftLines)(inputs).catch(error => { const recorded = (error as Error).message === 'MISSING_API_KEY' ? recordedReplyFor(inputs) : null; if (!recorded) throw error; return recorded; });
            const results = verifyQuotes(inputs, drafted.lines);
            const acceptedResults = results.flatMap(result => result.status === 'accepted' ? [result] : []);
            const accepted = acceptedResults.map(result => result.line);
            const offsets = acceptedResults.map(result => ({ work: result.work_offset, price: result.price_offset }));
            // Recorded drafting goes with the recorded review, so a keyless run shows the same pair it was recorded with.
            const reviewed = drafted.recorded_at ? (recordedReviewsFor(inputs) ?? await review(inputs, accepted, offsets)) : await review(inputs, accepted, offsets);
            const billed = acceptedResults.map(result => billedBefore(inputs.log, result));
            current = { inputs, results, reviews: reviewed.reviews, reviewModel: reviewed.model, billed, draftId: randomUUID(), operationId: randomUUID(), rereviews: new Map() };
            json(200, { draft_id: current.draftId, model: drafted.model, recorded_at: drafted.recorded_at ?? null, results, reviews: reviewed.reviews, review_model: reviewed.model, billed });
          } catch (error) {
            const message = (error as Error).message;
            const code = message === 'MISSING_API_KEY' ? 'MODEL_NOT_CONFIGURED' : message === 'MODEL_OUTPUT_NOT_JSON' ? 'MODEL_REPLY_INVALID' : 'MODEL_REQUEST_FAILED';
            json(code === 'MODEL_NOT_CONFIGURED' ? 503 : 502, { errorCode: code });
          }
          return;
        }
        if (url.pathname === '/api/flow-send') {
          // The current draft names its proof; a draft reopened after a reload names the proof directly.
          let proof: Proof | null;
          if (input !== null && typeof input === 'object' && 'proof' in input) { object(input, ['proof']); proof = typeof input.proof === 'string' ? proofs.live(input.proof) : null; }
          else { object(input, ['draft']); expect(current && input.draft === current.draftId, 'Approve the current draft first.'); proof = current.proof ? proofs.get(current.proof) : null; }
          expect(proof?.remote_id, 'Approve the current draft first.');
          const remoteId = proof.remote_id;
          let viewUrl: string | null = null;
          // Sending happens once per proof; a repeated press only reads the invoice again.
          if (options.paypal && !proof.sent) { viewUrl = await options.paypal.sendInvoice(remoteId); proofs.update(proof.token, { sent: true }); }
          if (!options.paypal) { proofs.update(proof.token, { sent: true }); json(200, { mode: 'offline-mock', status: 'UNPAID', payer_view_url: null, qr_path: null, read_at: new Date().toISOString() }); return; }
          const read = await options.paypal.readInvoice(remoteId);
          if (read.kind !== 'invoice') throw new InputError(409, 'Invoice read-back unavailable.');
          json(200, { mode: 'sandbox', status: read.status, payer_view_url: read.recipient_view_url ?? viewUrl, qr_path: `/api/qr/${proof.token}`, read_total: read.total ?? null, read_at: new Date().toISOString() }); return;
        }
        expect(input !== null && typeof input === 'object' && !Array.isArray(input), 'Expected a JSON object.');
        object(input, ['draft', 'lines', 'reviewed', ...['overrides', 'origins'].filter(k => k in input)]);
        expect(current && Array.isArray(input.lines) && input.lines.length > 0, 'Draft and select lines first.');
        // The lines on the page must come from the draft held here: a page still showing an older draft (the text
        // changed, or another draft finished later) is refused before anything is checked or created.
        if (input.draft !== current.draftId) { json(409, { errorCode: 'DRAFT_OUT_OF_DATE' }); return; }
        // The person states, line by line, that they compared the line with its quotes. The app cannot check that
        // statement; it only refuses to create anything while a line lacks it.
        if (!Array.isArray(input.reviewed) || input.reviewed.length !== input.lines.length || input.reviewed.some(mark => mark !== true)) { json(422, { errorCode: 'LINES_NOT_REVIEWED' }); return; }
        const session = current!;
        const results = verifyQuotes(session.inputs, input.lines as unknown[]);
        const acceptedResults = session.results.flatMap(result => result.status === 'accepted' ? [result] : []);
        const accepted = acceptedResults.map(result => result.line);
        const remaining = accepted.map((line, index) => ({ line, index }));
        const origins: number[] = [];   // for each submitted line, the index of the accepted line it came from (its quotes are unchanged)
        // The page names each line's origin, so two lines with the same quotes keep their own review label; a caller
        // that names none is matched by quotes in order.
        const named = Array.isArray(input.origins) && input.origins.length === results.length ? input.origins as unknown[] : null;
        const rejected = results.map((result, i) => {
          if (result.status === 'rejected') return result;
          const same = ({ line, index }: { line: typeof result.line; index: number }) => line.work_quote === result.line.work_quote && line.price_quote === result.line.price_quote && (!named || named[i] === index);
          const index = remaining.findIndex(same);
          if (index < 0) return { status: 'rejected', line: result.line, reason: 'ORIGINAL_LINE_NOT_ACCEPTED' };
          origins.push(remaining[index]!.index); remaining.splice(index, 1);
          return result;
        });
        if (rejected.some(result => result.status === 'rejected')) { json(422, { results: rejected }); return; }
        const lines = (input.lines as any[]);
        // A line the AI review did not support needs the person's reason to keep it; the reason goes into the proof.
        const overrides: (string | null)[] = Array.isArray(input.overrides) ? input.overrides as (string | null)[] : lines.map(() => null);
        expect(overrides.length === lines.length && overrides.every(o => o === null || (typeof o === 'string' && o.trim().length > 0 && o.length <= 200)), 'Invalid override reasons.');
        // A line edited after the AI review (description, quantity or rate) is reviewed again; the old verdict was about other words.
        const edited = lines.flatMap((line, i) => { const original = accepted[origins[i]!]!; return ['description', 'quantity', 'rate'].some(k => String(line[k]) !== String((original as any)[k])) ? [i] : []; });
        const key = (line: any) => JSON.stringify([line.description, line.quantity, line.rate, line.work_quote, line.price_quote]);
        const fresh = edited.filter(i => !session.rereviews.has(key(lines[i])));
        const failed = new Map<string, Review>();
        if (fresh.length) {
          const again = await review(session.inputs, fresh.map(i => lines[i]), fresh.map(i => { const origin = acceptedResults[origins[i]!]!; return { work: origin.work_offset, price: origin.price_offset }; }), false);
          // Only real verdicts are kept; a failed call is tried again on the next approval.
          fresh.forEach((i, n) => { const r = { ...again.reviews[n]!, index: origins[i]! }; if (r.verdict === 'not_reviewed') failed.set(key(lines[i]), r); else session.rereviews.set(key(lines[i]), r); });
        }
        const reviews = origins.map((index, i) => (edited.includes(i) ? session.rereviews.get(key(lines[i])) ?? failed.get(key(lines[i])) : session.reviews[index]) ?? { index, verdict: 'not_reviewed' as const, reason: 'AI review unavailable.' });
        // A work-log line already on a live invoice is billed again only with the person's reason, as a disputed line is.
        // Checked again here, not taken from the draft: an earlier invoice may have been created or resolved since.
        const billed = origins.map(index => billedBefore(session.inputs.log, acceptedResults[index]!, session.proof));
        const twice = billed.flatMap((b, i) => b && !overrides[i] ? [i] : []);
        if (twice.length) { json(422, { errorCode: 'ALREADY_INVOICED', indexes: twice, billed }); return; }
        const missing = reviews.flatMap((r, i) => r.verdict !== 'supports' && !overrides[i] ? [i] : []);
        if (missing.length) { json(422, { errorCode: 'REVIEW_OVERRIDE_REQUIRED', indexes: missing, reviews: reviews.map(r => ({ verdict: r.verdict, reason: r.reason })) }); return; }
        const submitted = JSON.stringify(lines);
        expect(!session.submitted || session.submitted === submitted, 'The operation already has an approved set of lines.');
        const draft = { currency: 'USD' as const, evidence: lines.map((line, i) => ({ id: `e-${i}`, documentId: 'PASTED', text: `${line.work_quote} ${line.price_quote}`, completed: true, quantity: line.quantity, rate: line.rate, currency: 'USD' as const })), lines: lines.map((line, i) => ({ id: `l-${i}`, evidenceId: `e-${i}`, description: line.description, quantity: line.quantity, rate: line.rate, currency: 'USD' as const })) };
        const id = session.draftId, operation = session.operationId;
        let snapshot;
        try { snapshot = ledger.snapshot(id); } catch { ledger.createDraft(id, draft); snapshot = ledger.snapshot(id); }
        if (snapshot.status === 'NEEDS_REVIEW') { ledger.edit(id, draft, snapshot.revision); snapshot = ledger.snapshot(id); ledger.approve(id, snapshot.revision); snapshot = ledger.snapshot(id); }
        if (snapshot.status === 'APPROVED') {
          session.submitted = submitted;
          const claim = ledger.begin(id, operation, snapshot.approval!);
          if (claim.started) {
            // The proof exists before the invoice, so the invoice note can name it. Each line keeps the label the
            // review screen gave it (its place among all drafted lines, blocked ones included), so a disputed L5
            // stays L5 on the proof page, the refund and PayPal; a repeated origin falls back to plain numbering.
            const reviewRefs = origins.map(o => `L${session.results.indexOf(acceptedResults[o]!) + 1}`);
            const refOf = (i: number) => new Set(reviewRefs).size === reviewRefs.length ? reviewRefs[i]! : `L${i + 1}`;
            const proofLines = lines.map((line, i) => ({ ref: refOf(i), description: String(line.description), quantity: String(line.quantity), rate: String(line.rate), currency: 'USD' as const, work_quote: String(line.work_quote), price_quote: String(line.price_quote), review: { verdict: reviews[i]!.verdict, reason: reviews[i]!.reason, model: session.reviewModel }, override: overrides[i] ? overrides[i]!.trim() : null }));
            const billedLines = origins.map((index, i) => sourceLine(session.inputs.log, proofLines[i]!.work_quote, acceptedResults[index]!.work_offset) ?? proofLines[i]!.work_quote);
            const proof = proofs.create({ invoice_number: invoiceNumberFor(operation), fingerprint: fingerprint(session.inputs, proofLines), lines: proofLines, sources: session.inputs, billed_lines: billedLines });
            session.proof = proof.token;
            const presentation = { itemDescriptions: proofLines.map(itemDescription), note: noteFor(proof) };
            const created = options.paypal ? await options.paypal.createDraft(draft, operation, presentation) : provider.createDraft(draft, operation, 'DRAFT');
            if (created.kind === 'receipt') ledger.recordOutcome(operation, 'created', created.remoteId);
            else {
              ledger.recordOutcome(operation, created.kind === 'failed' ? 'failed' : 'unknown');
              // A refused create bills nothing: its proof is revoked, so the same work is not flagged as invoiced.
              if (created.kind === 'failed') proofs.update(proof.token, { revoked_at: new Date().toISOString() });
            }
          }
        }
        snapshot = ledger.snapshot(id);
        // An open outcome is resolved only by looking the invoice up under this operation's invoice number, never by a second create.
        if (!snapshot.remoteId && options.paypal && ['CREATING', 'UNKNOWN'].includes(snapshot.status)) {
          const found = await options.paypal.findByOperation(operation);
          if (found.kind === 'found') ledger.recordLookup(operation, found.remoteId);
          snapshot = ledger.snapshot(id);
        }
        if (!snapshot.remoteId) throw new InputError(409, 'Invoice outcome remains unresolved.');
        const read = options.paypal ? await options.paypal.readInvoice(snapshot.remoteId) : provider.readInvoice(snapshot.remoteId, 'DRAFT');
        if (read.kind !== 'invoice') throw new InputError(409, 'Invoice read-back unavailable.');
        if (snapshot.status !== 'DRAFT_VERIFIED') ledger.verify(operation, read.remoteId, read.status);
        const proof = session.proof ? proofs.get(session.proof) : null;
        if (proof && proof.remote_id !== read.remoteId) proofs.update(proof.token, { remote_id: read.remoteId });
        json(200, { mode: options.paypal ? 'sandbox' : 'offline-mock', invoice_id: read.remoteId, invoice_number: invoiceNumberFor(operation), status: read.status, read_number: read.number ?? null, read_total: read.total ?? null, read_at: new Date().toISOString(), proof_path: proof ? `/proof/${proof.token}` : null, fingerprint: proof?.fingerprint ?? null }); return;
      }
      const proofApi = PROOF_API.exec(url.pathname);
      if (proofApi) {
        const [, token, action] = proofApi;
        if (!action && request.method === 'GET') {
          const proof = proofs.live(token!); if (!proof) throw new InputError(404, 'Not found.');
          // A revision left pending by a lost reply or a restart is settled here, unless one is running right now.
          let settled: Awaited<ReturnType<typeof settle>>['read'] | undefined;
          if (proof.pending && !revising.has(proof.token)) { revising.add(proof.token); try { settled = (await settle(proof, true)).read; } finally { revising.delete(proof.token); } }
          const read = settled !== undefined ? settled : options.paypal && proof.remote_id ? await options.paypal.readInvoice(proof.remote_id) : null;
          json(200, { ...publicProof(proof), mode: options.paypal ? 'sandbox' : 'offline-mock', paypal: { ...compare(proof, read), ...money(read), read_at: new Date().toISOString(), payer_view_url: read?.kind === 'invoice' ? read.recipient_view_url ?? null : null } }); return;
        }
        if (action && request.method === 'POST') {
          if (requestOrigin !== ownOrigin) throw new InputError(403, 'Same-origin mutation required.');
          const input = await body(request);
          if (action === 'revoke') {
            object(input, []); const proof = proofs.live(token!); expect(proof, 'Not found.');
            if (revising.has(token!)) { json(409, { errorCode: 'REVISION_IN_PROGRESS' }); return; }
            // A revision PayPal may still apply is settled first: a revoked proof can no longer be settled or shown.
            if (proof.pending) {
              revising.add(token!);
              try { await settle(proof, true); } finally { revising.delete(token!); }
              if (proof.pending) { json(409, { errorCode: 'REVISION_UNCONFIRMED' }); return; }
            }
            // A refund PayPal may have made must be confirmed (by retrying it) before the proof that records it goes away.
            if (proof.pending_refund) { json(409, { errorCode: 'REFUND_UNCONFIRMED' }); return; }
            proofs.update(token!, { revoked_at: new Date().toISOString() }); json(200, { ok: true }); return;
          }
          if (action === 'answer-draft') {
            // The answer agent drafts from the stored texts; the freelancer edits it and publishes with /answer.
            object(input, ['index']);
            const proof = proofs.live(token!); if (!proof) throw new InputError(404, 'Not found.');
            const question = Number.isSafeInteger(input.index) ? proof.questions[input.index as number] : undefined;
            expect(question, 'Unknown question.');
            const line = questionedLine(proof, question.ref);
            try {
              const drafted = await (options.answer ?? draftAnswer)({ question: question.note, line, sources: sourcesOf(proof) });
              // Beside the reply, the app suggests what to do with the line itself, from the review it already holds.
              // A line already removed from the invoice has nothing left to give back.
              // A line already refunded has nothing left either, and earlier refunds are taken off what stays paid.
              const refunds = proof.refunds ?? [];
              const current = refunds.some(r => r.ref === question.ref) ? undefined : proof.lines.find(l => l.ref === question.ref);
              json(200, { ...drafted, resolution: current ? suggestResolution(current, proof.lines, drafted, refunds.map(r => r.amount)) : null });
            } catch (error) { json(502, { errorCode: (error as Error).message === 'MODEL_OUTPUT_NOT_JSON' ? 'MODEL_REPLY_INVALID' : 'MODEL_REQUEST_FAILED' }); }
            return;
          }
          if (action === 'answer') {
            object(input, ['index', 'text', 'quote', 'drafted_by']);
            const proof = proofs.live(token!); if (!proof) throw new InputError(404, 'Not found.');
            const question = Number.isSafeInteger(input.index) ? proof.questions[input.index as number] : undefined;
            expect(question, 'Unknown question.');
            expect(typeof input.text === 'string' && input.text.trim().length > 0 && input.text.length <= 400, 'An answer needs 1 to 400 characters.');
            expect(input.drafted_by === null || (typeof input.drafted_by === 'string' && input.drafted_by.length <= 80), 'Invalid model name.');
            // A quote is published only if it is still found verbatim in the texts the invoice was drafted from, and
            // only from the log or price entry behind the questioned line: the same rule the reply agent's draft obeys.
            const quote = input.quote === null ? null : groundedQuote(input.quote, sourcesOf(proof));
            expect(input.quote === null || quote !== null, 'The quote is not in the work log or price list.');
            expect(quote === null || quoteOnLine(quote, questionedLine(proof, question.ref), sourcesOf(proof)), 'The quote is from another log or price entry, not this line\'s.');
            json(200, { questions: proofs.answer(token!, input.index as number, { text: (input.text as string).trim(), quote, drafted_by: input.drafted_by as string | null, at: new Date().toISOString() }) }); return;
          }
          if (action === 'refund') {
            // After payment the freelancer gives a line back, usually one the client questioned and the sources do not
            // support: exactly its amount is refunded on the client's PayPal payment. The invoice items stay as paid.
            // The two settle fields are optional and only read for a staged refund outside the retry window.
            object(input, ['ref', 'reason', ...(input && typeof input === 'object' ? ['refund_id', 'not_refunded', 'quantity'].filter(key => key in input) : [])]);
            const proof = proofs.live(token!); if (!proof) throw new InputError(404, 'Not found.');
            if (!options.paypal || !proof.remote_id) { json(409, { errorCode: 'REFUND_NEEDS_PAYPAL' }); return; }
            if (revising.has(proof.token)) { json(409, { errorCode: 'REVISION_IN_PROGRESS' }); return; }
            revising.add(proof.token);
            try {
              let pending = proof.pending_refund ?? null;
              if (!pending) {
                const line = proof.lines.find(l => l.ref === input.ref);
                expect(line, 'Unknown line.');
                expect(typeof input.reason === 'string' && input.reason.trim().length > 0 && input.reason.length <= 200, 'A refund needs a reason of 1 to 200 characters.');
                if ((proof.refunds ?? []).some(r => r.ref === line.ref)) { json(409, { errorCode: 'ALREADY_REFUNDED' }); return; }
                const read = await options.paypal.readInvoice(proof.remote_id);
                if (read.kind !== 'invoice') throw new InputError(409, 'Invoice read-back unavailable.');
                if (!REFUNDABLE.has(read.status)) { json(409, { errorCode: 'INVOICE_NOT_PAID', status: read.status }); return; }
                // The refund is measured against the invoice this proof approved; one changed elsewhere is not refunded from here.
                if (compare(proof, read).state !== 'match') { json(409, { errorCode: 'INVOICE_CHANGED_ELSEWHERE' }); return; }
                const captures = (read.paid?.transactions ?? []).filter(t => t.payment_id);
                if (!read.paid || captures.length !== 1 || read.paid.transactions.length !== 1) { json(409, { errorCode: 'PAYMENT_NOT_REFUNDABLE' }); return; }
                // Part of a line can be given back: a quantity above zero and below the line's, priced at the line's own rate.
                const part = input.quantity === undefined || Number(input.quantity) === Number(line.quantity) ? null : input.quantity;
                if (part !== null) expect(typeof part === 'string' && /^\d{1,6}(\.\d{1,2})?$/.test(part) && Number(part) > 0 && Number(part) < Number(line.quantity), 'The quantity to give back must be above zero and at most the quantity of the line.');
                const amount = totalOf([part === null ? line : { ...line, quantity: part as string }]);
                if (cents(amount) <= 0 || cents(amount) > cents(read.paid.value) - cents(read.refunded?.value ?? '0')) { json(409, { errorCode: 'REFUND_EXCEEDS_PAID' }); return; }
                pending = proofs.stageRefund(proof.token, { ref: line.ref, reason: (input.reason as string).trim(), amount, request_id: randomUUID(), capture_id: captures[0]!.payment_id!, ...(part === null ? {} : { quantity: part as string }) });
              } else if (pending.ref !== input.ref) { json(409, { errorCode: 'REFUND_UNCONFIRMED', ref: pending.ref }); return; }
              // A refund already held by its PayPal id is only read back, and a settlement outside the retry window sends
              // nothing to PayPal: only those two skip the amount check.
              else if (!pending.refund_id && !(refundRetryExpired(pending) && (typeof input.refund_id === 'string' || input.not_refunded === true))) {
                // A retry sends the staged amount, so the click must have confirmed that amount: a different quantity is refused, not ignored.
                const staged = proof.lines.find(l => l.ref === pending!.ref)!;
                const asked = input.quantity === undefined || Number(input.quantity) === Number(staged.quantity) ? null : Number(input.quantity);
                if (asked !== (pending.quantity ? Number(pending.quantity) : null)) { json(409, { errorCode: 'REFUND_STAGED_DIFFERS', amount: pending.amount, quantity: pending.quantity ?? null }); return; }
              }
              // A staged refund is sent again with its saved request id: PayPal answers with the refund it already made, if any.
              const line = proof.lines.find(l => l.ref === pending!.ref)!;
              // A refund PayPal already accepted is read back by its id instead of being requested again.
              let refund: { id: string; status: string; note?: string };
              // Outside PayPal's request-id window a resend could refund twice, so it is not sent (see REFUND_RETRY_DAYS).
              // A person settles it from PayPal instead: with the refund id PayPal shows, which is read back and must carry
              // the staged amount, or by saying no refund was made, which PayPal's refunded total must confirm.
              if (refundRetryExpired(pending)) {
                if (typeof input.refund_id !== 'string' && input.not_refunded !== true) { json(409, { errorCode: 'REFUND_RETRY_EXPIRED', staged_at: pending.staged_at }); return; }
                // Either answer is checked against this invoice as PayPal holds it now; a failed read settles nothing.
                const read = await options.paypal.readInvoice(proof.remote_id);
                if (read.kind !== 'invoice') throw new InputError(409, 'Invoice read-back unavailable.');
                if (typeof input.refund_id === 'string') {
                  // The refund must be one PayPal lists on this invoice, for the staged amount, and not recorded yet.
                  const found = read.refunded?.ids.includes(input.refund_id) ? await options.paypal.readRefund(input.refund_id).catch(() => null) : null;
                  if (!found || found.amount === null || cents(found.amount) !== cents(pending.amount) || (proof.refunds ?? []).some(r => r.refund_id === found.id)) { json(409, { errorCode: 'REFUND_ID_NOT_MATCHING' }); return; }
                  proofs.holdPendingRefund(proof.token, found.id); pending = { ...pending, refund_id: found.id };
                } else {
                  const recorded = (proof.refunds ?? []).reduce((sum, r) => sum + cents(r.amount), 0);
                  if (cents(read.refunded?.value ?? '0') !== recorded) { json(409, { errorCode: 'REFUND_FOUND_ON_PAYPAL' }); return; }
                  proofs.clearPendingRefund(proof.token); json(200, { cleared: true }); return;
                }
              }
              try {
                refund = pending.refund_id ? await options.paypal.readRefund(pending.refund_id)
                  : await options.paypal.refundCapture(pending.capture_id, pending.amount, pending.request_id, `${line.ref} ${line.description.slice(0, 120)}${pending.quantity ? ` (${pending.quantity} of ${line.quantity})` : ''}: ${pending.reason}`);
              } catch (error) {
                if ((error as Error).message === 'REFUND_REFUSED') { proofs.clearPendingRefund(proof.token); json(502, { errorCode: 'PAYPAL_REFUND_REFUSED', issue: (error as { issue?: string | null }).issue ?? null }); return; }
                // `simulated` is set only by the opt-in INVOICEPROOF_FAULT demo, so the page can say the loss was staged.
                json(502, { errorCode: 'PAYPAL_REFUND_UNCONFIRMED', simulated: (error as { simulated?: boolean }).simulated === true }); return;
              }
              // Only a completed refund is shown to the client as money returned. A failed or cancelled one is cleared;
              // any other status (PENDING) stays staged, blocking revoke and other refunds until it settles.
              if (REFUND_FAILED.has(refund.status)) { proofs.clearPendingRefund(proof.token); json(502, { errorCode: 'PAYPAL_REFUND_REFUSED', issue: refund.status }); return; }
              if (refund.status !== 'COMPLETED') { proofs.holdPendingRefund(proof.token, refund.id); json(409, { errorCode: 'PAYPAL_REFUND_PENDING', status: refund.status }); return; }
              // The note is kept as PayPal holds it; a reply without one (a repeated request) is read back once by id.
              if (!refund.note) refund = { ...refund, note: (await options.paypal.readRefund(refund.id).catch(() => null))?.note };
              const recorded = proofs.recordRefund(proof.token, pending, refund);
              const read = await options.paypal.readInvoice(proof.remote_id);
              json(200, { ...publicProof(recorded), mode: 'sandbox', paypal: { ...compare(recorded, read), ...money(read), read_at: new Date().toISOString() } }); return;
            } finally { revising.delete(proof.token); }
          }
          if (action === 'revise') {
            // The freelancer corrects an approved invoice, usually after a client's question: a line is removed, or
            // its quantity or rate changes to numbers the same quotes still show. The revision is saved as pending,
            // PayPal's invoice is updated in place, and the proof takes the revision once PayPal holds it.
            object(input, ['ref', 'action', 'quantity', 'rate', 'reason']);
            const proof = proofs.live(token!); if (!proof) throw new InputError(404, 'Not found.');
            // One revision at a time per proof, and no revoke meanwhile: the lines read here are the lines replaced.
            if (revising.has(proof.token)) { json(409, { errorCode: 'REVISION_IN_PROGRESS' }); return; }
            revising.add(proof.token);
            try {
              // An earlier revision whose PayPal outcome was never confirmed is settled first.
              if (proof.pending) { await settle(proof, true); if (proof.pending) { json(409, { errorCode: 'REVISION_UNCONFIRMED' }); return; } }
              const index = proof.lines.findIndex(l => l.ref === input.ref);
              expect(index >= 0, 'Unknown line.');
              expect(input.action === 'remove' || input.action === 'change', 'Unknown revision.');
              expect(typeof input.reason === 'string' && input.reason.trim().length > 0 && input.reason.length <= 200, 'A revision needs a reason of 1 to 200 characters.');
              const reason = (input.reason as string).trim(), old = proof.lines[index]!, sources = sourcesOf(proof);
              let lines: ProofLine[];
              if (input.action === 'remove') {
                expect(input.quantity === null && input.rate === null, 'A removal takes no quantity or rate.');
                if (proof.lines.length === 1) { json(422, { errorCode: 'LAST_LINE' }); return; }
                lines = proof.lines.filter((_, i) => i !== index);
              } else {
                expect(typeof input.quantity === 'string' && typeof input.rate === 'string', 'A change needs a quantity and a rate.');
                const changed = { description: old.description, quantity: input.quantity as string, rate: input.rate as string, work_quote: old.work_quote, price_quote: old.price_quote };
                expect(changed.quantity !== old.quantity || changed.rate !== old.rate, 'Nothing changed.');
                // The changed numbers must still be found in the same quotes, as at drafting.
                const [checked] = verifyQuotes(sources, [changed]);
                if (checked!.status !== 'accepted') { json(422, { errorCode: 'QUOTE_CHECK_FAILED', reason: checked!.reason }); return; }
                const again = await review(sources, [changed], [{ work: checked!.work_offset, price: checked!.price_offset }], false);
                const verdict = again.reviews[0]!;
                lines = proof.lines.map((l, i) => i === index ? { ...l, quantity: changed.quantity, rate: changed.rate, review: { verdict: verdict.verdict, reason: verdict.reason, model: again.model }, override: verdict.verdict === 'supports' ? null : reason } : l);
              }
              const billed = proof.billed_lines && input.action === 'remove' ? proof.billed_lines.filter((_, i) => i !== index) : proof.billed_lines;
              const change = { action: input.action as 'remove' | 'change', ref: old.ref, reason, lines, billed_lines: billed, fingerprint: fingerprint(sources, lines) };
              if (options.paypal && proof.remote_id) {
                const read = await options.paypal.readInvoice(proof.remote_id);
                if (read.kind !== 'invoice') throw new InputError(409, 'Invoice read-back unavailable.');
                if (!REVISABLE.has(read.status)) { json(409, { errorCode: 'INVOICE_NOT_REVISABLE', status: read.status }); return; }
                // Only the invoice this proof approved is overwritten; a change made to it elsewhere in PayPal is shown, never replaced.
                if (compare(proof, read).state !== 'match') { json(409, { errorCode: 'INVOICE_CHANGED_ELSEWHERE' }); return; }
                proofs.stage(proof.token, change);
                try { await options.paypal.updateInvoice(proof.remote_id, itemsFor(lines), noteFor({ token: proof.token, fingerprint: change.fingerprint }), { items: itemsFor(proof.lines), note: noteFor(proof) }); }
                catch (error) {
                  if ((error as Error).message === 'UPDATE_CONFLICT') { proofs.clearPending(proof.token); json(409, { errorCode: 'INVOICE_CHANGED_ELSEWHERE' }); return; }
                  // A definite refusal (for example a payment that landed after the read) leaves the proof as approved.
                  if ((error as Error).message === 'UPDATE_REFUSED') { proofs.clearPending(proof.token); json(502, { errorCode: 'PAYPAL_UPDATE_REFUSED' }); return; }
                  // A lost reply: PayPal's own read decides; a revision not seen there yet stays pending.
                  const outcome = await settle(proof, false);
                  if (outcome.state !== 'applied') { json(502, { errorCode: 'PAYPAL_UPDATE_UNCONFIRMED' }); return; }
                  json(200, { ...publicProof(proof), mode: 'sandbox', paypal: { ...compare(proof, outcome.read), read_at: new Date().toISOString() } }); return;
                }
              }
              const revised = proofs.revise(proof.token, change);
              const read = options.paypal && revised.remote_id ? await options.paypal.readInvoice(revised.remote_id) : null;
              json(200, { ...publicProof(revised), mode: options.paypal ? 'sandbox' : 'offline-mock', paypal: { ...compare(revised, read), read_at: new Date().toISOString() } }); return;
            } finally { revising.delete(proof.token); }
          }
          object(input, ['ref', 'note']);
          const proof = proofs.live(token!); if (!proof) throw new InputError(404, 'Not found.');
          expect(proof.lines.some(line => line.ref === input.ref), 'Unknown line.');
          expect(typeof input.note === 'string' && input.note.trim().length > 0 && input.note.length <= 300, 'A question needs 1 to 300 characters.');
          json(200, { questions: proofs.ask(token!, input.ref as string, (input.note as string).trim()) }); return;
        }
        throw new InputError(405, 'Method not allowed.');
      }
      const qrApi = QR_API.exec(url.pathname);
      if (qrApi && request.method === 'GET') {
        const proof = proofs.live(qrApi[1]!);
        if (!proof?.remote_id || !proof.sent || !options.paypal) throw new InputError(404, 'Not found.');
        let png = qrCache.get(proof.token);
        if (!png) { png = await options.paypal.generateQrCode(proof.remote_id); qrCache.set(proof.token, png); }
        response.setHeader('Content-Type', 'image/png'); response.end(png); return;
      }
      if (url.pathname === '/api/state' && request.method === 'GET') { json(200, { ok: true, state: state() }); return; }
      const routes = ['/api/edit', '/api/approve', '/api/simulate', '/api/recover', '/api/reconcile'];
      if (!routes.includes(url.pathname)) throw new InputError(404, 'Not found.');
      if (request.method !== 'POST') throw new InputError(405, 'Use POST.');
      if (requestOrigin !== origin) throw new InputError(403, 'Same-origin mutation required.');
      const payload = await body(request);
      if (url.pathname === '/api/edit') {
        object(payload, ['expectedRevision', 'description', 'quantity', 'rate']); positiveRevision(payload.expectedRevision);
        for (const key of ['description', 'quantity', 'rate']) expect(typeof payload[key] === 'string', 'Expected text fields.');
        expect((payload.description as string).trim().length > 0 && (payload.description as string).length <= 200, 'Description must contain 1–200 characters.');
        const draft = fixture(); draft.lines[0].description = payload.description as string; draft.lines[0].quantity = payload.quantity as string; draft.lines[0].rate = payload.rate as string;
        ledger.edit(DRAFT_ID, draft, payload.expectedRevision);
      } else if (url.pathname === '/api/approve') {
        object(payload, ['expectedRevision']); positiveRevision(payload.expectedRevision);
        ledger.approve(DRAFT_ID, payload.expectedRevision);
      } else if (url.pathname === '/api/simulate') {
        object(payload, ['approval', 'outcome']); expect(typeof payload.approval === 'string', 'Approval is required.');
        expect(['DRAFT', 'LINK_RECEIPT', 'RECEIPT_SAVED', 'UNKNOWN', 'FAILED'].includes(payload.outcome as string), 'Unsupported synthetic outcome.');
        const claim = ledger.begin(DRAFT_ID, OPERATION_ID, payload.approval);
        if (claim.started) {
          // The provider has no transport. Every result is a local fixture, after durable commit.
          const result = provider.createDraft(state().draft, OPERATION_ID, payload.outcome as 'DRAFT' | 'LINK_RECEIPT' | 'RECEIPT_SAVED' | 'UNKNOWN' | 'FAILED');
          if (result.kind === 'receipt') {
            ledger.recordOutcome(OPERATION_ID, 'created', result.remoteId);
            if (payload.outcome !== 'RECEIPT_SAVED') readSavedReceipt('DRAFT');
          } else ledger.recordOutcome(OPERATION_ID, result.kind === 'failed' ? 'failed' : 'unknown');
        }
        json(200, { ok: true, started: claim.started, state: state() }); return;
      } else if (url.pathname === '/api/recover') {
        object(payload, []); ledger.markInterrupted(OPERATION_ID);
      } else {
        if (payload !== null && typeof payload === 'object' && Object.keys(payload).length === 0) object(payload, []);
        else object(payload, ['scenario']);
        const scenario = (payload as Record<string, unknown>).scenario ?? 'DRAFT';
        expect(readScenarios.includes(scenario as ReadScenario), 'Unsupported synthetic read scenario.');
        readSavedReceipt(scenario as ReadScenario);
      }
      json(200, { ok: true, state: state() });
    } catch (error) {
      const e = error as Error & { code?: string };
      const storageError = Boolean(e.code?.startsWith('ERR_SQLITE'));
      // The sandbox flow can fail inside the provider adapter; its raw message stays out of the reply. The offline simulation keeps its own messages.
      const flowRoute = isFlowRoute((request.url ?? '').split('?')[0]!);
      const status = error instanceof InputError ? error.status : storageError ? 503 : 409;
      const errorCode = storageError ? 'STORAGE_UNAVAILABLE' : e.message === 'Stale revision' ? 'STALE_REVISION' : e.message === 'Stale approval' ? 'STALE_APPROVAL' : /differs from evidence/.test(e.message) ? 'EVIDENCE_MISMATCH' : /blocked|not expected/.test(e.message) ? 'OPERATION_LOCKED' : error instanceof InputError ? 'INVALID_REQUEST' : 'REQUEST_REJECTED';
      json(status, { ok: false, errorCode, error: storageError ? 'Storage unavailable. Do not retry the simulation. Refresh authoritative state first.' : flowRoute && !(error instanceof InputError) ? 'Request rejected.' : e.message, state: status === 403 ? null : safeState() });
    }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('No local server address')); return; }
        origin = `http://127.0.0.1:${address.port}`; resolve();
      });
    });
  } catch (error) { ledger.close(); throw error; }
  let closed = false;
  return { origin, server, close: async () => {
    if (closed) return;
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
    ledger.close(); closed = true;
  } };
}
