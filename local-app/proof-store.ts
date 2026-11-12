// The client-facing proof of one approved invoice: each line with the quotes behind it, the AI review and any
// override reason, and the questions the client asked. Kept in its own JSON file beside the ledger, because the
// ledger refuses tables it does not own. The proof holds only the quotes, never the whole work log or price list.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export type Review = { verdict: 'supports' | 'disputes' | 'not_reviewed'; reason: string; model: string | null };
export type ProofLine = { ref: string; description: string; quantity: string; rate: string; currency: 'USD'; work_quote: string; price_quote: string; review: Review; override: string | null };
/** The freelancer's published reply to a question. `quote` is words found verbatim in the work log or price list, or null. */
export type Answer = { text: string; quote: string | null; drafted_by: string | null; at: string };
export type Question = { ref: string; note: string; at: string; answer?: Answer | null };
/**
 * `sources` and `billed_lines` stay on this machine: the client sees quotes, never the whole texts.
 * `billed_lines[i]` is the whole work-log line line i was drafted from, found at the quote check's offset.
 */
export type Proof = { token: string; invoice_number: string; remote_id: string | null; fingerprint: string; lines: ProofLine[]; created_at: string; revoked_at: string | null; sent: boolean; questions: Question[]; sources?: { log: string; prices: string }; billed_lines?: string[]; revisions?: Revision[]; pending?: PendingRevision | null; refunds?: Refund[]; pending_refund?: PendingRefund | null };
/**
 * A paid line given back. The invoice items stay as they were paid; the refund goes back on the client's payment for
 * exactly the line's amount. `refund_id` and `status` are PayPal's reply; `request_id` is the PayPal-Request-Id used.
 */
/** `quantity` is set when only part of the line's quantity was given back; `paypal_note` is the note PayPal holds on the refund. */
export type Refund = { at: string; ref: string; reason: string; amount: string; refund_id: string; status: string; request_id: string; capture_id: string; quantity?: string; paypal_note?: string };
/** Saved before PayPal is asked, so a lost reply is retried with the same request id and never refunds twice. */
/** `refund_id` is set once PayPal has accepted the refund but not completed it (status PENDING). */
// PayPal remembers a PayPal-Request-Id for a limited time; its API requests guide gives a refund that can be retried
// with the same id for up to 45 days. After that the same id could make a second refund, so a staged refund older
// than this window is never resent: a person checks the payment in PayPal instead.
export const REFUND_RETRY_DAYS = 30;
/** True when a staged refund PayPal never confirmed is too old to resend under its saved request id. */
export function refundRetryExpired(pending: { staged_at: string; refund_id?: string }, now = Date.now()): boolean {
  return !pending.refund_id && now - Date.parse(pending.staged_at) > REFUND_RETRY_DAYS * 86_400_000;
}
export type PendingRefund = { ref: string; reason: string; amount: string; request_id: string; capture_id: string; staged_at: string; refund_id?: string; quantity?: string };
export type PendingRevision = { action: Revision['action']; ref: string; reason: string; lines: ProofLine[]; billed_lines?: string[]; fingerprint: string; staged_at?: string };
/**
 * One change the freelancer made after approval, usually in answer to a client's question. `before` is the line as
 * it was; `after` is null when the line was removed. The client sees every revision with its reason and both totals.
 */
export type Revision = { version: number; at: string; action: 'remove' | 'change'; ref: string; reason: string; before: ProofLine; after: ProofLine | null; total_before: string; total_after: string; fingerprint_before: string; fingerprint_after: string };

/** The invoice total of the lines, in cents-exact USD with two decimals. */
export const totalOf = (lines: Pick<ProofLine, 'quantity' | 'rate'>[]) => (lines.reduce((sum, l) => sum + Math.round(Number(l.quantity) * Number(l.rate) * 100), 0) / 100).toFixed(2);

export const TOKEN = /^[0-9a-f]{32}$/;

