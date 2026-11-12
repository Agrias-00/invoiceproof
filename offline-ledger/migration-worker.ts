import { DurableLedger } from './ledger.ts';
const [path, phase] = process.argv.slice(2);
const ledger = new DurableLedger(path, { faultInjector: event => {
  if (event.action === 'schema' && event.phase === phase) process.kill(process.pid, 'SIGKILL');
} });
ledger.close();
