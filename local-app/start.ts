import { resolve } from 'node:path';
import { sandboxFromEnv } from './paypal-sandbox.ts';
import { startLocalApp } from './server.ts';
const args = process.argv.slice(2);
if (args.length > 2) throw new Error('Usage: node local-app/start.ts [persistent-synthetic-db-path] [port]');
const dbPath = resolve(args[0] ?? 'synthetic-ledger.sqlite');
const port = args[1] === undefined ? 0 : Number(args[1]);
// The proof link written into the PayPal invoice note uses this origin when the client reaches the app at another address.
const publicOrigin = process.env.INVOICEPROOF_PUBLIC_ORIGIN || undefined;
const app = await startLocalApp({ dbPath, port, paypal: sandboxFromEnv(), publicOrigin });
console.log(`Synthetic local demo: ${app.origin}`);
console.log(`Persistent synthetic database: ${dbPath}`);
console.log('Keep the same database path when restarting. Sandbox invoice drafts may be created when configured.');
if (process.env.INVOICEPROOF_FAULT) console.log(`Demo fault on: ${process.env.INVOICEPROOF_FAULT} (the first PayPal refund reply is dropped; the page says it is simulated).`);
let closing = false;
async function shutdown() { if (closing) return; closing = true; await app.close(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
