import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { payAsGuest } from './guest-pay.mjs';
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const origin = value('--origin'), example = value('--case'), out = value('--out'), paid = args.includes('--paid');
if (!origin || !['clean', 'tempting'].includes(example) || !out) throw new Error('Usage: --origin <url> --case clean|tempting --out <dir> [--paid]');
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
let step = 'open';
try {
  const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();   // a context, so the client's tab can open beside it
  page.setDefaultTimeout(60000);
  await page.goto(origin, { timeout: 60000 });
  async function activate(id, key = 'Enter') {
    for (let i = 0; i < 200; i++) {
      if (await page.evaluate(target => document.activeElement?.id === target, id)) { await page.keyboard.press(key); return; }
      await page.keyboard.press('Tab');
    }
    throw new Error('Control unreachable by keyboard');
  }
  step = 'load example'; await activate(`example-${example}`); await page.waitForFunction(() => document.getElementById('work-log').value.length > 0); await page.screenshot({ path: join(out, '01-pasted.png'), fullPage: true });
  // A reply that arrives after the text changed is not shown: the draft request is held back while the work log is edited.
  step = 'text change during a draft';
  await page.route('**/api/draft', async route => { await new Promise(done => setTimeout(done, 800)); await route.continue(); });
  const late = page.waitForResponse('**/api/draft');
  await activate('draft-lines'); await page.locator('#work-log').focus(); await page.keyboard.press('Control+End'); await page.keyboard.type('x'); await page.keyboard.press('Backspace');
  await late; await page.waitForTimeout(300); await page.unroute('**/api/draft');
  if (await page.locator('#flow-results .card').count() !== 0) throw new Error('A reply for changed text was shown');
  step = 'draft'; await activate('draft-lines'); await page.locator('#flow-results .card').first().waitFor(); await page.screenshot({ path: join(out, '02-drafted.png'), fullPage: true });
  // Drafted lines belong to the text they came from: a change to the work log drops them, and the same text is drafted again.
  step = 'text change drops lines'; await activate('edit-sources'); await page.keyboard.press('Control+End'); await page.keyboard.type('x');
  if (await page.locator('#flow-results .card').count() !== 0) throw new Error('Lines survived a change to the work log');
  await page.keyboard.press('Backspace'); await page.keyboard.press('Shift+Tab');  // back before the buttons, so the Tab walk reaches them
  step = 'draft again'; await activate('draft-lines'); await page.locator('#flow-results .card').first().waitFor();
  // A line the AI review disputes needs a reason the client will see; the smoke run gives one.
  step = 'override'; for (const id of await page.locator('#flow-results .card.disputed textarea').evaluateAll(areas => areas.map(area => area.id))) { await activate(id, 'End'); await page.keyboard.type('Agreed with the client in writing.'); }
  // The person compares each line with its quotes and ticks it; approval is refused until every line is ticked.
  step = 'compare'; for (const id of await page.locator('#flow-results input[type=checkbox]').evaluateAll(boxes => boxes.map(box => box.id))) await activate(id, 'Space');
  step = 'approve'; await activate('flow-approve'); await page.screenshot({ path: join(out, '03-approved.png'), fullPage: true });
  step = 'read-back'; await page.waitForFunction(() => document.getElementById('flow-read').textContent.includes('Invoice id:')); await page.screenshot({ path: join(out, '04-read-back.png'), fullPage: true });
  const text = await page.locator('#flow-read').textContent(); const id = text.match(/Invoice id: (\S+)/)?.[1]; if (!id) throw new Error('Missing invoice id'); console.log(id.slice(-4));
  step = 'send'; await activate('flow-send'); await page.waitForFunction(() => document.getElementById('flow-read').textContent.includes('before sending'));
  // The client asks about a line on the proof page; the reply agent drafts an answer that must quote the texts.
  step = 'client question'; const proofPath = await page.locator('#proof-link').getAttribute('href');
  const client = await page.context().newPage(); await client.goto(origin + proofPath);
  await client.waitForFunction(() => !document.getElementById('paypal-check').textContent.startsWith('Checking'));
  await client.locator('#ask-L1').fill('Which pages did the design work cover?'); await client.locator('#ask-send-L1').click();
  await client.getByText('You asked:').first().waitFor();
  step = 'reply agent'; await page.locator('#answer-draft-0').waitFor({ timeout: 15000 }); await activate('answer-draft-0');
  await page.locator('#answer-0').waitFor(); await page.screenshot({ path: join(out, '05-reply-draft.png'), fullPage: true });
  await activate('answer-send-0'); await page.locator('.question .answer').first().waitFor();
  step = 'client sees reply'; await client.reload(); await client.locator('.proof-line .answer').first().waitFor(); await client.screenshot({ path: join(out, '06-client-reply.png'), fullPage: true });
  // A reload keeps every invoice: the earlier-invoices list reopens it with its questions.
  step = 'reopen'; await page.reload(); await page.locator('#history button').first().waitFor(); await page.locator('#history button').first().click();
  await page.locator('.question .answer').first().waitFor(); await page.screenshot({ path: join(out, '07-reopened.png'), fullPage: true });
  // The client disputes the last line; the freelancer agrees and removes it. PayPal's sent invoice is corrected in
  // place and the proof page shows version 1 -> 2 with PayPal matching version 2.
  const count = await client.locator('.proof-line').count();
  if (paid && count >= 2) {
    // The client pays by card as a guest; afterwards a disputed line is given back as a refund of exactly its amount.
    // The payer view is the one PayPal reports for this invoice now, read through the proof API.
    step = 'client pays'; const payer = (await (await fetch(origin + proofPath.replace('/proof/', '/api/proof/'))).json()).paypal.payer_view_url;
    if (!payer) throw new Error('No PayPal payer view (is the sandbox configured?)');
    await payAsGuest(page.context(), payer, { log: console.log });
    step = 'client disputes a paid line'; await client.locator(`#ask-L${count}`).fill('We never agreed to this charge.'); await client.locator(`#ask-send-L${count}`).click();
    await page.locator('#revise-refund-1').waitFor({ timeout: 180000 });
    step = 'refund the line'; page.once('dialog', dialog => dialog.accept()); await page.locator('#revise-refund-1').click();
    await page.waitForFunction(() => document.getElementById('flow-status').textContent.includes('PayPal refunded'), null, { timeout: 90000 });
    console.log((await page.locator('#flow-status').textContent()).trim()); await page.screenshot({ path: join(out, '08-refunded.png'), fullPage: true });
    step = 'client sees refund'; await client.reload(); await client.locator(`#refund-L${count}`).waitFor();
    console.log((await client.locator('#paypal-check').textContent()).trim().slice(0, 160));
    await client.screenshot({ path: join(out, '09-client-refund.png'), fullPage: true });
  } else if (count >= 2) {
    step = 'client disputes a line'; await client.locator(`#ask-L${count}`).fill('We never agreed to this charge.'); await client.locator(`#ask-send-L${count}`).click();
    await page.locator('#revise-remove-1').waitFor({ timeout: 15000 });
    step = 'correct the sent invoice'; page.once('dialog', dialog => dialog.accept()); await page.locator('#revise-remove-1').click();
    await page.waitForFunction(() => document.getElementById('flow-status').textContent.includes('corrected in place'));
    await page.getByText('was removed from the invoice').first().waitFor();
    console.log((await page.locator('#flow-status').textContent()).trim()); await page.screenshot({ path: join(out, '08-corrected.png'), fullPage: true });
    step = 'client sees v2'; await client.reload(); await client.locator('#revision-2').waitFor();
    const banner = (await client.locator('#paypal-check').textContent()).trim(); console.log(banner.slice(0, 60));
    if (!/matches|Could not check/.test(banner)) throw new Error('PayPal does not match version 2');
    await client.screenshot({ path: join(out, '09-client-v2.png'), fullPage: true });
  }
  step = 'revoke'; page.once('dialog', dialog => dialog.accept()); await page.locator('#flow-revoke').click(); await page.locator('#flow-revoke').waitFor({ state: 'hidden' });
  await client.reload(); await client.getByText('This proof is not available.').waitFor();
} catch (error) { console.error(`${step}: ${error.message}`); process.exitCode = 1; } finally { await browser.close(); }
