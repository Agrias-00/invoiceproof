// Records the demo video: drives the running app in a real browser against the PayPal sandbox and live model
// calls, and writes raw.mkv plus marks.json (the second of the finished cut at which each caption's moment begins).
// Nothing is staged: the lines on screen are what the models returned in this run, and the payment is a real sandbox
// card payment on PayPal's own pages. marks.json records what this run showed, so captions.mjs and narrate.mjs word
// their lines truthfully.
// Story: the AI drafts lines that must quote the work log and price list; the rush fee is blocked; the second AI
// disputes billing two hours of waiting as design work and the freelancer keeps it with a reason the client will see;
// the invoice is sent through PayPal; the client opens the proof page and pays by card on PayPal; then questions that
// line; the reply agent drafts from the same log; the freelancer refunds exactly that line on PayPal; the client's
// page opens on paid, refunded and kept; and PayPal's own invoice page lists the payment and the refund.
// Each tab (app, proof page, PayPal invoice, PayPal card window) records separately; they are spliced on the shared
// wall clock, switching to whichever tab the story is on, and PayPal's waits are cut out.
// Usage: node record.mjs --origin http://127.0.0.1:<port> --out <dir>
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { payAsGuest } from './guest-pay.mjs';

const args = process.argv.slice(2);
const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const origin = value('--origin'), out = value('--out'), again = value('--splice');
if (!again && (!origin || !out)) throw new Error('Usage: --origin <url> --out <dir> | --splice <dir of an earlier take>');

// Captured at twice the 1920x960 layout (a 3840x1920 viewport at twice the zoom: the same layout, four times the
// pixels), so the film's camera can move in on a box without upscaling. Playwright's video ignores deviceScaleFactor.
const VIDEO = { width: 3840, height: 1920 };
const ZOOM = 2.8;                                // page zoom for the app and proof page (1.4 at 1920 wide)
const CASE = 'tempting';                         // the work log with a rush fee the price list does not have
// Second of the finished cut at which each caption's moment begins. The script waits for these, so model and PayPal
// latency only move later marks. Spaced so each narration line fits before the next mark. Mark 15 is the recovery
// from a lost PayPal reply, staged by the server's opt-in INVOICEPROOF_FAULT=refund-lost-reply and said so on screen.
const AT = { 1: 0, 2: 5, 3: 13, 4: 19, 5: 26, 6: 32, 7: 42, 8: 49, 9: 55, 10: 65, 11: 75, 12: 81, 13: 90, 14: 100, 15: 105, 16: 112, 17: 125, 18: 134 };
const END = 140;                                 // with the cold open and end card the video stays under 180 s
const PAYPAL_ZOOM = 2.6;                         // PayPal's invoice page, so its status badge and payment activity read at video size
const HOVER_HOLD_MS = 2400;                      // each line stays highlighted with its source this long
const TICK_HOLD_MS = 550;
const LOOK_HOLD_MS = 2800;                       // a key look (kept reason, refund done) stays still this long before the page moves on
const PAYPAL_REFUND_TRIES = 72;                   // payer-page reloads (about 10 s each; take 13 waited over six minutes) while waiting for the refund
const PAYPAL_HOLD_MS = 3500;                    // how long PayPal's refunded invoice page stays on screen (twice this)
const PAY_HOLD_MS = 2500;                        // the invoice and the filled card form while the client pays: enough to read, then on
const SHOWN_MS = 2500;                           // a model or PayPal call shows its working state this long; the rest of the wait is cut
const KEEP_REASON = 'Revisions the client asked for.';
const QUESTION = 'Your own log says these two hours were mostly waiting for our feedback.';
const RUSH_FEE = /rush fee/i;                    // the fee in the tempting work log that the price list does not have
const WAITING = /waiting/i;                      // the disputed line bills time spent waiting for feedback
const BACKDROP = '0xE9EDF2';                     // fills the frame around a tab that paints less than the frame