/** SHA-256 over a canonical JSON of the two source texts and the approved lines. It changes when any of them changes; it does not identify the sender. */
export function fingerprint(inputs: { log: string; prices: string }, lines: Omit<ProofLine, 'ref' | 'review' | 'override'>[]): string {
  const canonical = JSON.stringify({ log: inputs.log, prices: inputs.prices, lines: lines.map(l => [l.description, l.quantity, l.rate, l.currency, l.work_quote, l.price_quote]) });
  return createHash('sha256').update(canonical).digest('hex');
}

export class ProofStore {
  private proofs = new Map<string, Proof>();
  private file: string | null;
  constructor(file: string | null) {
    this.file = file;
    if (file && existsSync(file)) for (const proof of JSON.parse(readFileSync(file, 'utf8')) as Proof[]) this.proofs.set(proof.token, proof);
  }
  /** Applies a change and saves it; when the save fails the change is undone, so memory never runs ahead of the file. */
  private commit(proof: Proof, change: Partial<Proof>): Proof {
    const before = Object.fromEntries(Object.keys(change).map(k => [k, (proof as any)[k]]));
    Object.assign(proof, change);
    try { this.save(); } catch (error) { Object.assign(proof, before); throw error; }
    return proof;
  }
  private save() {
    if (!this.file) return;
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify([...this.proofs.values()], null, 1)); renameSync(temp, this.file);
  }
  create(value: Omit<Proof, 'token' | 'created_at' | 'revoked_at' | 'questions' | 'remote_id' | 'sent'>): Proof {
    const proof: Proof = { ...value, token: randomBytes(16).toString('hex'), remote_id: null, created_at: new Date().toISOString(), revoked_at: null, sent: false, questions: [] };
    this.proofs.set(proof.token, proof); this.save(); return proof;
  }
  get(token: string): Proof | null { return TOKEN.test(token) ? this.proofs.get(token) ?? null : null; }
  /** A revoked proof answers like an unknown one. */
  live(token: string): Proof | null { const proof = this.get(token); return proof && !proof.revoked_at ? proof : null; }
  update(token: string, change: Partial<Pick<Proof, 'remote_id' | 'sent' | 'revoked_at'>>): Proof {
    const proof = this.get(token); if (!proof) throw new Error('Proof not found');
    return this.commit(proof, change);
  }
  /**
   * Saves a revision before PayPal is asked to apply it. A lost reply or a restart then leaves a pending revision
   * that is settled by reading PayPal back (applied, or dropped), never a silent gap between PayPal and the proof.
   */
  stage(token: string, change: PendingRevision): void {
    const proof = this.live(token); if (!proof) throw new Error('Proof not found');
    this.commit(proof, { pending: { ...change, staged_at: new Date().toISOString() } });
  }
  clearPending(token: string): void { const proof = this.get(token); if (proof?.pending) this.commit(proof, { pending: null }); }
  /** Replaces the approved lines with a revised set, keeping the earlier line and fingerprint in the revision history. */
  revise(token: string, change: PendingRevision): Proof {
    const proof = this.live(token); if (!proof) throw new Error('Proof not found');
    const before = proof.lines.find(l => l.ref === change.ref); if (!before) throw new Error('Line not found');
    const revisions = [...(proof.revisions ?? [])];
    revisions.push({ version: revisions.length + 2, at: new Date().toISOString(), action: change.action, ref: change.ref, reason: change.reason, before, after: change.lines.find(l => l.ref === change.ref) ?? null, total_before: totalOf(proof.lines), total_after: totalOf(change.lines), fingerprint_before: proof.fingerprint, fingerprint_after: change.fingerprint });
    return this.commit(proof, { lines: change.lines, fingerprint: change.fingerprint, revisions, pending: null, ...(change.billed_lines ? { billed_lines: change.billed_lines } : {}) });
  }
  stageRefund(token: string, change: Omit<PendingRefund, 'staged_at'>): PendingRefund {
    const proof = this.live(token); if (!proof) throw new Error('Proof not found');
    const pending = { ...change, staged_at: new Date().toISOString() };
    this.commit(proof, { pending_refund: pending }); return pending;
  }
  /** Keeps the stage open for a refund PayPal accepted but has not completed, with its id for the next read. */
  holdPendingRefund(token: string, refundId: string): void { const proof = this.get(token); if (proof?.pending_refund) this.commit(proof, { pending_refund: { ...proof.pending_refund, refund_id: refundId } }); }
  clearPendingRefund(token: string): void { const proof = this.get(token); if (proof?.pending_refund) this.commit(proof, { pending_refund: null }); }
  /** Records the refund PayPal confirmed for the staged request and clears the stage. */
  recordRefund(token: string, pending: PendingRefund, paypal: { id: string; status: string; note?: string }): Proof {
    const proof = this.live(token); if (!proof) throw new Error('Proof not found');
    const refund: Refund = { at: new Date().toISOString(), ref: pending.ref, reason: pending.reason, amount: pending.amount, refund_id: paypal.id, status: paypal.status, request_id: pending.request_id, capture_id: pending.capture_id, ...(pending.quantity ? { quantity: pending.quantity } : {}), ...(paypal.note ? { paypal_note: paypal.note } : {}) };
    return this.commit(proof, { refunds: [...(proof.refunds ?? []), refund], pending_refund: null });
  }
  ask(token: string, ref: string, note: string): Question[] {
    const proof = this.live(token); if (!proof) throw new Error('Proof not found');
    proof.questions.push({ ref, note, at: new Date().toISOString(), answer: null }); this.save(); return proof.questions;
  }
  answer(token: string, index: number, answer: Answer): Question[] {
    const proof = this.live(token); const question = proof?.questions[index]; if (!question) throw new Error('Question not found');
    question.answer = answer; this.save(); return proof!.questions;
  }
  /** Every proof, newest first, so the freelancer can reopen one after a reload. */
  list(): Proof[] { return [...this.proofs.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)); }
}

