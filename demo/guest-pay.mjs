// Pays a PayPal sandbox invoice the way a client without a PayPal account would: the payer view, "Debit or Credit
// Card", a sandbox test card and a synthetic US billing address. Sandbox only: the card is generated, not real.
// PayPal shows one of two guest layouts at random (a "Pay now as guest" link, or "Pay Now" beside a sign-up switch),
// and may ask to confirm the address; both are handled.

const SANDBOX_PAYER = /^https:\/\/www\.sandbox\.paypal\.com\//;
/** A sandbox Visa test prefix PayPal accepts for guest card payments. */
const TEST_PREFIX = '403203';

/** A Luhn-valid 16-digit card number under the sandbox test prefix. */
export function testCard(prefix = TEST_PREFIX) {
  let body = prefix; while (body.length < 15) body += Math.floor(Math.random() * 10);
  const sum = [...body].reverse().reduce((s, d, i) => { let n = Number(d); if (i % 2 === 0) { n *= 2; if (n > 9) n -= 9; } return s + n; }, 0);
  return body + ((10 - (sum % 10)) % 10);
}

const BILLING = { fname: 'Demo', lname: 'Client', billingLine1: '2211 N First St', billingCity: 'San Jose', billingState: 'CA', billingPostalCode: '95131', phone: '4085550123', email: 'demo-client@example.com' };

/**
 * Opens the payer view in `context`, pays it by card, and resolves once PayPal closes the card window.
 * `on(event, page, frame)` is awaited at 'invoice' (PayPal's invoice page is ready; `frame` holds its pay buttons), 'card' (the card form is filled, before
 * Pay) and 'paying' (Pay was pressed), so a recording can show those moments and cut the waits between them.
 */
export async function payAsGuest(context, payerViewUrl, { log = () => {}, on = async () => {} } = {}) {
  if (!SANDBOX_PAYER.test(payerViewUrl)) throw new Error('Guest pay runs only against the PayPal sandbox');
  const page = await context.newPage();
  try {
    await page.goto(payerViewUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);
    await page.getByText('Yes, I accept').click({ timeout: 3000 }).catch(() => {});
    const popup = context.waitForEvent('page', { timeout: 30000 });
    let clicked = false;
    for (let attempt = 0; attempt < 10 && !clicked; attempt++) {
      for (const frame of page.frames()) {
        const card = frame.getByText('Debit or Credit Card');
        if (await card.count().catch(() => 0)) { await on('invoice', page, frame); await card.first().click(); clicked = true; break; }
      }
      if (!clicked) await page.waitForTimeout(2000);
    }
    if (!clicked) throw new Error('No card button on the payer view');
    const pop = await popup;
    await pop.waitForTimeout(10000);
    await pop.selectOption('select[name=country]', 'US').catch(() => {});
    await pop.waitForTimeout(4000);
    const fill = async (locator, text) => { if (await locator.count()) { const box = locator.first(); await box.click(); await box.fill(''); await box.pressSequentially(text, { delay: 20 }); } };
    await fill(pop.locator('input[name=cardnumber]'), testCard());
    await fill(pop.locator('input[name=exp-date]'), '12/30');
    await fill(pop.locator('input[name=cvv]'), '123');
    for (const name of ['fname', 'lname', 'billingLine1', 'billingCity', 'billingPostalCode', 'email']) await fill(pop.locator(`input[name=${name}]`), BILLING[name]);
    await pop.selectOption('select[name=billingState]', BILLING.billingState).catch(() => {});
    await fill(pop.getByLabel('Phone number'), BILLING.phone);
    // The sign-up switch, when shown, is turned off: the client pays as a guest.
    await pop.locator('[data-testid=onboard-options-switch]').evaluate(e => { if (e.checked) e.click(); }).catch(() => {});
    await pop.waitForTimeout(1500);
    const guest = pop.getByText(/Pay now as guest/i);
    const layout = (await guest.count()) ? 'guest-link' : 'pay-now';
    const pay = layout === 'guest-link' ? guest.first() : pop.getByRole('button', { name: /^Pay Now$/i });
    await pay.scrollIntoViewIfNeeded().catch(() => {});
    await on('card', pop);
    await pay.click(); await on('paying', pop);
    log(`guest layout: ${layout}`);
    for (let i = 0; i < 8 && !pop.isClosed(); i++) {
      await pop.waitForTimeout(2500).catch(() => {});
      const proceed = pop.getByRole('button', { name: /^Continue$/ });
      if (!pop.isClosed() && await proceed.count().catch(() => 0)) { log('address confirmed'); await proceed.first().click().catch(() => {}); }
    }
    const closed = pop.isClosed() || await pop.waitForEvent('close', { timeout: 60000 }).then(() => true).catch(() => false);
    if (!closed) throw new Error(`PayPal card window did not close (${new URL(pop.url()).pathname})`);
  } finally { await page.close().catch(() => {}); }
}
