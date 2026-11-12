import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableLedger } from './ledger.ts';
import { fixture } from '../offline-core/fixture.ts';

const directory = mkdtempSync(join(tmpdir(), 'invoiceproof-synthetic-demo-'));
const path = join(directory, 'operations.sqlite');
let ledger = new DurableLedger(path);
try {
  ledger.createDraft('synthetic-draft-1', fixture());
  const approval = ledger.approve('synthetic-draft-1', 1);
  console.log('SYNTHETIC ONLY. No PayPal, AI, network, credentials, invoices or payments.');
  console.log('First durable claim:', ledger.begin('synthetic-draft-1', 'synthetic-op-1', approval).started);
  ledger.recordOutcome('synthetic-op-1', 'created', 'synthetic-remote-1');
  ledger.close(); ledger = new DurableLedger(path);
  console.log('Reopen and repeat claim:', ledger.begin('synthetic-draft-1', 'synthetic-op-1', approval).started);
  ledger.markInterrupted('synthetic-op-1');
  console.log('Interrupted status:', ledger.snapshot('synthetic-draft-1').status);
  ledger.verify('synthetic-op-1', 'synthetic-remote-1', 'DRAFT');
  console.log('Matching synthetic read:', ledger.snapshot('synthetic-draft-1').status);
  ledger.createDraft('synthetic-draft-2', fixture());
  const second = ledger.approve('synthetic-draft-2', 1);
  ledger.begin('synthetic-draft-2', 'synthetic-op-2', second);
  ledger.recordOutcome('synthetic-op-2', 'unknown');
  try { ledger.begin('synthetic-draft-2', 'different-id', second); } catch (error) { console.log('UNKNOWN retry:', (error as Error).message); }
} finally { ledger.close(); rmSync(directory, { recursive: true, force: true }); }
