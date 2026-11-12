// Labelled run of the reply agent against the live model (Claude session or test proxy, never OpenRouter; see model-endpoint.ts); `--rescore` scores the
// replies already recorded in answer-eval-results.json again without calling the model. The rules are in
// answer-checks.ts: numbers only from the sources (never the question), the quote from this line's own source
// entry, no promise the freelancer has not made, and the case kind met.
import { readFileSync, writeFileSync } from 'node:fs';
import { draftAnswer } from './answer-question.ts';
import type { AnswerLine } from './answer-question.ts';
import { scoreReply } from './answer-checks.ts';
import type { AnswerCase } from './answer-checks.ts';
import { useTestEndpoint } from './model-endpoint.ts';

// `--set holdout` runs the frozen held-out cases (answer-holdout-cases.json, written before any run of them and never
// tuned against) into their own results file, so the development score and the held-out score stay apart.
const setName = process.argv.includes('--set') ? process.argv[process.argv.indexOf('--set') + 1] : 'dev';
if (setName !== 'dev' && setName !== 'holdout') { console.error('usage: node answer-eval.ts [--set dev|holdout] [--rescore]'); process.exit(2); }
const [casesName, resultsName] = setName === 'dev' ? ['answer-cases.json', 'answer-eval-results.json'] : ['answer-holdout-cases.json', 'answer-holdout-results.json'];
const set = JSON.parse(readFileSync(new URL(`./${casesName}`, import.meta.url), 'utf8')) as { log: string; prices: string; lines: Record<string, AnswerLine>; cases: AnswerCase[] };
const sources = { log: set.log, prices: set.prices };
const resultsFile = new URL(`./${resultsName}`, import.meta.url);
const rescore = process.argv.includes('--rescore');
const recorded = rescore ? JSON.parse(readFileSync(resultsFile, 'utf8')) : null;
if (!rescore) useTestEndpoint();

const per_case = [];
for (const item of set.cases) {
  const line = set.lines[item.line]!;
  let reply;
  if (rescore) reply = recorded.per_case.find((c: { id: string }) => c.id === item.id)?.reply;
  else {
    try { reply = await draftAnswer({ question: item.question, line, sources }); }
    catch (error) { per_case.push({ id: item.id, kind: item.kind, pass: false, failure: (error as Error).message }); continue; }
  }
  if (!reply) { per_case.push({ id: item.id, kind: item.kind, pass: false, failure: 'no_recorded_reply' }); continue; }
  const failures = scoreReply(item, line, reply, sources);
  per_case.push({ id: item.id, kind: item.kind, question: item.question, pass: failures.length === 0, failures, reply });
}
const model = per_case.map(c => (c as { reply?: { model: string | null } }).reply?.model).find(Boolean) ?? null;
const output = { model, run_at: rescore ? recorded.run_at : new Date().toISOString(), ...(rescore ? { rescored_at: new Date().toISOString() } : {}), total: per_case.length, pass: per_case.filter(c => c.pass).length, per_case };
writeFileSync(resultsFile, JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ model, rescored: rescore, total: output.total, pass: output.pass, failed: per_case.filter(c => !c.pass).map(c => ({ id: c.id, failures: 'failures' in c ? c.failures : c.failure })) }));