if (again) {
  // Redo the splice of an earlier take from its splice.json, without recording again.
  const { inputs, pieces } = JSON.parse(await readFile(join(again, 'splice.json'), 'utf8'));
  splice(again, inputs.map(i => join(again, i.file)), pieces, inputs.map(i => i.size));
  process.exit(0);
}

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
// English locale and a fixed time zone, so dates on screen read the same as the English narration on any machine.
const context = await browser.newContext({ viewport: VIDEO, locale: 'en-US', timezoneId: 'America/Los_Angeles', recordVideo: { dir: out, size: VIDEO } });
const opened = new Map();                        // page -> wall second its own recording began
const page = await context.newPage();
const started = Date.now();
opened.set(page, 0);
context.on('page', p => opened.set(p, seconds()));
const seconds = () => (Date.now() - started) / 1000;
// Cut ranges (wall seconds) leave the finished video; marks are in seconds of the finished cut.
const skips = []; let cutFrom = null;
const cutSoFar = () => skips.reduce((sum, [a, b]) => sum + b - a, 0) + (cutFrom === null ? 0 : seconds() - cutFrom);
const now = () => seconds() - cutSoFar();
const cut = () => { if (cutFrom === null) cutFrom = seconds(); };
const uncut = () => { if (cutFrom !== null) { skips.push([cutFrom, seconds()]); cutFrom = null; } };
const sizes = new Map();                         // page -> [width, height] it paints, when it may differ from the frame
const switches = [];                             // [wall second, page] each time the video cuts to another tab
const views = [];                                // [second of the finished cut, tab] at each switch, so the film's camera resets on a cut
const show = p => { switches.push([seconds(), p]); views.push([Number(now().toFixed(2)), p === page ? 'app' : p === proofTab ? 'proof' : 'paypal']); };
const marks = {};
// Where the film's camera should look: [second of the finished cut, tab, label, box as fractions of the frame].
// Only the app and proof tabs (painted at the frame size) carry boxes; PayPal's own pages are shown whole.
const looks = [];
// [second of the finished cut, tab] each time a page starts scrolling. A look holds only until its tab next moves:
// the film's camera and callouts end there, so they never frame a spot the page has already scrolled away from.
const moves = [];
async function track(p, tab) {
  await p.exposeFunction('__moved', () => { moves.push([Number(now().toFixed(2)), tab]); });
  await p.addInitScript(() => {
    let idle = true, timer;
    addEventListener('scroll', () => { if (idle) window.__moved(); idle = false; clearTimeout(timer); timer = setTimeout(() => { idle = true; }, 300); }, { passive: true });
  });
}
// [second of the finished cut, box] for each other company's payment button on PayPal's invoice page (Apple Pay,
// Google Pay, Venmo): the contest allows no third-party marks, so the film blurs that box while the page shows.
const masks = [];
const OTHER_BRANDS = ['Apple', 'Google Pay', 'Venmo'];
async function maskOtherBrands(p, frame) {
  const [w, h] = sizes.get(p);
  const selector = OTHER_BRANDS.flatMap(b => [`[aria-label*="${b}" i]`, `img[alt*="${b}" i]`, `[title*="${b}" i]`]).join(',') + ',[data-funding-source=applepay],[data-funding-source=googlepay],[data-funding-source=venmo]';
  let found = 0;
  for (const f of new Set([frame, ...p.frames()].filter(Boolean))) {
    for (const el of await f.locator(selector).all().catch(() => [])) {
      const b = await el.boundingBox().catch(() => null);
      if (!b?.width || !b.height || b.y + b.height < 0 || b.y > h) continue;
      masks.push([Number(now().toFixed(2)), [b.x / w, b.y / h, b.width / w, b.height / h].map(v => Number(v.toFixed(4)))]); found++;
    }
  }
  // PayPal decides per buyer which buttons it offers; none found is fine only if none is on screen, so say so loudly.
  console.warn(found ? `masked ${found} other-brand button box(es) on PayPal's invoice page` : 'no other-brand button found on PayPal\'s invoice page: check the frame at the PayPal invoice view');
}
/**
 * The invoice note links the client to the proof page. In a local take that link is this machine's loopback address,
 * which no client could open: the film covers just the address with a label saying so (third mask field).
 */
