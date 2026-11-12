// Local synthetic regression worker. Uses only a caller-supplied temporary SQLite file.
import { DurableLedger } from './ledger.ts';
import { fixture } from '../offline-core/fixture.ts';
const [mode, path, operationId, approval, phase] = process.argv.slice(2);
const options = mode.startsWith('crash') ? {
  faultInjector: (event: { action: string; phase: string }) => {
    const action = mode === 'crash-begin' ? 'begin' : 'recordOutcome';
    if (event.action === action && event.phase === phase) process.kill(process.pid, 'SIGKILL');
  },
} : {};
const ledger = new DurableLedger(path, options);
if (mode === 'begin-race') {
  console.log(JSON.stringify({ ready: true }));
  await new Promise<void>(resolve => process.stdin.once('data', () => resolve()));
}
try {
  if (mode === 'crash-outcome') ledger.recordOutcome(operationId, 'created', 'synthetic-receipt');
  else if (mode === 'snapshot') console.log(JSON.stringify(ledger.snapshot('draft-1')));
  else if (mode === 'create-race') {
    ledger.createDraft('draft-1', fixture());
    console.log(JSON.stringify({ created: true }));
  } else console.log(JSON.stringify(ledger.begin('draft-1', operationId, approval)));
} catch (error) { console.log(JSON.stringify({ error: (error as Error).message })); }
ledger.close(); process.stdin.destroy();
