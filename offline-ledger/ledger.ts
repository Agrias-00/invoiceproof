import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validate } from '../offline-core/core.ts';
import type { Draft, Status } from '../offline-core/core.ts';

type Row = { draft_id: string; draft_json: string; revision: number; approval: string | null; status: Status };
type Operation = { operationId: string; draftId: string; approval: string; revision: number; remoteId: string | null };
type Checkpoint = { action: string; phase: 'beforeCommit' | 'afterCommit' };
type Options = { busyTimeoutMs?: number; faultInjector?: (checkpoint: Checkpoint) => void };

function ensure(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function id(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value), 'Invalid stable ID');
}
function approvalToken(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Invalid approval');
}
function revision(value: unknown): asserts value is number {
  ensure(Number.isSafeInteger(value) && Number(value) > 0, 'Invalid revision');
}
function serialize(draft: Draft): string { validate(draft); return JSON.stringify(structuredClone(draft)); }
function digest(row: Row): string {
  return createHash('sha256').update(JSON.stringify({ draftId: row.draft_id, revision: row.revision, draft: JSON.parse(row.draft_json) })).digest('hex');
}

/** Offline synthetic-data ledger. No network, authentication, payment or dispatch capability.
 * Use one stable draft ID and one shared local database file across all callers.
 * A begin result is returned only after COMMIT. Existing operations NEVER return started=true.
 * faultInjector is solely a deterministic test seam; never supply it in application code.
 */