async function maskLocalLink(p) {
  const [w, h] = sizes.get(p) ?? await p.evaluate(() => [innerWidth, innerHeight]);
  const boxes = await p.evaluate(() => {
    const out = [], walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const at = n.data.search(/https?:\/\/(127\.0\.0\.1|localhost)[^\s·]*/);
      if (at < 0) continue;
      const end = at + n.data.slice(at).match(/^\S+/)[0].length, range = document.createRange();
      range.setStart(n, at); range.setEnd(n, end);
      for (const r of range.getClientRects()) if (r.width && r.height) out.push([r.x, r.y, r.width, r.height]);
    }
    return out;
  }).catch(() => []);
  for (const [x, y, bw, bh] of boxes) if (y + bh > 0 && y < h) masks.push([Number(now().toFixed(2)), [x / w, y / h, bw / w, bh / h].map(v => Number(v.toFixed(4))), 'proof page link · local demo address']);
  console.warn(boxes.length ? `masked ${boxes.length} local proof link box(es) on PayPal's page` : 'no local proof link found on PayPal\'s page');
}
let step = 'open', failed = false, proofTab = null;
const run = { blocked: false, blocked_line: null, disputed_line: null, invoice_id_tail: null, total_read: false, paid: null, reply: null, refund: null, recovery: null, refunded_banner: null, summary: null, paypal_page: null };

/**
 * Joins the pieces into raw.mkv. A filter graph may read each input label once, so an input used twice is split first.
 * A tab whose page is smaller than the frame (PayPal's card window) is cropped to its page and centred on a backdrop.
 */
function splice(dir, paths, plan, sizes = []) {
  const fit = input => { const [w, h] = sizes[input] ?? []; return w && h && (w < VIDEO.width || h < VIDEO.height) ? `crop=${w}:${h}:0:0,scale=${VIDEO.width}:${VIDEO.height}:force_original_aspect_ratio=decrease,pad=${VIDEO.width}:${VIDEO.height}:(ow-iw)/2:(oh-ih)/2:color=${BACKDROP}` : `scale=${VIDEO.width}:${VIDEO.height}`; };
  const uses = paths.map((_, input) => plan.filter(([i]) => i === input).length);
  const taken = paths.map(() => 0);
  const splits = uses.map((n, input) => n > 0 ? `[${input}:v]split=${n}${Array.from({ length: n }, (_, k) => `[s${input}_${k}]`).join('')}` : null).filter(Boolean);
  const trims = plan.map(([input, from, to], i) => `[s${input}_${taken[input]++}]trim=${from}:${to},setpts=PTS-STARTPTS,${fit(input)},setsar=1,fps=25[p${i}]`);
  execFileSync('ffmpeg', ['-y', '-loglevel', process.env.FFLOG ?? 'error', ...paths.flatMap(path => ['-i', path]), '-filter_complex',
    `${[...splits, ...trims].join(';')};${plan.map((_, i) => `[p${i}]`).join('')}concat=n=${plan.length}:v=1[v]`,
    // A near-lossless fast intermediate: captions.mjs makes the final encode.
    '-map', '[v]', '-c:v', 'libx264', '-crf', '12', '-preset', 'veryfast', join(dir, 'raw.mkv')], { stdio: 'inherit' });
}

/** Waits for `done`; a wait longer than SHOWN_MS keeps its first SHOWN_MS on screen and the rest is cut. */
async function shortened(done) {
  const finished = done();
  const quick = await Promise.race([finished.then(() => true), page.waitForTimeout(SHOWN_MS).then(() => false)]);
  if (!quick) { cut(); await finished; await page.waitForTimeout(600); uncut(); }
}

