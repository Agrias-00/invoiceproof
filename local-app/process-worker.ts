import { startLocalApp } from './server.ts';
const [dbPath, action, phase] = process.argv.slice(2);
const ledgerOptions = action ? { faultInjector: (event: { action: string; phase: string }) => {
  if (event.action === action && event.phase === phase) process.kill(process.pid, 'SIGKILL');
} } : {};
const app = await startLocalApp({ dbPath, ledgerOptions });
console.log(JSON.stringify({ origin: app.origin }));
process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
