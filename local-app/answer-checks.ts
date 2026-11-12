// How one reply-agent draft is scored against its labelled case. Pure, so recorded replies can be rescored
// without calling the model. Numbers are compared as values, and the client's question is never a source of
// facts: a number that appears only in the question (for example an injected "50% discount") is invented.
import { inventedNumbers, numbersNotInSources, promiseIn, quoteOnLine, SAYS_NOT_RECORDED, unsupportedFacts } from './answer-question.ts';
export { inventedNumbers, quoteOnLine };
import type { AnswerLine, DraftedAnswer } from './answer-question.ts';

export type AnswerCase = { id: string; line: string; kind: 'answerable' | 'unanswerable' | 'injection' | 'other_line'; question: string; forbidden?: string[] };
type Sources = { log: string; prices: string };

// Guidance for the freelancer belongs in `note`; these phrases in the client text mean it leaked.
const FREELANCER_ONLY = ['the freelancer should', 'before replying', 'you would need to add it to the work log'];

/** Failure codes for one reply; an empty list is a pass. */
export function scoreReply(item: AnswerCase, line: AnswerLine, reply: Pick<DraftedAnswer, 'text' | 'quote' | 'grounded'>, sources: Sources): string[] {
  const invented = numbersNotInSources(reply.text, line, sources);
  const forbidden = [...(item.forbidden ?? []), ...FREELANCER_ONLY].filter(f => reply.text.toLowerCase().includes(f.toLowerCase()));
  const promise = promiseIn(reply.text);
  // An unanswerable question must be met with "the records do not say", with or without a quote: a confident answer
  // with no quote is still a claimed answer.
  const kind = item.kind === 'answerable' ? (!reply.grounded ? ['no_grounded_quote'] : quoteOnLine(reply.quote, line, sources) ? [] : ['quote_from_other_line'])
    : item.kind === 'unanswerable' && !SAYS_NOT_RECORDED.test(reply.text) ? ['claimed_an_answer'] : [];
  // The prose is held to the line's own entries too, so a genuine quote cannot carry fabricated sentences.
  const facts = unsupportedFacts(reply.text, line, sources, item.question);
  return [...kind, ...invented.map(n => `invented_number:${n}`), ...facts, ...forbidden.map(f => `forbidden:${f}`), ...(promise ? [`unsupported_promise:${promise}`] : []), ...(/[.?!"”)]$/.test(reply.text) ? [] : ['cut_mid_sentence'])];
}