async function mark(caption) {
  const wait = AT[caption] - now();
  if (wait > 0) await page.waitForTimeout(wait * 1000);
  marks[caption] = Number(now().toFixed(2));
}
const zoom = p => p.evaluate(z => { document.documentElement.style.zoom = String(z); }, ZOOM);  // through the CSSOM: the CSP allows no inline style
// Smooth scrolls return at once so the script's own waits overlap them. The tab is remembered, and the next look on
// it waits for that scroll to stop (see look()).
const scrolled = new Set();
const scrollTo = (p, loc, block = 'center') => { scrolled.add(p); return loc.evaluate((el, b) => el.scrollIntoView({ behavior: 'smooth', block: b }), block); };
const into = (p, selector, block = 'center') => scrollTo(p, p.locator(selector).first(), block);
// A smooth scroll can start frames after it is asked for, so a page that has not moved yet only counts as settled
// after SCROLL_START_MS. A look taken sooner measured its target where it was before the scroll, off screen, and the
// film lost that framing (takes v4 and v5: refunded, limits, question, kept reason, paypal draft).
const SCROLL_START_MS = 300;
const scrollStopped = p => p.waitForFunction(startMs => new Promise(done => {
  const t0 = performance.now(); let y = scrollY, moved = false, stillSince = t0;
  const tick = () => requestAnimationFrame(() => {
    const t = performance.now();
    if (scrollY !== y) { moved = true; y = scrollY; stillSince = t; }
    if ((moved && t - stillSince > 150) || (!moved && t - t0 > startMs)) done(true); else tick();
  });
  tick();
}), SCROLL_START_MS, { timeout: 5000 }).catch(() => {});
/**
 * Records the union of the visible boxes of `targets` (selectors or locators) on tab `p` as the camera's next target,
 * in fractions of the frame. boundingBox() is in viewport pixels, and the app and proof tabs paint the whole frame.
 */
async function look(p, label, ...targets) {
  // After a smooth scroll on this tab, wait for it to stop; otherwise only check that nothing is still moving.
  if (scrolled.delete(p)) await scrollStopped(p);
  else await p.waitForFunction(() => new Promise(done => { const y = scrollY; setTimeout(() => done(scrollY === y), 150); }), null, { polling: 50, timeout: 5000 }).catch(() => {});
  const measure = async () => {
    const boxes = [];
    for (const t of targets) for (const el of await (typeof t === 'string' ? p.locator(t) : t).all()) { const b = await el.boundingBox(); if (b?.width && b.height) boxes.push(b); }
    return boxes.filter(b => b.y + b.height > 0 && b.y < VIDEO.height);
  };
  let shown = await measure();
  // A re-render during the scroll can leave the target off screen (take v11: the refund status line); bring the first
  // target back into view once and measure again.
  if (!shown.length && targets.length) {
    const first = typeof targets[0] === 'string' ? p.locator(targets[0]).first() : targets[0].first();
    if (await first.count()) { await scrollTo(p, first); scrolled.delete(p); await scrollStopped(p); shown = await measure(); }
  }
  let box = null;
  if (shown.length) {
    const x = Math.max(0, Math.min(...shown.map(b => b.x))), y = Math.max(0, Math.min(...shown.map(b => b.y)));
    const right = Math.min(VIDEO.width, Math.max(...shown.map(b => b.x + b.width))), bottom = Math.min(VIDEO.height, Math.max(...shown.map(b => b.y + b.height)));
    box = [x / VIDEO.width, y / VIDEO.height, (right - x) / VIDEO.width, (bottom - y) / VIDEO.height].map(v => Number(v.toFixed(4)));
  }
  // A look with nothing on screen gets no camera move or callout in the film; say so while the take can be redone.
  if (!box) console.warn(`look "${label}": no visible target, the film will not frame it`);
  looks.push([Number(now().toFixed(2)), p === page ? 'app' : 'proof', label, box]);
}
async function press(p, selector, key = 'Enter') { await p.locator(selector).focus(); await p.waitForTimeout(500); await p.keyboard.press(key); }

