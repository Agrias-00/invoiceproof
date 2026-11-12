import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { DurableLedger } from './ledger.ts';
import { fixture } from '../offline-core/fixture.ts';

const worker = fileURLToPath(new URL('./process-worker.ts', import.meta.url));
function setup(t: test.TestContext, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'invoiceproof-ledger-'));
  const path = join(dir, 'ledger.sqlite');
  const connections: DurableLedger[] = [];
  const open = (customOptions = options) => { const db = new DurableLedger(path, customOptions); connections.push(db); return db; };
  t.after(() => { for (const db of connections) { try { db.close(); } catch {} } rmSync(dir, { recursive: true, force: true }); });
  return { dir, path, open, ledger: open() };
}
function prepared(t: test.TestContext, options = {}) {
  const h = setup(t, options); h.ledger.createDraft('draft-1', fixture());
  return { ...h, approval: h.ledger.approve('draft-1', 1) };
}
function started(t: test.TestContext, options = {}) {
  const h = prepared(t, options); h.ledger.begin('draft-1', 'op-1', h.approval); return h;
}
function crash(path: string, mode: string, approval: string, phase: string) {
  const child = spawnSync(process.execPath, [worker, mode, path, 'op-1', approval, phase], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, 'SIGKILL', child.stderr + child.stdout);
}
async function race(path: string, approval: string, sameId: boolean) {
  const children: ReturnType<typeof spawn>[] = [];
  const timers: NodeJS.Timeout[] = [];
  try {
    const entrants = Array.from({ length: 8 }, (_, index) => {
      const child = spawn(process.execPath, [worker, 'begin-race', path, sameId ? 'op-1' : `op-${index}`, approval], { stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child);
      let stderr = ''; child.stderr!.on('data', data => { stderr += String(data); });
      let readyResolve: () => void, readyReject: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      const lines: Record<string, unknown>[] = [];
      createInterface({ input: child.stdout! }).on('line', line => {
        const parsed = JSON.parse(line); if (parsed.ready) readyResolve(); else lines.push(parsed);
      });
      const result = new Promise<Record<string, unknown>>((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', code => {
          if (code !== 0 || lines.length !== 1) {
            const error = new Error(`Worker exit ${code}: ${stderr}`); readyReject(error); reject(error);
          } else resolve(lines[0]);
        });
      });
      // Attach a handler before waiting for all startup barriers.
      result.catch(() => {});
      const timer = setTimeout(() => { const error = new Error('Worker timeout'); readyReject(error); child.kill('SIGKILL'); }, 10000); timers.push(timer);
      return { child, ready, result };
    });
    await Promise.all(entrants.map(e => e.ready));
    entrants.forEach(e => e.child.stdin!.end('go'));
    return await Promise.all(entrants.map(e => e.result));
  } finally { timers.forEach(clearTimeout); for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); }
}