export class DurableLedger {
  #db: DatabaseSync;
  #faultInjector?: Options['faultInjector'];
  constructor(path: string, options: Options = {}) {
    ensure(typeof path === 'string' && path.length > 0 && path !== ':memory:' && !path.startsWith('file:'), 'A persistent local database path is required');
    const timeout = options.busyTimeoutMs ?? 1000;
    ensure(Number.isInteger(timeout) && timeout >= 0 && timeout <= 30000, 'Invalid busy timeout');
    this.#db = new DatabaseSync(path);
    this.#faultInjector = options.faultInjector;
    try {
      this.#db.exec(`PRAGMA busy_timeout=${timeout}; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;`);
      const initialVersion = this.#db.prepare('PRAGMA user_version').get()!.user_version;
      ensure(initialVersion === 0 || initialVersion === 1 || initialVersion === 2, 'Unsupported ledger schema version');
      const journal = this.#db.prepare('PRAGMA journal_mode=WAL').get()!;
      ensure(journal.journal_mode === 'wal', 'WAL mode is required');
      this.#db.exec('PRAGMA synchronous=FULL;');
      this.#transaction('schema', () => {
        const version = this.#db.prepare('PRAGMA user_version').get()!.user_version;
        ensure(version === 0 || version === 1 || version === 2, 'Unsupported ledger schema version');
        const names = this.#db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().map(row => row.name).sort();
        if (version === 1 || version === 2) {
          ensure(JSON.stringify(names) === JSON.stringify(['drafts', 'operations']), 'Unexpected ledger schema');
          if (version === 1) this.#db.exec(`
            ALTER TABLE operations ADD COLUMN recovery_code TEXT NOT NULL DEFAULT 'LEGACY_REVIEW_REQUIRED';
            ALTER TABLE operations ADD COLUMN last_read_status TEXT;
            ALTER TABLE operations ADD COLUMN read_checks INTEGER NOT NULL DEFAULT 0 CHECK(read_checks >= 0);
            PRAGMA user_version=2;
          `);
          return;
        }
        ensure(names.length === 0, 'Refuse to initialize a nonempty unversioned database');
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS drafts (
            draft_id TEXT PRIMARY KEY NOT NULL,
            draft_json TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK(revision > 0),
            approval TEXT,
            status TEXT NOT NULL CHECK(status IN ('NEEDS_REVIEW','APPROVED','CREATING','UNKNOWN','FAILED','DRAFT_VERIFIED')),
            CHECK((status = 'NEEDS_REVIEW' AND approval IS NULL) OR (status <> 'NEEDS_REVIEW' AND approval IS NOT NULL))
          ) STRICT;
          CREATE TABLE IF NOT EXISTS operations (
            operation_id TEXT PRIMARY KEY NOT NULL,
            draft_id TEXT NOT NULL UNIQUE REFERENCES drafts(draft_id),
            approval TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK(revision > 0),
            remote_id TEXT,
            recovery_code TEXT NOT NULL DEFAULT 'CLAIM_COMMITTED',
            last_read_status TEXT,
            read_checks INTEGER NOT NULL DEFAULT 0 CHECK(read_checks >= 0),
            CHECK(remote_id IS NULL OR length(remote_id) BETWEEN 1 AND 2000)
          ) STRICT;
          PRAGMA user_version=2;
        `);
      });
    } catch (error) { this.#db.close(); throw error; }
  }
  #transaction<T>(action: string, run: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const result = run();
      this.#faultInjector?.({ action, phase: 'beforeCommit' });
      this.#db.exec('COMMIT'); committed = true;
      this.#faultInjector?.({ action, phase: 'afterCommit' });
      return result;
    } catch (error) {
      if (!committed) this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  #row(draftId: string): Row {
    id(draftId);
    const row = this.#db.prepare('SELECT * FROM drafts WHERE draft_id=?').get(draftId) as Row | undefined;
    ensure(row, 'Draft not found'); return row;
  }
  #operation(operationId: string): Operation | undefined {
    const row = this.#db.prepare('SELECT operation_id AS operationId, draft_id AS draftId, approval, revision, remote_id AS remoteId FROM operations WHERE operation_id=?').get(operationId);
    return row as Operation | undefined;
  }
  createDraft(draftId: string, draft: Draft): void {
    id(draftId); const json = serialize(draft);
    this.#transaction('createDraft', () => {
      ensure(!this.#db.prepare('SELECT 1 FROM drafts WHERE draft_id=?').get(draftId), 'Stable draft ID already exists; reopen it');
      this.#db.prepare("INSERT INTO drafts VALUES (?, ?, 1, NULL, 'NEEDS_REVIEW')").run(draftId, json);
    });
  }
  snapshot(draftId: string) {
    id(draftId);
    // One SELECT observes draft and operation from the same SQLite read snapshot.
    const row = this.#db.prepare('SELECT d.*, o.operation_id, o.remote_id, o.recovery_code, o.last_read_status, o.read_checks FROM drafts d LEFT JOIN operations o USING(draft_id) WHERE d.draft_id=?').get(draftId) as (Row & { operation_id: string | null; remote_id: string | null; recovery_code: string | null; last_read_status: string | null; read_checks: number | null }) | undefined;
    ensure(row, 'Draft not found');
    return { draftId, draft: JSON.parse(row.draft_json) as Draft, revision: row.revision, approval: row.approval, status: row.status, operationId: row.operation_id, remoteId: row.remote_id, recoveryCode: row.recovery_code, lastReadStatus: row.last_read_status, readChecks: row.read_checks ?? 0 };
  }
  /** Operations whose create the provider refused: they billed nothing. Unknown and unresolved outcomes are not listed. */
  refusedOperations(): string[] {
    return (this.#db.prepare("SELECT o.operation_id FROM operations o JOIN drafts d USING(draft_id) WHERE d.status='FAILED'").all() as { operation_id: string }[]).map(row => row.operation_id);
  }
  edit(draftId: string, draft: Draft, expectedRevision: number): void {
    revision(expectedRevision); const json = serialize(draft);
    this.#transaction('edit', () => {
      const row = this.#row(draftId);
      ensure(['NEEDS_REVIEW', 'APPROVED'].includes(row.status), 'Edit blocked after operation started');
      ensure(row.revision === expectedRevision, 'Stale revision');
      revision(row.revision + 1);
      this.#db.prepare("UPDATE drafts SET draft_json=?, revision=revision+1, approval=NULL, status='NEEDS_REVIEW' WHERE draft_id=?").run(json, draftId);
    });
  }
  approve(draftId: string, expectedRevision: number): string {
    revision(expectedRevision);
    return this.#transaction('approve', () => {
      const row = this.#row(draftId);
      ensure(['NEEDS_REVIEW', 'APPROVED'].includes(row.status), 'Approval blocked');
      ensure(row.revision === expectedRevision, 'Stale revision'); validate(JSON.parse(row.draft_json));
      const approval = digest(row);
      this.#db.prepare("UPDATE drafts SET approval=?, status='APPROVED' WHERE draft_id=?").run(approval, draftId);
      return approval;
    });
  }
  begin(draftId: string, operationId: string, approval: string): { started: boolean; operation: Operation } {
    id(draftId); id(operationId); approvalToken(approval);
    return this.#transaction('begin', () => {
      const row = this.#row(draftId), existing = this.#operation(operationId);
      if (existing) {
        ensure(existing.draftId === draftId && existing.approval === approval && existing.revision === row.revision, 'Operation ID conflict');
        return { started: false, operation: existing };
      }
      ensure(row.status === 'APPROVED', 'New operation blocked');
      ensure(row.approval === approval && approval === digest(row), 'Stale approval');
      this.#db.prepare('INSERT INTO operations(operation_id,draft_id,approval,revision) VALUES (?,?,?,?)').run(operationId, draftId, approval, row.revision);
      this.#db.prepare("UPDATE drafts SET status='CREATING' WHERE draft_id=?").run(draftId);
      return { started: true, operation: this.#operation(operationId)! };
    });
  }
  /** Synthetic adapter input. A missing/malformed create receipt is UNKNOWN, never retryable. */
  recordOutcome(operationId: string, outcome: 'created' | 'unknown' | 'failed', remoteId?: string): void {
    id(operationId); ensure(['created', 'unknown', 'failed'].includes(outcome), 'Invalid outcome');
    this.#transaction('recordOutcome', () => {
      const operation = this.#operation(operationId); ensure(operation, 'Operation not found');
      const row = this.#row(operation.draftId);
      ensure(row.status === 'CREATING' && operation.remoteId === null, 'Outcome not expected');
      if (outcome === 'created' && typeof remoteId === 'string' && remoteId.trim().length && remoteId.length <= 2000) {
        this.#db.prepare("UPDATE operations SET remote_id=?, recovery_code='RECEIPT_SAVED' WHERE operation_id=?").run(remoteId, operationId);
      } else {
        this.#db.prepare('UPDATE drafts SET status=? WHERE draft_id=?').run(outcome === 'failed' ? 'FAILED' : 'UNKNOWN', operation.draftId);
        this.#db.prepare('UPDATE operations SET recovery_code=? WHERE operation_id=?').run(outcome === 'failed' ? 'DEFINITE_FAILURE' : outcome === 'created' ? 'MISSING_RECEIPT' : 'OUTCOME_UNKNOWN', operationId);
      }
    });
  }
  /** Explicit recovery fence, not constructor behavior: opening another client must not abort a live operation.
   * Once fenced UNKNOWN, late writers cannot record a new receipt. It never authorizes a retry.
   */
  markInterrupted(operationId: string): void {
    id(operationId);
    this.#transaction('markInterrupted', () => {
      const operation = this.#operation(operationId); ensure(operation, 'Operation not found');
      if (this.#row(operation.draftId).status === 'CREATING') this.#db.prepare("UPDATE operations SET recovery_code='INTERRUPTED' WHERE operation_id=?").run(operationId);
      this.#db.prepare("UPDATE drafts SET status='UNKNOWN' WHERE draft_id=? AND status='CREATING'").run(operation.draftId);
    });
  }
  /** Recovery by lookup: the provider found the invoice that carries this operation's invoice number.
   * Allowed only while the outcome is open (CREATING or UNKNOWN) and no receipt is saved. It saves the receipt and
   * leaves the status for verify() to settle; it never authorizes another create.
   */
  recordLookup(operationId: string, remoteId: string): void {
    id(operationId);
    this.#transaction('recordLookup', () => {
      const operation = this.#operation(operationId); ensure(operation, 'Operation not found');
      ensure(['CREATING', 'UNKNOWN'].includes(this.#row(operation.draftId).status) && operation.remoteId === null, 'Lookup not expected');
      ensure(typeof remoteId === 'string' && remoteId.trim().length > 0 && remoteId.length <= 2000, 'Invalid lookup receipt');
      this.#db.prepare("UPDATE operations SET remote_id=?, recovery_code='FOUND_BY_LOOKUP' WHERE operation_id=?").run(remoteId, operationId);
    });
  }
  /** A synthetic matching read can reconcile only a durably saved receipt. No create retry exists. */
  verify(operationId: string, remoteId: string, remoteStatus: string): void {
    id(operationId);
    const verified = this.#transaction('verify', () => {
      const operation = this.#operation(operationId); ensure(operation, 'Operation not found');
      const row = this.#row(operation.draftId);
      ensure(['CREATING', 'UNKNOWN'].includes(row.status), 'Verification blocked');
      const ok = operation.remoteId !== null && remoteId === operation.remoteId && remoteStatus === 'DRAFT';
      this.#db.prepare('UPDATE drafts SET status=? WHERE draft_id=?').run(ok ? 'DRAFT_VERIFIED' : 'UNKNOWN', operation.draftId);
      const reportedStatus = typeof remoteStatus === 'string' && remoteStatus.length <= 64 ? remoteStatus : 'INVALID';
      this.#db.prepare('UPDATE operations SET recovery_code=?, last_read_status=?, read_checks=read_checks+1 WHERE operation_id=?').run(ok ? 'MATCHED_DRAFT' : operation.remoteId === null ? 'MISSING_RECEIPT' : 'READ_MISMATCH', reportedStatus, operationId);
      return ok;
    });
    // Persist UNKNOWN before raising the mismatch to the caller.
    ensure(verified, 'Remote DRAFT not verified; halt');
  }
  /** Failed read-only checks retain the existing claim and receipt. They never unlock creation. */
  recordReadFailure(operationId: string, code: 'READ_TIMEOUT' | 'READ_NOT_FOUND' | 'READ_MALFORMED' | 'READ_UNAVAILABLE'): void {
    id(operationId); ensure(['READ_TIMEOUT','READ_NOT_FOUND','READ_MALFORMED','READ_UNAVAILABLE'].includes(code), 'Invalid read failure');
    this.#transaction('recordReadFailure', () => {
      const operation = this.#operation(operationId); ensure(operation && operation.remoteId, 'No durable receipt');
      ensure(['CREATING','UNKNOWN'].includes(this.#row(operation.draftId).status), 'Read recovery blocked');
      this.#db.prepare("UPDATE drafts SET status='UNKNOWN' WHERE draft_id=?").run(operation.draftId);
      this.#db.prepare('UPDATE operations SET recovery_code=?, last_read_status=NULL, read_checks=read_checks+1 WHERE operation_id=?').run(code, operationId);
    });
  }
  close(): void { this.#db.close(); }
}
