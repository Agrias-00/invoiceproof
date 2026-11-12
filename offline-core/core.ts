import { createHash } from 'node:crypto';

export type Currency = 'USD' | 'EUR' | 'JPY' | 'KWD';
export type Evidence = { id: string; documentId: string; text: string; completed: boolean; quantity: string; rate: string; currency: Currency };
export type Line = { id: string; evidenceId: string; description: string; quantity: string; rate: string; currency: Currency };
export type Draft = { currency: Currency; evidence: Evidence[]; lines: Line[] };
export type Status = 'NEEDS_REVIEW' | 'APPROVED' | 'CREATING' | 'UNKNOWN' | 'FAILED' | 'DRAFT_VERIFIED';
const scales = new Map<string, number>([['USD', 2], ['EUR', 2], ['JPY', 0], ['KWD', 3]]);
function requireThat(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function text(value: unknown, label: string): asserts value is string {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= 2000, `Invalid ${label}`);
}
function scale(currency: unknown): number {
  requireThat(typeof currency === 'string' && scales.has(currency), 'Unsupported currency');
  return scales.get(currency)!;
}
/** Nonnegative decimal strings only. No exponent, signs, whitespace or implicit rounding. */
export function decimal(value: string, digits: number): bigint {
  requireThat(Number.isInteger(digits) && digits >= 0 && digits <= 3, 'Invalid scale');
  requireThat(typeof value === 'string' && value.length <= 24 && /^(0|[1-9]\d*)(\.\d+)?$/.test(value), 'Invalid decimal');
  const [whole, fraction = ''] = value.split('.');
  requireThat(fraction.length <= digits, 'Excess precision');
  return BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0') || '0');
}
export function money(amount: bigint, currency: Currency): string {
  const digits = scale(currency);
  requireThat(typeof amount === 'bigint' && amount >= 0n, 'Invalid minor units');
  const s = amount.toString().padStart(digits + 1, '0');
  return digits ? `${s.slice(0, -digits)}.${s.slice(-digits)}` : s;
}
/** Quantity: max three decimals. Round half-up ONCE per line to currency minor units. */
export function lineAmount(quantity: string, rate: string, currency: Currency): bigint {
  const q = decimal(quantity, 3), r = decimal(rate, scale(currency));
  requireThat(q > 0n && r > 0n, 'Quantity and rate must be positive');
  const amount = (q * r + 500n) / 1000n;
  requireThat(amount > 0n, 'Line rounds to zero');
  return amount;
}
export function validate(draft: Draft): { total: string; minor: bigint } {
  requireThat(draft && typeof draft === 'object', 'Invalid draft');
  scale(draft.currency);
  requireThat(Array.isArray(draft.evidence) && draft.evidence.length > 0 && draft.evidence.length <= 1000, 'Invalid evidence list');
  requireThat(Array.isArray(draft.lines) && draft.lines.length > 0 && draft.lines.length <= 1000, 'Invalid lines');
  const evidence = new Map<string, Evidence>();
  for (const e of draft.evidence) {
    requireThat(e && typeof e === 'object', 'Invalid evidence');
    text(e.id, 'evidence ID'); text(e.documentId, 'document ID'); text(e.text, 'source text');
    requireThat(!evidence.has(e.id), 'Duplicate evidence ID');
    requireThat(typeof e.completed === 'boolean', 'Invalid completion flag');
    scale(e.currency); decimal(e.quantity, 3); decimal(e.rate, scale(e.currency));
    evidence.set(e.id, e);
  }
  const ids = new Set<string>(), used = new Set<string>();
  let minor = 0n;
  for (const l of draft.lines) {
    requireThat(l && typeof l === 'object', 'Invalid line');
    text(l.id, 'line ID'); text(l.description, 'description'); text(l.evidenceId, 'evidence reference');
    requireThat(!ids.has(l.id), 'Duplicate line ID'); ids.add(l.id);
    requireThat(!used.has(l.evidenceId), 'Evidence billed twice'); used.add(l.evidenceId);
    const e = evidence.get(l.evidenceId);
    requireThat(e && e.completed, 'Missing or incomplete evidence');
    requireThat(l.currency === draft.currency && e.currency === draft.currency, 'Mixed currency');
    requireThat(decimal(l.quantity, 3) === decimal(e.quantity, 3), 'Quantity differs from evidence');
    requireThat(decimal(l.rate, scale(l.currency)) === decimal(e.rate, scale(e.currency)), 'Rate differs from evidence');
    minor += lineAmount(l.quantity, l.rate, l.currency);
  }
  requireThat([...evidence.values()].filter(e => e.completed).every(e => used.has(e.id)), 'Completed work omitted');
  return { minor, total: money(minor, draft.currency) };
}
function digest(draft: Draft, revision: number): string {
  return createHash('sha256').update(JSON.stringify({ revision, draft })).digest('hex');
}
type Operation = { id: string; approval: string; revision: number };
/** Isolated local state machine. No transport, API adapter, credentials or send method. */
export class OfflineSession {
  #draft: Draft;
  #revision = 1;
  #approval: string | null = null;
  #status: Status = 'NEEDS_REVIEW';
  #operations = new Map<string, Operation>();
  #remoteId: string | null = null;
  constructor(draft: Draft) { validate(draft); this.#draft = structuredClone(draft); }
  snapshot() { return { draft: structuredClone(this.#draft), revision: this.#revision, approval: this.#approval, status: this.#status, remoteId: this.#remoteId }; }
  edit(draft: Draft): void {
    requireThat(['NEEDS_REVIEW', 'APPROVED'].includes(this.#status), 'Edit blocked after operation started');
    validate(draft); this.#draft = structuredClone(draft); this.#revision++; this.#approval = null; this.#status = 'NEEDS_REVIEW';
  }
  approve(): string {
    requireThat(['NEEDS_REVIEW', 'APPROVED'].includes(this.#status), 'Approval blocked');
    validate(this.#draft); this.#approval = digest(this.#draft, this.#revision); this.#status = 'APPROVED'; return this.#approval;
  }
  begin(operationId: string, approval: string): { started: boolean; operation: Operation } {
    text(operationId, 'operation ID');
    const existing = this.#operations.get(operationId);
    if (existing) {
      requireThat(existing.approval === approval && existing.revision === this.#revision, 'Operation ID conflict');
      return { started: false, operation: { ...existing } };
    }
    requireThat(this.#status === 'APPROVED', 'New operation blocked');
    requireThat(approval === this.#approval && approval === digest(this.#draft, this.#revision), 'Stale approval');
    const operation = { id: operationId, approval, revision: this.#revision };
    this.#operations.set(operationId, operation); this.#status = 'CREATING';
    return { started: true, operation: { ...operation } };
  }
  /** Synthetic outcomes only; absence of a valid create receipt is UNKNOWN, never retryable. */
  recordOutcome(operationId: string, outcome: 'created' | 'unknown' | 'failed', remoteId?: string): void {
    requireThat(this.#status === 'CREATING' && this.#operations.has(operationId) && this.#remoteId === null, 'Outcome not expected');
    requireThat(['created', 'unknown', 'failed'].includes(outcome), 'Invalid outcome');
    if (outcome === 'created' && typeof remoteId === 'string' && remoteId.trim() && remoteId.length <= 2000) {
      this.#remoteId = remoteId; // Remains CREATING until a matching synthetic read verifies DRAFT.
    } else { this.#status = outcome === 'failed' ? 'FAILED' : 'UNKNOWN'; }
  }
  verify(operationId: string, remoteId: string, remoteStatus: string): void {
    requireThat(this.#status === 'CREATING' && this.#operations.has(operationId), 'Verification blocked');
    if (!this.#remoteId || remoteId !== this.#remoteId || remoteStatus !== 'DRAFT') {
      this.#status = 'UNKNOWN'; throw new Error('Remote DRAFT not verified; halt');
    }
    this.#status = 'DRAFT_VERIFIED';
  }
}