test('new draft and approval persist after close and reopen', t => {
  const { ledger, open, approval } = prepared(t); ledger.close();
  const db = open(); assert.equal(db.snapshot('draft-1').approval, approval); assert.equal(db.snapshot('draft-1').status, 'APPROVED');
});
test('stable draft ID cannot be replaced to erase an operation', t => {
  const { ledger } = started(t); assert.throws(() => ledger.createDraft('draft-1', fixture()), /already exists/);
  assert.equal(ledger.snapshot('draft-1').status, 'CREATING');
});
test('invalid evidence is rejected before persistent creation', t => {
  const { ledger } = setup(t); const d = fixture(); d.lines[0].rate = '999';
  assert.throws(() => ledger.createDraft('draft-1', d)); assert.throws(() => ledger.snapshot('draft-1'), /not found/);
});
test('returned snapshots are detached from persistent state', t => {
  const { ledger } = prepared(t); ledger.snapshot('draft-1').draft.lines[0].rate = '999';
  assert.equal(ledger.snapshot('draft-1').draft.lines[0].rate, '50.00');
});
test('edit invalidates persisted approval and increments revision', t => {
  const { ledger, open, approval } = prepared(t); ledger.edit('draft-1', fixture(), 1);
  const db = open(); assert.equal(db.snapshot('draft-1').approval, null); assert.equal(db.snapshot('draft-1').revision, 2);
  assert.throws(() => db.begin('draft-1', 'op-1', approval)); assert.notEqual(db.approve('draft-1', 2), approval);
});
test('stale editor cannot overwrite a newer revision', t => {
  const { ledger, open } = prepared(t); const db = open(); ledger.edit('draft-1', fixture(), 1);
  assert.throws(() => db.edit('draft-1', fixture(), 1), /Stale revision/); assert.equal(db.snapshot('draft-1').revision, 2);
});
test('stale approver cannot approve unseen changed content', t => {
  const { ledger } = prepared(t); ledger.edit('draft-1', fixture(), 1);
  assert.throws(() => ledger.approve('draft-1', 1), /Stale revision/);
});
test('invalid edit preserves prior valid approval', t => {
  const { ledger, approval } = prepared(t); const d = fixture(); d.lines[0].quantity = '-1';
  assert.throws(() => ledger.edit('draft-1', d, 1)); assert.equal(ledger.snapshot('draft-1').approval, approval);
});
test('approval is bound to stable draft identity', t => {
  const { ledger, approval } = prepared(t); ledger.createDraft('draft-2', fixture());
  assert.notEqual(ledger.approve('draft-2', 1), approval);
  assert.throws(() => ledger.begin('draft-2', 'op-2', approval), /Stale approval/);
});
test('cannot begin without approval', t => {
  const { ledger } = setup(t); ledger.createDraft('draft-1', fixture());
  assert.throws(() => ledger.begin('draft-1', 'op-1', 'a'.repeat(64)), /blocked/);
});
test('fresh process observes committed state and never reclaims dispatch', t => {
  const { path, approval } = started(t);
  const child = spawnSync(process.execPath, [worker, 'begin', path, 'op-1', approval], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).started, false);
});
test('new client open does not mark live operation interrupted', t => {
  const { open } = started(t); assert.equal(open().snapshot('draft-1').status, 'CREATING');
});
test('same operation repeated 100 times across connections never starts again', t => {
  const { ledger, open, approval } = started(t); const other = open();
  for (let i = 0; i < 100; i++) assert.equal((i % 2 ? ledger : other).begin('draft-1', 'op-1', approval).started, false);
});
test('different operation ID blocked for same draft after restart', t => {
  const { open, approval } = started(t); assert.throws(() => open().begin('draft-1', 'new-id', approval), /blocked/);
});
test('global operation ID cannot be reassigned to another draft', t => {
  const { ledger } = started(t); ledger.createDraft('draft-2', fixture()); const a = ledger.approve('draft-2', 1);
  assert.throws(() => ledger.begin('draft-2', 'op-1', a), /conflict/); assert.equal(ledger.snapshot('draft-2').status, 'APPROVED');
});
test('changed approval cannot reuse operation ID', t => {
  const { ledger } = started(t); assert.throws(() => ledger.begin('draft-1', 'op-1', 'b'.repeat(64)), /conflict/);
});
test('editing and reapproval remain blocked after persistent begin', t => {
  const { open } = started(t); const db = open();
  assert.throws(() => db.edit('draft-1', fixture(), 1), /blocked/); assert.throws(() => db.approve('draft-1', 1), /blocked/);
});
test('returned operation mutation cannot change persisted operation', t => {
  const { ledger, approval } = prepared(t); const response = ledger.begin('draft-1', 'op-1', approval);
  response.operation.approval = 'forged'; assert.equal(ledger.begin('draft-1', 'op-1', approval).operation.approval, approval);
});
test('UNKNOWN persists and cannot be bypassed with new ID or reapproval', t => {
  const { ledger, open, approval } = started(t); ledger.recordOutcome('op-1', 'unknown'); const db = open();
  assert.equal(db.snapshot('draft-1').status, 'UNKNOWN'); assert.equal(db.begin('draft-1', 'op-1', approval).started, false);
  assert.throws(() => db.begin('draft-1', 'op-new', approval)); assert.throws(() => db.approve('draft-1', 1));
});
test('FAILED persists and cannot be retried', t => {
  const { ledger, open, approval } = started(t); ledger.recordOutcome('op-1', 'failed'); const db = open();
  assert.equal(db.snapshot('draft-1').status, 'FAILED'); assert.throws(() => db.begin('draft-1', 'retry', approval));
  assert.throws(() => db.verify('op-1', 'x', 'DRAFT'));
});
for (const receipt of [undefined, '', '  ', 'x'.repeat(2001), 123]) test(`missing or invalid receipt becomes UNKNOWN (${String(receipt).slice(0, 12)})`, t => {
  const { ledger, open } = started(t); ledger.recordOutcome('op-1', 'created', receipt as string);
  assert.equal(open().snapshot('draft-1').status, 'UNKNOWN');
});
test('wrong operation outcome does not change state', t => {
  const { ledger } = started(t); assert.throws(() => ledger.recordOutcome('wrong', 'failed'), /not found/);
  assert.equal(ledger.snapshot('draft-1').status, 'CREATING');
});
test('runtime invalid outcome leaves ledger unchanged', t => {
  const { ledger } = started(t); assert.throws(() => ledger.recordOutcome('op-1', 'bogus' as never), /Invalid/);
  assert.equal(ledger.snapshot('draft-1').status, 'CREATING');
});
test('persisted receipt verifies after reopening', t => {
  const { ledger, open } = started(t); ledger.recordOutcome('op-1', 'created', 'synthetic-receipt'); const db = open();
  db.verify('op-1', 'synthetic-receipt', 'DRAFT'); assert.equal(open().snapshot('draft-1').status, 'DRAFT_VERIFIED');
});
test('receipt cannot be overwritten', t => {
  const { ledger, open } = started(t); ledger.recordOutcome('op-1', 'created', 'first');
  assert.throws(() => open().recordOutcome('op-1', 'created', 'second')); assert.equal(ledger.snapshot('draft-1').remoteId, 'first');
});
for (const status of ['SENT', 'PAID', 'CANCELLED', '']) test(`non-DRAFT ${status} persists UNKNOWN even though verification throws`, t => {
  const { ledger, open } = started(t); ledger.recordOutcome('op-1', 'created', 'receipt');
  assert.throws(() => ledger.verify('op-1', 'receipt', status), /halt/); assert.equal(open().snapshot('draft-1').status, 'UNKNOWN');
});
test('mismatched receipt ID persists UNKNOWN', t => {
  const { ledger, open } = started(t); ledger.recordOutcome('op-1', 'created', 'receipt');
  assert.throws(() => ledger.verify('op-1', 'other', 'DRAFT')); assert.equal(open().snapshot('draft-1').status, 'UNKNOWN');
});
test('verification without receipt cannot invent a remote ID', t => {
  const { ledger } = started(t); ledger.markInterrupted('op-1');
  assert.throws(() => ledger.verify('op-1', 'invented', 'DRAFT')); assert.equal(ledger.snapshot('draft-1').remoteId, null);
});
test('interruption fence rejects late writer outcome', t => {
  const { ledger, open } = started(t); open().markInterrupted('op-1');
  assert.throws(() => ledger.recordOutcome('op-1', 'created', 'late'), /not expected/);
});
test('UNKNOWN with durable receipt can reconcile through matching synthetic DRAFT read', t => {
  const { ledger, open, approval } = started(t); ledger.recordOutcome('op-1', 'created', 'receipt'); ledger.markInterrupted('op-1');
  const db = open(); db.verify('op-1', 'receipt', 'DRAFT'); assert.equal(db.snapshot('draft-1').status, 'DRAFT_VERIFIED');
  assert.equal(db.begin('draft-1', 'op-1', approval).started, false);
});
test('recovery fence does not regress FAILED or DRAFT_VERIFIED', t => {
  const { ledger } = started(t); ledger.recordOutcome('op-1', 'created', 'receipt'); ledger.verify('op-1', 'receipt', 'DRAFT');
  ledger.markInterrupted('op-1'); assert.equal(ledger.snapshot('draft-1').status, 'DRAFT_VERIFIED');
  ledger.createDraft('draft-2', fixture()); const a = ledger.approve('draft-2', 1); ledger.begin('draft-2', 'op-2', a); ledger.recordOutcome('op-2', 'failed');
  ledger.markInterrupted('op-2'); assert.equal(ledger.snapshot('draft-2').status, 'FAILED');
});
test('injected exception before begin commit rolls back both claim and status', t => {
  const { ledger, open, approval } = prepared(t, { faultInjector: (e: { action: string; phase: string }) => {
    if (e.action === 'begin' && e.phase === 'beforeCommit') throw new Error('synthetic disk/commit interruption');
  } });
  assert.throws(() => ledger.begin('draft-1', 'op-1', approval), /synthetic/); const db = open({});
  assert.equal(db.snapshot('draft-1').status, 'APPROVED'); assert.equal(db.snapshot('draft-1').operationId, null);
  assert.equal(db.begin('draft-1', 'op-1', approval).started, true);
});
test('lost return after successful commit never grants dispatch again', t => {
  const { ledger, open, approval } = prepared(t, { faultInjector: (e: { action: string; phase: string }) => {
    if (e.action === 'begin' && e.phase === 'afterCommit') throw new Error('synthetic lost response');
  } });
  assert.throws(() => ledger.begin('draft-1', 'op-1', approval), /lost response/);
  assert.equal(open({}).begin('draft-1', 'op-1', approval).started, false);
});
test('SIGKILL before begin commit leaves no claim and no dispatch success', t => {
  const { path, ledger, approval } = prepared(t); crash(path, 'crash-begin', approval, 'beforeCommit');
  assert.equal(ledger.snapshot('draft-1').status, 'APPROVED'); assert.equal(ledger.snapshot('draft-1').operationId, null);
  assert.equal(ledger.begin('draft-1', 'op-1', approval).started, true);
});
test('SIGKILL after begin commit preserves claim and blocks repeat dispatch', t => {
  const { path, ledger, open, approval } = prepared(t); crash(path, 'crash-begin', approval, 'afterCommit');
  assert.equal(ledger.snapshot('draft-1').status, 'CREATING'); const db = open();
  assert.equal(db.begin('draft-1', 'op-1', approval).started, false); db.markInterrupted('op-1'); assert.equal(db.snapshot('draft-1').status, 'UNKNOWN');
});
test('SIGKILL before receipt commit leaves claim held and receipt absent', t => {
  const { path, ledger, approval } = started(t); crash(path, 'crash-outcome', approval, 'beforeCommit');
  assert.equal(ledger.snapshot('draft-1').remoteId, null); assert.equal(ledger.begin('draft-1', 'op-1', approval).started, false);
  ledger.markInterrupted('op-1'); assert.equal(ledger.snapshot('draft-1').status, 'UNKNOWN');
});
test('SIGKILL after receipt commit permits read reconciliation only', t => {
  const { path, ledger, approval } = started(t); crash(path, 'crash-outcome', approval, 'afterCommit');
  assert.equal(ledger.snapshot('draft-1').remoteId, 'synthetic-receipt'); ledger.markInterrupted('op-1');
  ledger.verify('op-1', 'synthetic-receipt', 'DRAFT'); assert.equal(ledger.snapshot('draft-1').status, 'DRAFT_VERIFIED');
  assert.equal(ledger.begin('draft-1', 'op-1', approval).started, false);
});
test('eight independent processes competing on same operation receive one dispatch claim', async t => {
  const { path, approval } = prepared(t); const results = await race(path, approval, true);
  assert.equal(results.filter(r => r.started === true).length, 1); assert.equal(results.filter(r => r.started === false).length, 7);
});
test('eight independent processes with different operation IDs cannot double claim one draft', async t => {
  const { path, approval } = prepared(t); const results = await race(path, approval, false);
  assert.equal(results.filter(r => r.started === true).length, 1); assert.equal(results.filter(r => r.error === 'New operation blocked').length, 7);
});
test('SQLite writer contention fails closed without an operation', t => {
  const { path, open, ledger, approval } = prepared(t); const contender = open({ busyTimeoutMs: 20 }); const lock = new DatabaseSync(path);
  try {
    lock.exec('BEGIN IMMEDIATE'); assert.throws(() => contender.begin('draft-1', 'op-1', approval), /locked|busy/i);
    assert.equal(ledger.snapshot('draft-1').operationId, null);
  } finally { lock.exec('ROLLBACK'); lock.close(); }
  assert.equal(contender.begin('draft-1', 'op-1', approval).started, true);
});
test('injected SQLite write failure rolls back a half-written operation claim', t => {
  const { path, ledger, approval } = prepared(t); const lock = new DatabaseSync(path);
  // SQLite trigger is a deterministic write-failure simulation, not an OS permission change.
  lock.exec("CREATE TRIGGER reject_status BEFORE UPDATE ON drafts BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;");
  assert.throws(() => ledger.begin('draft-1', 'op-1', approval), /synthetic write failure/);
  assert.equal(ledger.snapshot('draft-1').operationId, null); assert.equal(ledger.snapshot('draft-1').status, 'APPROVED');
  lock.exec('DROP TRIGGER reject_status'); lock.close(); assert.equal(ledger.begin('draft-1', 'op-1', approval).started, true);
});
test('WAL integrity remains sound after concurrency and restart', async t => {
  const { path, approval } = prepared(t); await race(path, approval, true);
  const db = new DatabaseSync(path); assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operations').get()!.n, 1); db.close();
});
test('future schema fails closed', t => {
  const { path } = setup(t); const db = new DatabaseSync(path); db.exec('PRAGMA user_version=999'); db.close();
  assert.throws(() => new DurableLedger(path), /Unsupported/);
});
test('nonempty unrelated database is never adopted', t => {
  const { dir } = setup(t); const path = join(dir, 'unrelated.sqlite'); const db = new DatabaseSync(path); db.exec('CREATE TABLE unrelated(value TEXT)'); db.close();
  assert.throws(() => new DurableLedger(path), /nonempty/);
});
test('corrupt database is not silently recreated', t => {
  const { dir } = setup(t); const path = join(dir, 'corrupt.sqlite'); writeFileSync(path, 'not a sqlite database');
  assert.throws(() => new DurableLedger(path), /database/);
});
test('in-memory storage and URI shortcuts are rejected', () => {
  for (const path of ['', ':memory:', 'file:temporary?mode=memory']) assert.throws(() => new DurableLedger(path), /persistent/);
});
test('bad IDs and revisions are rejected at runtime', t => {
  const { ledger } = setup(t);
  for (const value of ['', 'space id', 'a'.repeat(129), 123, null]) assert.throws(() => ledger.createDraft(value as string, fixture()), /ID/);
  ledger.createDraft('draft-1', fixture()); for (const value of [0, -1, 1.5, '1', NaN]) assert.throws(() => ledger.approve('draft-1', value as number), /revision/);
});
test('operation transitions do not leak SQL injection through bound parameters', t => {
  const { ledger, approval } = prepared(t); assert.throws(() => ledger.begin('draft-1', "x'; DROP TABLE drafts;--", approval), /ID/);
  assert.equal(ledger.snapshot('draft-1').status, 'APPROVED');
});
test('concurrent first-time initialization and draft creation preserve one draft', async t => {
  const { dir } = setup(t); const path = join(dir, 'fresh.sqlite');
  const results = await Promise.all(Array.from({ length: 8 }, () => new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(process.execPath, [worker, 'create-race', path], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout!.on('data', data => { stdout += String(data); }); child.stderr!.on('data', data => { stderr += String(data); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Initialization timeout')); }, 10000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(stderr)); else resolve(JSON.parse(stdout)); });
  })));
  assert.equal(results.filter(r => r.created === true).length, 1);
  assert.equal(results.filter(r => r.error === 'Stable draft ID already exists; reopen it').length, 7);
  const db = new DurableLedger(path); assert.equal(db.snapshot('draft-1').revision, 1); db.close();
});
test('stale approval stays rejected after editing and reapproval', t => {
  const { ledger, approval } = prepared(t); ledger.edit('draft-1', fixture(), 1); const next = ledger.approve('draft-1', 2);
  assert.throws(() => ledger.begin('draft-1', 'op-1', approval), /Stale/);
  assert.equal(ledger.begin('draft-1', 'op-1', next).started, true);
});
test('unknown verification failure is also durable across a fresh process', t => {
  const { ledger, path } = started(t); ledger.recordOutcome('op-1', 'created', 'receipt');
  assert.throws(() => ledger.verify('op-1', 'other', 'DRAFT'));
  const child = spawnSync(process.execPath, [worker, 'snapshot', path], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).status, 'UNKNOWN');
});
