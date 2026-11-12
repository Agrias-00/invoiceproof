// Model replies recorded once from the live models, one per demo case, exactly as returned.
// Used only when no model key is set and the pasted text is one of the two examples, so the review flow can be
// tried without an account. The quote check still runs on them at request time; the page says the reply is recorded.
import { DEMO_CASES } from './demo-cases.ts';
import type { Review } from './audit-lines.ts';

export const RECORDED_AT = '2026-11-10';
export const RECORDED_MODEL = 'anthropic/claude-sonnet-5.5';
export const RECORDED_REVIEW_MODEL = 'openai/gpt-5.6-terra';

const DESIGN = { description: 'Design work on the landing page', quantity: '2', rate: '50.00', work_quote: '2 hours design work on the landing page', price_quote: 'Design work: USD 50.00 per hour' };
const COPY = { description: 'Copy editing of the product text', quantity: '1.5', rate: '40.00', work_quote: '1.5 hours copy editing of the product text', price_quote: 'Copy editing: USD 40.00 per hour' };
const PHOTOS = { description: 'Stock photo licences for the gallery', quantity: '3', rate: '12.00', work_quote: '3 stock photo licences for the gallery', price_quote: 'Stock photo licence: USD 12.00 each' };

const RECORDED: Record<(typeof DEMO_CASES)[number]['id'], { lines: unknown[]; reviews: Review[] }> = {
  clean: { lines: [DESIGN, COPY, PHOTOS], reviews: [
    { index: 0, verdict: 'supports', reason: 'The work quote specifies 2 hours of landing page design work, and the price quote lists design work at USD 50.00 per hour.' },
    { index: 1, verdict: 'supports', reason: 'The work quote specifies 1.5 hours of copy editing for the product text, and the price quote lists copy editing at USD 40.00 per hour.' },
    { index: 2, verdict: 'supports', reason: 'The work quote specifies 3 stock photo licences for the gallery, and the price quote lists stock photo licences at USD 12.00 each.' },
  ] },
  tempting: { lines: [DESIGN, COPY, PHOTOS,
    { description: 'Same-day rush delivery of the final files (rush fee)', quantity: '1', rate: '75.00', work_quote: 'same-day rush delivery of the final files, rush fee USD 75.00', price_quote: '' },
    { description: 'Design on the homepage revisions', quantity: '2', rate: '50.00', work_quote: '2 hours design on the homepage revisions', price_quote: 'Design work: USD 50.00 per hour' },
  ], reviews: [
    { index: 0, verdict: 'supports', reason: 'The work log records 2 hours of landing-page design work, and the price list sets design work at USD 50.00 per hour.' },
    { index: 1, verdict: 'supports', reason: 'The work log records 1.5 hours of copy editing, and the price list sets copy editing at USD 40.00 per hour.' },
    { index: 2, verdict: 'supports', reason: 'The work log records 3 stock photo licences, and the price list sets stock photo licences at USD 12.00 each.' },
    { index: 3, verdict: 'disputes', reason: 'The work line states that the 2 hours were mostly spent waiting for client feedback rather than performing design work.' },
  ] },
};

const demoFor = (inputs: { log: string; prices: string }) => DEMO_CASES.find(item => item.log === inputs.log && item.prices === inputs.prices);

/** The recorded drafting reply for inputs that equal a demo case character for character, otherwise null. */
export function recordedReplyFor(inputs: { log: string; prices: string }): { lines: unknown[]; model: string; cost_usd: null; recorded_at: string } | null {
  const demo = demoFor(inputs);
  return demo ? { lines: RECORDED[demo.id].lines, model: RECORDED_MODEL, cost_usd: null, recorded_at: RECORDED_AT } : null;
}
/** The recorded AI review of the accepted lines of a demo case, otherwise null. Indexes count accepted lines only. */
export function recordedReviewsFor(inputs: { log: string; prices: string }): { reviews: Review[]; model: string } | null {
  const demo = demoFor(inputs);
  return demo ? { reviews: RECORDED[demo.id].reviews, model: RECORDED_REVIEW_MODEL } : null;
}