try {
  page.setDefaultTimeout(90000);
  await track(page, 'app');
  await page.goto(origin); await zoom(page);
  show(page);
  await mark(1);
  step = 'load'; await press(page, `#example-${CASE}`);
  await page.waitForFunction(() => document.getElementById('work-log').value.length > 0);

  step = 'draft'; await mark(2);
  await press(page, '#draft-lines');
  await shortened(() => page.locator('#flow-results .card').first().waitFor());
  // Captions and narration say "the rush fee was blocked" and "the second AI disputes the waiting time": the take
  // stops unless this run showed exactly that, and the card texts are kept as the evidence.
  // An earlier take on the same database has already invoiced this log, which flags every line; that is not this story.
  if (await page.locator('#flow-results .card').filter({ hasText: /Already on invoice/ }).count()) throw new Error('this log is already invoiced in the server\'s database; restart the server on a fresh database for each take');
  const rushCard = page.locator('#flow-results .card.blocked').filter({ hasText: RUSH_FEE }).first();
  run.blocked = await rushCard.count() > 0;
  if (!run.blocked) throw new Error('the rush fee was not blocked in this run; re-take');
  run.blocked_line = (await rushCard.innerText()).replace(/\s+/g, ' ').trim();
  const disputedCards = page.locator('#flow-results .card.disputed');
  if (await disputedCards.count() !== 1 || !WAITING.test(await disputedCards.first().innerText())) throw new Error('the review did not dispute exactly the waiting-time line; re-take');
  run.disputed_line = (await disputedCards.first().innerText()).replace(/\s+/g, ' ').trim();

  step = 'blocked'; await mark(3);
  await scrollTo(page, rushCard); await rushCard.hover();
  await look(page, 'blocked', rushCard);

  step = 'quotes'; await mark(4);
  const kept = page.locator('#flow-results .card:not(.blocked)');
  for (let i = 0; i < Math.min(3, await kept.count()); i++) {
    await kept.nth(i).scrollIntoViewIfNeeded(); await kept.nth(i).hover();
    // The card and the source marks its proof thread points at.
    await look(page, `quote ${i + 1}`, kept.nth(i), '.source-text mark.on');
    await page.waitForTimeout(HOVER_HOLD_MS - 450);
  }

  step = 'review'; await mark(5);
  await into(page, '#flow-results .card.disputed'); await disputedCards.first().hover();
  await look(page, 'disputed', disputedCards.first());

  // The freelancer keeps the disputed line and says why; the client will see the dispute and this reason.
  step = 'keep'; await mark(6);
  const reasonId = await disputedCards.first().locator('textarea').getAttribute('id');
  await into(page, `#${reasonId}`); await page.locator(`#${reasonId}`).focus(); await page.keyboard.type(KEEP_REASON, { delay: 40 });
  const ticks = await page.locator('#flow-results input[type=checkbox]').evaluateAll(boxes => boxes.map(box => box.id));
  await look(page, 'keep reason', `#${reasonId}`, disputedCards.first().locator('.review-note'));
  await page.waitForTimeout(LOOK_HOLD_MS);
  for (const id of ticks) { await into(page, `#${id}`); await page.waitForTimeout(TICK_HOLD_MS); await press(page, `#${id}`, 'Space'); await page.waitForTimeout(TICK_HOLD_MS); }
  await into(page, '#flow-approve');
  await look(page, 'approve', '.approve-bar');

  step = 'approve'; await mark(7);
  await press(page, '#flow-approve');
  await shortened(() => page.waitForFunction(() => document.getElementById('flow-read').textContent.includes('Invoice id:')));
  await into(page, '#paypal-pane', 'start');
  await look(page, 'paypal draft', '.timeline', '#flow-read');
  const readBack = await page.locator('#flow-read').textContent();
  run.invoice_id_tail = readBack.match(/Invoice id: (\S+)/)?.[1]?.slice(-4) ?? null;
  run.total_read = readBack.includes('Total held by PayPal:');

  step = 'send'; await mark(8);
  await press(page, '#flow-send');
  await shortened(() => page.waitForFunction(() => document.getElementById('flow-read').textContent.includes('before sending')));
  await into(page, '#paypal-pane', 'start');
  await look(page, 'sent', '.timeline');

  step = 'proof'; await mark(9);
  const proofPath = await page.locator('#proof-link').getAttribute('href');
  proofTab = await context.newPage(); proofTab.setDefaultTimeout(90000);
  await track(proofTab, 'proof');
  await proofTab.goto(origin + proofPath); await zoom(proofTab);
  await proofTab.waitForFunction(() => !document.getElementById('paypal-check').textContent.startsWith('Checking'));
  show(proofTab);
  await look(proofTab, 'proof page', '#proof-title', '#paypal-check');
  await proofTab.waitForTimeout(2550);
  // The caption names the AI dispute and the kept reason: they are on the last line, so that line is shown.
  await into(proofTab, '.proof-line:last-child'); await look(proofTab, 'kept reason', '.proof-line:last-child'); await proofTab.waitForTimeout(3550);

  // The client pays the invoice by card on PayPal's own pages. Only the invoice and the filled card form are shown;
  // PayPal's loading and processing waits are cut.
  step = 'pay'; await mark(10);
  const payer = (await (await fetch(origin + proofPath.replace('/proof/', '/api/proof/'))).json()).paypal.payer_view_url;
  if (!payer) throw new Error('No PayPal payer view');
  cut();
  await payAsGuest(context, payer, { log: console.log, on: async (event, p, frame) => {
    // PayPal's invoice tab paints the 4K frame at 1x: zoom it like the refund page. The card window keeps its own size.
    if (event === 'invoice') await p.evaluate(z => { document.documentElement.style.zoom = String(z); }, PAYPAL_ZOOM).catch(() => {});
    if (event === 'invoice' || event === 'card') { sizes.set(p,await p.evaluate(() => [innerWidth, innerHeight])); uncut(); show(p);
      if (event === 'invoice') { await maskOtherBrands(p, frame); await maskLocalLink(p); }
      await p.waitForTimeout(PAY_HOLD_MS);
      // A zoomed parent page throws off clicks inside PayPal's button iframe, so the zoom is undone off camera.
      if (event === 'invoice') { cut(); await p.evaluate(() => { document.documentElement.style.zoom = ''; }).catch(() => {}); } }
    if (event === 'paying') { await p.waitForTimeout(1500).catch(() => {}); cut(); }
  } });
  step = 'paid';
  for (let i = 0; i < 30; i++) {
    await proofTab.reload(); await zoom(proofTab);
    await proofTab.waitForFunction(() => !document.getElementById('paypal-check').textContent.startsWith('Checking'));
    if (await proofTab.getByText(/PayPal records a payment/).count()) break;
    await proofTab.waitForTimeout(3000);
  }
  const paidText = (await proofTab.locator('#paypal-check').innerText()).replace(/\s+/g, ' ').trim();
  if (!/PayPal records a payment/.test(paidText)) throw new Error('PayPal did not report the payment');
  run.paid = { banner: paidText, value: paidText.match(/payment of USD (\d+\.\d{2})/)?.[1] ?? null };
  await into(proofTab, '#paypal-check');
  uncut(); show(proofTab);
  await mark(11);
  await look(proofTab, 'paid', '#paypal-check');

  step = 'question'; await mark(12);
  // Blocked lines keep their numbers, so the questioned line is found by its text, not by its position.
  const waitingLine = proofTab.locator('.proof-line').filter({ hasText: WAITING });
  if (await waitingLine.count() !== 1) throw new Error('the proof page does not show exactly one waiting-time line');
  const ref = (await waitingLine.getAttribute('id')).replace(/^line-/, '');
  await into(proofTab, `#line-${ref}`); await look(proofTab, 'question', `#line-${ref}`); await proofTab.waitForTimeout(750);
  await proofTab.locator(`#ask-${ref}`).focus(); await proofTab.keyboard.type(QUESTION, { delay: 40 });
  await press(proofTab, `#ask-send-${ref}`);
  await proofTab.getByText(`You asked: ${QUESTION}`).waitFor();
  await proofTab.waitForTimeout(1500);
  show(page);
  await page.locator('#revise-refund-0').waitFor({ timeout: 30000 });
  await into(page, '#questions');

  step = 'reply'; await mark(13);
  await press(page, '#answer-draft-0');
  await shortened(() => page.locator('#answer-0').waitFor());
  await into(page, '#answer-0');
  await look(page, 'reply', '#questions li:first-child');
  run.reply = { text: await page.locator('#answer-0').inputValue(), grounded: await page.locator('#questions q').count() > 0, quote: (await page.locator('#questions q').first().textContent().catch(() => null)) ?? null };

  // The server runs with INVOICEPROOF_FAULT=refund-lost-reply: PayPal makes the refund, then its reply is dropped
  // once. The app says so ("Simulated lost reply") and the retry resends the same PayPal-Request-Id.
  step = 'refund'; await mark(14);
  await into(page, '#revise-refund-0'); await page.waitForTimeout(800);
  page.on('dialog', dialog => dialog.accept());     // the browser's confirm box is not in the recording; the script accepts it
  await press(page, '#revise-refund-0');
  await shortened(() => page.locator('#questions .refund-note').waitFor());
  const lost = (await page.locator('#questions .refund-note').innerText()).replace(/\s+/g, ' ').trim();
  if (!/^Simulated lost reply/.test(lost)) throw new Error('the refund reply was not lost; start the server with INVOICEPROOF_FAULT=refund-lost-reply');
  await into(page, '#revise-refund-0');
  await look(page, 'lost reply', '#questions .refund-note', '#revise-refund-0');

  step = 'retry'; await mark(15);
  run.recovery = { note: lost, retry_label: (await page.locator('#revise-refund-0').innerText()).trim() };
  await press(page, '#revise-refund-0');
  await shortened(() => page.waitForFunction(() => document.getElementById('flow-status').textContent.includes('PayPal refunded')));
  const status = (await page.locator('#flow-status').textContent()).replace(/\s+/g, ' ');
  const refund = status.match(/PayPal refunded USD (\d+\.\d{2}) for (L\d+) \(refund (\S+), (\w+)\)/);
  if (!refund) throw new Error('refund message not found');
  run.refund = { amount: refund[1], ref: refund[2], id_tail: refund[3].slice(-4), status: refund[4] };
  // PayPal's reply lands in the same card the freelancer pressed: amount, refund id, status, and that the retry got the
  // first refund back. The camera stays on that card (take v9 framed the status line above, over another line's card).
  await page.locator('#refund-done-0').waitFor();
  await into(page, '#questions li:first-child .revise');
  await look(page, 'refunded', '#questions li:first-child .revise');
  await page.waitForTimeout(LOOK_HOLD_MS);
  await press(page, '#answer-send-0');
  await page.getByText('Reply published').waitFor();

  step = 'client sees refund'; await mark(16);
  await proofTab.reload(); await zoom(proofTab);
  await proofTab.locator(`#refund-${ref}`).waitFor();
  // The page opens on its summary: paid, refunded and kept, and the questioned line tagged as refunded.
  show(proofTab);
  await look(proofTab, 'proof summary', '#proof-summary');
  run.refunded_banner = (await proofTab.locator('#paypal-check').innerText()).replace(/\s+/g, ' ').trim();
  run.title = (await proofTab.locator('#proof-title').innerText()).trim();
  run.summary = (await proofTab.locator('#proof-summary').innerText()).replace(/\s+/g, ' ').trim();
  if (!run.summary.includes(`USD ${run.refund.amount}`)) throw new Error('the proof summary does not show the refund');
  // Then the questioned line itself: the freelancer's published reply and the refund, where the client reads them.
  await proofTab.waitForTimeout(LOOK_HOLD_MS);
  await into(proofTab, `#refund-${ref}`);
  await look(proofTab, 'client reply', `#refund-${ref}`, proofTab.locator('.answer').first());
  await proofTab.waitForTimeout(LOOK_HOLD_MS);

  // PayPal's own invoice page shows the refund about half a minute after PayPal confirms it; that wait and the page
  // loads are cut, and the page is shown only once it lists the refund.
  step = 'paypal shows refund';
  cut();
  const paypalTab = await context.newPage(); paypalTab.setDefaultTimeout(60000);
  const refunded = new RegExp(`Refund\\s*\\$${run.refund.amount.replace('.', '\\.')}`);
  // The payer page can lag PayPal's API by minutes (take v11: still unlisted after two); this wait is cut from the film.
  for (let i = 0; i < PAYPAL_REFUND_TRIES && !run.paypal_page; i++) {
    await paypalTab.goto(payer, { waitUntil: 'domcontentloaded', timeout: 60000 }); await paypalTab.waitForTimeout(8000);
    await paypalTab.getByText('Yes, I accept').click({ timeout: 3000 }).catch(() => {});
    const text = (await paypalTab.locator('body').innerText()).replace(/\s+/g, ' ');
    const badge = text.match(/Partially refunded|Refunded/)?.[0];
    if (badge && refunded.test(text)) run.paypal_page = { badge, activity: text.match(/Payment activity.*?Refund\s*\$\d+\.\d{2}/)?.[0] ?? null };
  }
  if (!run.paypal_page) throw new Error('PayPal\'s invoice page did not list the refund');
  await paypalTab.evaluate(z => { document.documentElement.style.zoom = String(z); }, PAYPAL_ZOOM);
  await paypalTab.waitForTimeout(800);
  uncut();
  await mark(17); show(paypalTab); await maskLocalLink(paypalTab);
  await paypalTab.waitForTimeout(PAYPAL_HOLD_MS * 2);

  step = 'limits'; await mark(18);
  show(proofTab);
  await into(proofTab, '.limit-note'); await look(proofTab, 'limits', '.limit-note');
  await proofTab.waitForTimeout(Math.max(0, END - now()) * 1000);
} catch (error) { failed = true; console.error(`${step}: ${error.message}`); process.exitCode = 1; }