type Read = { kind: 'invoice'; status: string; items?: { name: string; quantity: string; unit_amount: { currency_code: string; value: string } }[]; currency?: string; value?: string } | { kind: 'unavailable'; code: string };
export type Comparison = { state: 'match' | 'changed' | 'could_not_check'; status: string | null; differences: { ref: string; field: string; expected: string; actual: string }[] };

/** Compares PayPal's own read of the invoice with the approved proof. A read that fails or lacks items is "could not check", never a match. */
export function compare(proof: Proof, read: Read | null): Comparison {
  if (!read || read.kind !== 'invoice' || !read.items) return { state: 'could_not_check', status: read && read.kind === 'invoice' ? read.status : null, differences: [] };
  const differences: Comparison['differences'] = [];
  const same = (a: string, b: string) => Number(a) === Number(b) && Number.isFinite(Number(a));
  const count = Math.max(proof.lines.length, read.items.length);
  for (let i = 0; i < count; i++) {
    const line = proof.lines[i], item = read.items[i], ref = line?.ref ?? `item ${i + 1}`;
    if (!line) { differences.push({ ref, field: 'line', expected: 'none', actual: item!.name }); continue; }
    if (!item) { differences.push({ ref, field: 'line', expected: line.description, actual: 'missing' }); continue; }
    if (item.name !== line.description.slice(0, 200)) differences.push({ ref, field: 'name', expected: line.description, actual: item.name });
    if (!same(item.quantity, line.quantity)) differences.push({ ref, field: 'quantity', expected: line.quantity, actual: item.quantity });
    if (!same(item.unit_amount.value, line.rate)) differences.push({ ref, field: 'rate', expected: line.rate, actual: item.unit_amount.value });
    if (item.unit_amount.currency_code !== line.currency) differences.push({ ref, field: 'currency', expected: line.currency, actual: item.unit_amount.currency_code });
  }
  const total = totalOf(proof.lines);
  if (read.value !== undefined && !same(read.value, total)) differences.push({ ref: 'invoice', field: 'total', expected: total, actual: read.value });
  if (read.currency !== undefined && read.currency !== 'USD') differences.push({ ref: 'invoice', field: 'currency', expected: 'USD', actual: read.currency });
  // Matching items alone is not a match: without PayPal's total and currency the invoice was not fully checked.
  if (!differences.length && (read.value === undefined || read.currency === undefined)) return { state: 'could_not_check', status: read.status, differences };
  return { state: differences.length ? 'changed' : 'match', status: read.status, differences };
}
