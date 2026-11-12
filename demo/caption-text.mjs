// The on-screen caption for each mark of a take, worded from what that take's marks.json recorded.
// Shared by captions.mjs (burned-in SRT) and production/hf/build.mjs (the film), so both say the same thing.
export const MAX_CAPTION_CHARS = 82;              // a longer caption wraps to a second line and leaves the band

/** Throws unless `take` (a parsed marks.json) is a refund-story take with the recovery scene. */
export function checkTake(take) {
  if (take.story !== 'refund' || !take.paypal_page || !take.marks?.[18] || !take.recovery || !take.resolution || !take.refund?.paypal_note) throw new Error('marks.json is from an older recording; record again with app/demo/record.mjs');
}

/** Captions in mark order: CAPTIONS[i] starts at marks[i + 1]. record.mjs stops a take unless the rush fee was blocked and exactly the client-call line was disputed. */
export function captionsFor(take) {
  checkTake(take);
  const { total_read: totalRead, paid, reply, refund, paypal_page: paypalPage } = take;
  const captions = [
    `Today one questioned line can mean a chargeback on the whole USD ${paid.value}.`,
    'The AI drafts lines. Each must quote the work and the price word for word.',
    'No price to quote for the rush fee, so the app blocks it. It never reaches PayPal.',
    'The app finds every quote in the texts. Each line lights up its own source.',
    'A second AI reads for meaning: one of the two hours was a call, not design.',
    'A judgment call: the freelancer keeps it, and the client will see the AI\'s doubt.',
    totalRead ? 'Approved lines become a PayPal sandbox invoice, read back with PayPal\'s total.' : 'Approved lines become a PayPal sandbox invoice, read back by its id.',
    'Send through PayPal. The invoice links the client to a proof page.',
    'The client sees each line beside its quotes, the AI dispute and the reason.',
    'The client pays by card on PayPal\'s own page. Sandbox card, real sandbox payment.',
    `PayPal records the payment of USD ${paid.value}. The proof page reads it live.`,
    'The client questions the very line the AI disputed: no rate agreed for the call.',
    reply?.grounded ? 'A reply agent drafts the answer from the same log, with a quote the app finds.' : 'A reply agent drafts the answer, and says when the log does not cover it.',
    take.give_back ? `The freelancer returns just the hour in question: USD ${refund.amount} back, USD ${(Number(paid.value) - Number(refund.amount)).toFixed(2)} kept.` : `The app suggests refunding that line alone: USD ${refund.amount} back, USD ${(Number(paid.value) - Number(refund.amount)).toFixed(2)} kept.`,
    `A dropped PayPal reply cannot refund twice, and PayPal's record names the line.`,
    `The client's page leads with the money. USD ${(Number(paid.value) - Number(refund.amount)).toFixed(2)} stays paid, no dispute.`,
    `PayPal's page agrees: ${paypalPage.badge}, USD ${paid.value} paid, USD ${refund.amount} refunded.`,
    'Sandbox only, synthetic data. A script drove the real pages, with live AI calls.',
  ];
  const long = captions.find(text => text.length > MAX_CAPTION_CHARS);
  if (long) throw new Error(`Caption longer than ${MAX_CAPTION_CHARS} characters: ${long}`);
  return captions;
}
