import type { Draft } from './core.ts';
export function fixture(): Draft {
  return { currency: 'USD', evidence: [{ id: 'source-1', documentId: 'SYNTHETIC-ONLY', text: 'Completed 2 hours of demo design at USD 50.00 per hour.', completed: true, quantity: '2', rate: '50.00', currency: 'USD' }], lines: [{ id: 'line-1', evidenceId: 'source-1', description: 'Synthetic design work', quantity: '2', rate: '50.00', currency: 'USD' }] };
}
