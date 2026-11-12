import { readFileSync, writeFileSync } from 'node:fs';
import { auditLines } from './audit-lines.ts';
import type { AuditLine } from './audit-lines.ts';
import { useTestEndpoint } from './model-endpoint.ts';
useTestEndpoint();

const cases = JSON.parse(readFileSync(new URL('./audit-cases.json', import.meta.url), 'utf8')) as (AuditLine & { expected: 'supports' | 'disputes'; kind: string })[];
const result = await auditLines(cases.map(({ description, quantity, rate, work_quote, price_quote }) => ({ description, quantity, rate, work_quote, price_quote })));
const per_case = cases.map((item, index) => ({ ...item, review: result.reviews[index] }));
const output = { model: result.model, run_at: new Date().toISOString(), total: cases.length, agree: per_case.filter(x => x.expected === x.review.verdict).length, misses: per_case.filter(x => x.expected === 'disputes' && x.review.verdict === 'supports').length, false_alarms: per_case.filter(x => x.expected === 'supports' && x.review.verdict === 'disputes').length, not_reviewed: per_case.filter(x => x.review.verdict === 'not_reviewed').length, cost_usd: result.cost_usd, per_case };
writeFileSync(new URL('./audit-eval-results.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ model: output.model, total: output.total, agree: output.agree, misses: output.misses, false_alarms: output.false_alarms, not_reviewed: output.not_reviewed, cost_usd: output.cost_usd }));
