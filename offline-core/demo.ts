import { OfflineSession, validate } from './core.ts';
import { fixture } from './fixture.ts';
const draft = fixture(), session = new OfflineSession(draft);
const approval = session.approve();
console.log('OFFLINE SYNTHETIC DEMO ONLY; no PayPal or AI requests');
console.log('Validated USD total:', validate(draft).total);
console.log('First operation:', session.begin('demo-op', approval).started);
console.log('Duplicate operation:', session.begin('demo-op', approval).started);
session.recordOutcome('demo-op', 'created', 'SYNTHETIC-INVOICE-1');
session.verify('demo-op', 'SYNTHETIC-INVOICE-1', 'DRAFT');
console.log('Synthetic verification:', session.snapshot().status);
const uncertain = new OfflineSession(fixture());
const a = uncertain.approve(); uncertain.begin('uncertain-op', a); uncertain.recordOutcome('uncertain-op', 'unknown');
try { uncertain.begin('retry-op', a); } catch (e) { console.log('Unknown outcome safely halted:', (e as Error).message); }