uncut();
const end = Number(now().toFixed(2)), wallEnd = seconds();
const pages = [...new Set(switches.map(([, p]) => p))];
const videos = pages.map(p => p.video());
await context.close();
await browser.close();
if (!failed) {
  // Each switch runs to the next one; cut ranges are removed from inside those spans.
  const spans = switches.map(([from, p], i) => [from, switches[i + 1]?.[0] ?? wallEnd, p]);
  const pieces = [];
  for (const [from, to, p] of spans) {
    let at = from;
    for (const [a, b] of skips.filter(([a, b]) => b > from && a < to).sort((x, y) => x[0] - y[0])) { if (a > at) pieces.push([at, a, p]); at = Math.max(at, b); }
    if (to - at > 0.04) pieces.push([at, to, p]);
  }
  const paths = await Promise.all(videos.map(v => v.path()));
  // Each piece is [input, from, to] in that tab's own seconds; splice.json lets a failed splice be redone without a new take.
  const plan = pieces.map(([a, b, p]) => { const shift = opened.get(p) ?? 0; return [pages.indexOf(p), Number((a - shift).toFixed(2)), Number((b - shift).toFixed(2))]; });
  await writeFile(join(out, 'marks.json'), JSON.stringify({ case: CASE, story: 'refund', recorded_at: new Date(started).toISOString(), ...run, keep_reason: KEEP_REASON, question: QUESTION, skips: skips.map(([a, b]) => [Number(a.toFixed(2)), Number(b.toFixed(2))]), pieces: pieces.length, marks, looks, views, moves, masks, end }, null, 2) + '\n');
  const painted = pages.map(p => sizes.get(p) ?? null);
  await writeFile(join(out, 'splice.json'), JSON.stringify({ inputs: paths.map((path, i) => ({ file: path.split('/').pop(), size: painted[i] })), pieces: plan }, null, 1) + '\n');
  splice(out, paths, plan, painted);
  console.log(`recorded ${end} s (cut ${cutSoFar().toFixed(1)} s) · invoice …${run.invoice_id_tail} · paid USD ${run.paid?.value} · refunded USD ${run.refund?.amount} for ${run.refund?.ref} (${run.refund?.status})`);
}
