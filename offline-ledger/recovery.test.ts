import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { DurableLedger } from './ledger.ts';
import { DurableLedger as LegacyLedger } from './legacy-v1-ledger.ts';
import { fixture } from '../offline-core/fixture.ts';
const migrationWorker=fileURLToPath(new URL('./migration-worker.ts',import.meta.url));
function setup(t:test.TestContext){
  const dir=mkdtempSync(join(tmpdir(),'invoiceproof-migration-')),path=join(dir,'ledger.sqlite');
  const dbs:{close:()=>void}[]=[];t.after(()=>{for(const db of dbs){try{db.close();}catch{}}rmSync(dir,{recursive:true,force:true});});
  const old=()=>{const db=new LegacyLedger(path);dbs.push(db);return db;};const current=()=>{const db=new DurableLedger(path);dbs.push(db);return db;};return {path,old,current};
}
function oldStarted(t:test.TestContext){const h=setup(t),db=h.old();db.createDraft('draft-1',fixture());const approval=db.approve('draft-1',1);db.begin('draft-1','op-1',approval);return {...h,db,approval};}
function withReceipt(t:test.TestContext){const h=setup(t),db=h.current();db.createDraft('draft-1',fixture());const approval=db.approve('draft-1',1);db.begin('draft-1','op-1',approval);db.recordOutcome('op-1','created','INV2-SYNTHETIC-0001');return {...h,db,approval};}
test('v1 UNKNOWN migrates without losing approval, operation claim or terminal fence',t=>{
  const h=oldStarted(t);h.db.recordOutcome('op-1','unknown');h.db.close();const db=h.current();
  const s=db.snapshot('draft-1');assert.equal(s.status,'UNKNOWN');assert.equal(s.approval,h.approval);assert.equal(s.recoveryCode,'LEGACY_REVIEW_REQUIRED');
  assert.equal(db.begin('draft-1','op-1',h.approval).started,false);assert.throws(()=>db.begin('draft-1','new-op',h.approval));
});
test('v1 saved receipt is retained through migration and only matching read can verify',t=>{
  const h=oldStarted(t);h.db.recordOutcome('op-1','created','INV2-SYNTHETIC-0001');h.db.close();const db=h.current();
  assert.equal(db.snapshot('draft-1').remoteId,'INV2-SYNTHETIC-0001');assert.equal(db.snapshot('draft-1').readChecks,0);
  db.markInterrupted('op-1');db.verify('op-1','INV2-SYNTHETIC-0001','DRAFT');assert.equal(db.snapshot('draft-1').recoveryCode,'MATCHED_DRAFT');
});
test('v1 approved draft with no operation stays approved after atomic upgrade',t=>{
  const h=setup(t),old=h.old();old.createDraft('draft-1',fixture());const approval=old.approve('draft-1',1);old.close();
  assert.equal(h.current().begin('draft-1','op-1',approval).started,true);
});
test('v1 FAILED state is never reopened by migration',t=>{
  const h=oldStarted(t);h.db.recordOutcome('op-1','failed');h.db.close();const db=h.current();assert.equal(db.snapshot('draft-1').status,'FAILED');
  assert.throws(()=>db.recordReadFailure('op-1','READ_TIMEOUT'));assert.equal(db.begin('draft-1','op-1',h.approval).started,false);
});
test('v1 DRAFT_VERIFIED survives migration and cannot regress or create again',t=>{
  const h=oldStarted(t);h.db.recordOutcome('op-1','created','INV2-SYNTHETIC-0001');h.db.verify('op-1','INV2-SYNTHETIC-0001','DRAFT');h.db.close();
  const db=h.current();db.markInterrupted('op-1');assert.equal(db.snapshot('draft-1').status,'DRAFT_VERIFIED');assert.equal(db.begin('draft-1','op-1',h.approval).started,false);
  assert.throws(()=>db.recordReadFailure('op-1','READ_TIMEOUT'),/blocked/);
});
test('migration exception before commit rolls back schema and leaves old version readable',t=>{
  const h=oldStarted(t);h.db.close();assert.throws(()=>new DurableLedger(h.path,{faultInjector:e=>{if(e.action==='schema'&&e.phase==='beforeCommit')throw Error('synthetic migration failure');}}),/migration failure/);
  const raw=new DatabaseSync(h.path);assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version,1);raw.close();
  const legacy=h.old();assert.equal(legacy.begin('draft-1','op-1',h.approval).started,false);legacy.close();
  assert.equal(h.current().snapshot('draft-1').status,'CREATING');
});
for(const phase of ['beforeCommit','afterCommit'])test(`SIGKILL during schema migration ${phase} retains a consistent claimed operation`,t=>{
  const h=oldStarted(t);h.db.close();const child=spawnSync(process.execPath,[migrationWorker,h.path,phase],{encoding:'utf8',timeout:10000});assert.equal(child.signal,'SIGKILL',child.stderr);
  const raw=new DatabaseSync(h.path);assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version,phase==='beforeCommit'?1:2);assert.equal(raw.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');raw.close();
  const db=h.current();assert.equal(db.snapshot('draft-1').status,'CREATING');assert.equal(db.begin('draft-1','op-1',h.approval).started,false);
});
test('read failure metadata persists across reopen and does not rerun migration',t=>{
  const h=withReceipt(t);h.db.recordReadFailure('op-1','READ_TIMEOUT');h.db.close();const db=h.current();
  assert.equal(db.snapshot('draft-1').recoveryCode,'READ_TIMEOUT');assert.equal(db.snapshot('draft-1').readChecks,1);assert.equal(db.snapshot('draft-1').status,'UNKNOWN');
});
test('read checks accumulate atomically and do not release claim',t=>{
  const h=withReceipt(t);h.db.recordReadFailure('op-1','READ_NOT_FOUND');h.current().recordReadFailure('op-1','READ_UNAVAILABLE');
  assert.equal(h.db.snapshot('draft-1').readChecks,2);assert.equal(h.db.begin('draft-1','op-1',h.approval).started,false);
});
test('invalid recovery code and receiptless operation fail closed',t=>{
  const h=oldStarted(t);h.db.close();const db=h.current();assert.throws(()=>db.recordReadFailure('op-1','READ_TIMEOUT'),/receipt/);
  assert.throws(()=>db.recordReadFailure('op-1','CLEAR_AND_RETRY' as never),/Invalid/);assert.equal(db.snapshot('draft-1').readChecks,0);
});
test('late read failure cannot regress a DRAFT_VERIFIED operation',t=>{
  const h=withReceipt(t);h.db.verify('op-1','INV2-SYNTHETIC-0001','DRAFT');assert.throws(()=>h.db.recordReadFailure('op-1','READ_TIMEOUT'),/blocked/);
  assert.equal(h.db.snapshot('draft-1').status,'DRAFT_VERIFIED');assert.equal(h.db.snapshot('draft-1').readChecks,1);
});
test('read failure half-write rollback preserves state and counter together',t=>{
  const h=withReceipt(t);const raw=new DatabaseSync(h.path);raw.exec("CREATE TRIGGER reject_recovery BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;");
  assert.throws(()=>h.db.recordReadFailure('op-1','READ_TIMEOUT'),/synthetic/);assert.equal(h.db.snapshot('draft-1').status,'CREATING');assert.equal(h.db.snapshot('draft-1').readChecks,0);
  raw.exec('DROP TRIGGER reject_recovery');raw.close();
});
test('mutating returned recovery metadata cannot alter the durable ledger',t=>{
  const h=withReceipt(t);const s=h.db.snapshot('draft-1');s.recoveryCode='APPROVED';s.readChecks=999;
  assert.equal(h.db.snapshot('draft-1').recoveryCode,'RECEIPT_SAVED');assert.equal(h.db.snapshot('draft-1').readChecks,0);
});
