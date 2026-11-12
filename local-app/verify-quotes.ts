// Verify invoice lines against exact source quotes.
export type ProposedLine = { description: string; quantity: string; rate: string; work_quote: string; price_quote: string };
export type QuoteResult = { status: 'accepted'; line: ProposedLine; work_offset: number; price_offset: number } | { status: 'rejected'; line: unknown; reason: 'MALFORMED_LINE' | 'EMPTY_QUOTE' | 'WORK_QUOTE_NOT_FOUND' | 'PRICE_QUOTE_NOT_FOUND' | 'QUANTITY_NOT_IN_WORK_QUOTE' | 'RATE_NOT_IN_PRICE_QUOTE' | 'QUOTE_SPANS_LINES' | 'WORK_QUOTE_REUSED' };
function canonical(value: string): string {
  const [integer, fraction = ''] = value.replace(/,/g, '').split('.');
  const whole = integer.replace(/^0+(?=\d)/, '');
  const decimal = fraction.replace(/0+$/, '');
  return decimal ? `${whole}.${decimal}` : whole;
}
// Counts people write as words in a work log ("two hours"). Only whole words up to twelve: "a"/"an" are not read as one.
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const WORD_PATTERN = new RegExp(`\\b(${NUMBER_WORDS.join('|')})\\b`, 'gi');
/** Numbers written as digits. Rates are checked against these only: "minimum one hour" never makes 1 a rate. */
export function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(canonical);
}
/** Counts in a work quote: digits, and count words up to twelve. */
export function countsIn(text: string): string[] {
  return [...numbersIn(text), ...(text.match(WORD_PATTERN) ?? []).map(word => String(NUMBER_WORDS.indexOf(word.toLowerCase())))];
}
/** A single delivery at a flat price: the work quote names no count and the price quote is fixed, not per unit. */
function flatPriceSingle(proposal: ProposedLine): boolean {
  return canonical(proposal.quantity) === '1' && countsIn(proposal.work_quote).length === 0 && /\b(fixed|flat)\b/i.test(proposal.price_quote) && !/\b(per|each|every)\b/i.test(proposal.price_quote);
}
/**
 * Accepts a line only when both quotes are found word for word, each inside one line of the pasted text, the quantity
 * is a number in the work quote (digits, or a count word up to twelve; quantity 1 also when the work quote names no
 * count and the price quote is a fixed or flat price) and the rate a number in the price quote. One stretch of the work log supports one
 * line: a second line that quotes the same words needs a second occurrence of them in the log.
 * The check is about text, not meaning: it cannot tell that a quote is the right one for the line.
 */
export function verifyQuotes(inputs: { log: string; prices: string }, lines: unknown[]): QuoteResult[] {
  const usedWork: [number, number][] = [];
  return lines.map((line): QuoteResult => {
    if (!line || typeof line !== 'object' || Array.isArray(line)) return { status: 'rejected', line, reason: 'MALFORMED_LINE' };
    const item = line as Record<string, unknown>;
    if (typeof item.description !== 'string' || typeof item.quantity !== 'string' || typeof item.rate !== 'string' || typeof item.work_quote !== 'string' || typeof item.price_quote !== 'string' || !/^\d+(\.\d+)?$/.test(item.quantity) || !/^\d+(\.\d+)?$/.test(item.rate)) return { status: 'rejected', line, reason: 'MALFORMED_LINE' };
    const proposal = item as ProposedLine;
    if (!proposal.work_quote.trim() || !proposal.price_quote.trim()) return { status: 'rejected', line, reason: 'EMPTY_QUOTE' };
    if (/[\r\n]/.test(proposal.work_quote) || /[\r\n]/.test(proposal.price_quote)) return { status: 'rejected', line, reason: 'QUOTE_SPANS_LINES' };
    let work_offset = inputs.log.indexOf(proposal.work_quote);
    if (work_offset < 0) return { status: 'rejected', line, reason: 'WORK_QUOTE_NOT_FOUND' };
    const price_offset = inputs.prices.indexOf(proposal.price_quote);
    if (price_offset < 0) return { status: 'rejected', line, reason: 'PRICE_QUOTE_NOT_FOUND' };
    if (!countsIn(proposal.work_quote).includes(canonical(proposal.quantity)) && !flatPriceSingle(proposal)) return { status: 'rejected', line, reason: 'QUANTITY_NOT_IN_WORK_QUOTE' };
    if (!numbersIn(proposal.price_quote).includes(canonical(proposal.rate))) return { status: 'rejected', line, reason: 'RATE_NOT_IN_PRICE_QUOTE' };
    const end = (start: number) => start + proposal.work_quote.length;
    while (work_offset >= 0 && usedWork.some(([from, to]) => work_offset < to && end(work_offset) > from)) work_offset = inputs.log.indexOf(proposal.work_quote, work_offset + 1);
    if (work_offset < 0) return { status: 'rejected', line, reason: 'WORK_QUOTE_REUSED' };
    usedWork.push([work_offset, end(work_offset)]);
    return { status: 'accepted', line: proposal, work_offset, price_offset };
  });
}
