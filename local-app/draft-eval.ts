// End-to-end labelled run of the drafting pipeline against the live models (through the test model proxy only; see model-endpoint.ts): the drafting
// model, then the quote check, then the review, as server.ts runs them. A line is "billable" when its quotes are
// found and the review does not dispute it, which is what reaches the freelancer's approval unflagged.
// A case passes when the billable lines are exactly the ones a careful freelancer would bill ("bill" in
// draft-cases.json: a work-quote fragment, quantity and rate), so a line slipping through and a right line lost both fail.
import { readFileSync, writeFileSync } from 'node:fs';
import { draftLines } from './draft-lines.ts';
import { verifyQuotes, numbersIn } from './verify-quotes.ts';
import type { ProposedLine } from './verify-quotes.ts';
import { auditLines } from './audit-lines.ts';
import { useTestEndpoint } from './model-endpoint.ts';
useTestEndpoint();

type Expected = { quote: string; quantity: string; rate: string };
type Case = { id: string; kind: string; log: string; prices: string; bill: Expected[] };
const { cases } = JSON.parse(readFileSync(new URL('./draft-cases.json', import.meta.url), 'utf8')) as { cases: Case[] };
const same = (a: string, b: string) => numbersIn(a)[0] === numbersIn(b)[0];
const matches = (line: ProposedLine, want: Expected) => line.work_quote.includes(want.quote) && same(line.quantity, want.quantity) && same(line.rate, want.rate);

/** Pairs billable lines with expected ones; whatever is left on either side is a failure. */
export function score(billable: ProposedLine[], bill: Expected[]): string[] {
  const open = [...billable];
  const missing = bill.filter(want => { const at = open.findIndex(line => matches(line, want)); if (at < 0) return true; open.splice(at, 1); return false; });
  return [...missing.map(m => `lost:${m.quote} x${m.quantity} @${m.rate}`), ...open.map(l => `slipped:${l.work_quote} x${l.quantity} @${l.rate}`)];
}

// `--runs N` repeats the whole set: model replies vary between calls, so one pass of 10 is not a stability figure.
const runsArg = process.argv.indexOf('--runs');
const RUNS = runsArg > 0 ? Number(process.argv[runsArg + 1]) : 1;
if (!Number.isInteger(RUNS) || RUNS < 1 || RUNS > 10) throw new Error('--runs takes a whole number from 1 to 10');
const runs = [];
let cost = 0;
for (let run = 1; run <= RUNS; run++) {
const per_case = [];
for (const item of cases) {
  const inputs = { log: item.log, prices: item.prices };
  let drafted;
  try { drafted = await draftLines(inputs); } catch (error) { per_case.push({ id: item.id, kind: item.kind, pass: false, failures: [(error as Error).message] }); continue; }
  const checked = verifyQuotes(inputs, drafted.lines);
  const kept = checked.flatMap(r => r.status === 'accepted' ? [r] : []);
  const accepted = kept.map(r => r.line);
  // The offsets the quote check found, as server.ts passes them: the same words on two log lines get their own context.
  const offsets = kept.map(r => ({ work: r.work_offset, price: r.price_offset }));
  const audit = accepted.length ? await auditLines(accepted, { sources: { ...inputs, offsets } }) : { reviews: [], cost_usd: 0, model: null };
  cost += (drafted.cost_usd ?? 0) + (audit.cost_usd ?? 0);
  const billable = accepted.filter((_, i) => audit.reviews[i]?.verdict !== 'disputes');
  // A line the review never answered is not a pass by silence: the case fails.
  const unreviewed = accepted.flatMap((line, i) => audit.reviews[i]?.verdict === 'not_reviewed' ? [`not_reviewed:${line.work_quote}`] : []);
  const failures = [...score(billable, item.bill), ...unreviewed];
  per_case.push({
    id: item.id, kind: item.kind, pass: failures.length === 0, failures,
    lines: checked.map(r => r.status === 'accepted'
      ? { ...r.line, check: 'quotes found', review: audit.reviews[accepted.indexOf(r.line)] }
      : { ...(r.line as object), check: r.reason }),
  });
}
runs.push({ run, total: per_case.length, pass: per_case.filter(c => c.pass).length, per_case });
}
const passes = runs.flatMap(r => r.per_case);
const by_case = cases.map(item => ({ id: item.id, pass: passes.filter(c => c.id === item.id && c.pass).length, of: RUNS }));
const output = { draft_model: process.env.INVOICEPROOF_MODEL ?? 'anthropic/claude-sonnet-5.5', review_model: process.env.INVOICEPROOF_AUDIT_MODEL ?? 'openai/gpt-5.6-terra', run_at: new Date().toISOString(), runs: RUNS, total: passes.length, pass: passes.filter(c => c.pass).length, cost_usd: Number(cost.toFixed(4)), by_case, per_run: runs };
writeFileSync(new URL('./draft-eval-results.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ runs: RUNS, total: output.total, pass: output.pass, cost_usd: output.cost_usd, unstable: by_case.filter(c => c.pass < c.of), failed: passes.filter(c => !c.pass).map(c => ({ id: c.id, failures: c.failures })) }));
