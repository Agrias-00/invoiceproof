// The client's view of one invoice: each line beside the quotes behind it, the AI review and any reason the
// freelancer gave to keep a disputed line, a live comparison with the invoice PayPal holds, and a way to ask about a line.

/** Money in cents from PayPal's read-back and the refunds this app confirmed. Refunded is PayPal's own total (which
 *  includes refunds made elsewhere in PayPal) plus each confirmed refund whose id PayPal's invoice does not list yet,
 *  so nothing is counted twice or missed. `lag` is true while PayPal's invoice still trails a confirmed refund. */
function proofMoney(paypal, refunds) {
  const cents = value => Math.round(Number(value || 0) * 100);
  const listed = new Set(paypal.refund_ids || []);
  const trailing = (refunds || []).filter(r => !listed.has(r.refund_id));
  const refunded = cents(paypal.refunded) + trailing.reduce((sum, r) => sum + cents(r.amount), 0);
  return { paid: cents(paypal.paid), refunded, kept: cents(paypal.paid) - refunded, lag: trailing.length > 0 };
}
if (typeof module !== 'undefined') module.exports = { proofMoney };

if (globalThis.document && globalThis.fetch) {
  (() => {
    const $ = id => document.getElementById(id);
    const token = location.pathname.split('/').pop();
    const api = `/api/proof/${token}`;
    const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
    async function load() {
      const response = await fetch(api);
      if (!response.ok) { $('proof-title').textContent = 'This proof is not available.'; $('paypal-check').hidden = true; $('proof-intro').textContent = 'The link may have been revoked.'; return null; }
      return response.json();
    }
    const amountOf = line => (Number(line.quantity) * Number(line.rate)).toFixed(2);
    /** What sets a line apart for the client: the AI dispute, their own question, and a refund (confirmed or pending). */
    function tagsOf(proof, line) {
      const tags = [];
      if (line.review.verdict === 'disputes') tags.push({ kind: 'disputed', text: 'AI review disputes' });
      if (proof.questions.some(q => q.ref === line.ref)) tags.push({ kind: 'asked', text: 'You asked' });
      for (const r of (proof.refunds || []).filter(r => r.ref === line.ref)) tags.push({ kind: 'refunded', text: `Refunded USD ${r.amount}` });
      if (proof.refund_pending === line.ref) tags.push({ kind: 'pending', text: 'Refund being confirmed' });
      return tags;
    }
    /** The money first: invoice total, what PayPal records as paid and refunded, and the lines in question. */
    function renderSummary(proof, total, money) {
      const p = proof.paypal, figures = $('summary-figures'); figures.replaceChildren();
      const figure = (label, value, cls = '') => { const box = el('div', `figure ${cls}`); box.append(el('dt', '', label), el('dd', '', value)); figures.append(box); };
      const usd = c => `USD ${(c / 100).toFixed(2)}`;
      figure('Invoice total', `USD ${total.toFixed(2)}`);
      if (p.paid) figure('Paid through PayPal', `USD ${p.paid}`, 'ok');
      if (money.refunded) figure('Refunded to you', usd(money.refunded), 'refunded');
      if (p.paid && money.refunded) figure('Kept by the freelancer', usd(money.kept));
      const attention = $('attention'); attention.replaceChildren();
      for (const line of proof.lines) {
        const tags = tagsOf(proof, line); if (!tags.length) continue;
        const item = el('li'), link = el('a', '', `${line.ref} · ${line.description}`); link.href = `#line-${line.ref}`;
        item.append(link, el('span', 'amount', `USD ${amountOf(line)}`));
        for (const t of tags) item.append(el('span', `tag ${t.kind}`, t.text));
        attention.append(item);
      }
      $('attention-pane').hidden = attention.childElementCount === 0;
      $('proof-summary').hidden = false;
    }
    function render(proof) {
      const total = proof.lines.reduce((sum, l) => sum + Number(l.quantity) * Number(l.rate), 0);
      $('proof-title').textContent = `Invoice ${proof.invoice_number}: ${proof.lines.length} lines, USD ${total.toFixed(2)}`;
      $('proof-intro').textContent = 'Each line was drafted by an AI from the freelancer’s work log and price list, kept only because its quantity and rate appear in the quoted words, checked for meaning by a second AI model, and approved by the freelancer. The quotes show where each line came from, not that the work was done.';
      const check = $('paypal-check'), p = proof.paypal;
      check.className = `banner ${p.state === 'match' ? 'match' : p.state === 'changed' ? 'changed' : 'unknown'}`;
      check.replaceChildren();
      if (p.state === 'match') check.append(`✓ The invoice in PayPal matches this proof (status ${p.status}, read ${new Date(p.read_at).toLocaleString()}).`);
      else if (p.state === 'changed') {
        check.append('⚠ The invoice in PayPal has changed since this proof was made:');
        const ul = el('ul'); for (const d of p.differences) ul.append(el('li', 'diff', `${d.ref} ${d.field}: proof ${d.expected}, PayPal now ${d.actual}`)); check.append(ul);
      } else check.append('Could not check PayPal just now. This is not a match and not a change.');
      // PayPal's own figures for the money: what the client paid and what was given back.
      const refunds = proof.refunds || [];
      // PayPal confirms a refund at once but shows it on the invoice about half a minute later; both are said plainly.
      const money = proofMoney(p, refunds);
      const lag = money.lag ? ' The refund below is confirmed by PayPal and appears on the invoice within a minute.' : '';
      if (p.paid) check.append(el('p', 'fine', `PayPal records a payment of USD ${p.paid}${p.refunded ? ` and refunds of USD ${p.refunded}` : ''}.${lag}`));
      renderSummary(proof, total, money);
      const list = $('proof-lines'); list.replaceChildren();
      for (const line of proof.lines) {
        const tags = tagsOf(proof, line);
        const card = el('article', `proof-line${tags.some(t => t.kind === 'refunded') ? ' refunded' : tags.length ? ' flagged' : ''}`); card.id = `line-${line.ref}`;
        const h = el('h3'); h.append(el('span', '', `${line.ref} · ${line.description}`), el('span', '', `${line.quantity} × USD ${line.rate} = USD ${amountOf(line)}`));
        card.append(h);
        if (tags.length) { const row = el('p', 'tags'); for (const t of tags) row.append(el('span', `tag ${t.kind}`, t.text)); card.append(row); }
        const quotes = el('div', 'quotes');
        for (const [label, text] of [['Work', line.work_quote], ['Price', line.price_quote]]) { const p2 = el('p', 'quote'); p2.append(el('b', '', label), ' ', el('q', '', text)); quotes.append(p2); }
        card.append(quotes);
        // An agreeing review is folded so the lines in question stand out; a dispute is always shown in full.
        if (line.review.verdict === 'supports') {
          const fold = el('details', 'review-note ok'); fold.append(el('summary', '', 'AI review agrees'), el('p', 'fold-text', line.review.reason)); card.append(fold);
        } else card.append(el('p', 'review-note warn', `AI review ${line.review.verdict === 'disputes' ? 'disputes this line' : 'did not review this line'}: ${line.review.reason}`));
        if (line.override) card.append(el('p', 'review-note warn', `Kept by the freelancer because: ${line.override}`));
        for (const r of refunds.filter(r => r.ref === line.ref)) {
          const note = el('p', 'review-note ok', `Refunded USD ${r.amount} to your PayPal payment on ${new Date(r.at).toLocaleString()} (PayPal refund ${r.refund_id}, ${r.status}). Reason: ${r.reason}`);
          note.id = `refund-${line.ref}`; card.append(note);
        }
        if (proof.refund_pending === line.ref) card.append(el('p', 'review-note warn', 'A refund of this line is being confirmed with PayPal.'));
        const asked = proof.questions.filter(q => q.ref === line.ref);
        for (const q of asked) {
          card.append(el('p', 'fine', `You asked: ${q.note}`));
          if (q.answer) {
            card.append(el('p', 'answer', `The freelancer replied: ${q.answer.text}`));
            if (q.answer.quote) { const src = el('p', 'quote'); src.append(el('b', '', 'Source'), ' ', el('q', '', q.answer.quote)); card.append(src); }
          }
        }
        const form = el('div', 'actions');
        const label = el('label', 'visually-hidden', `Question about ${line.ref}`); label.htmlFor = `ask-${line.ref}`;
        const input = el('input'); input.id = `ask-${line.ref}`; input.maxLength = 300; input.placeholder = 'Ask about this line';
        const button = el('button', 'ghost small', 'Question this line'); button.type = 'button'; button.id = `ask-send-${line.ref}`;
        button.addEventListener('click', async () => {
          const note = input.value.trim(); if (!note) { input.focus(); return; }
          const response = await fetch(`${api}/question`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: line.ref, note }) });
          if (!response.ok) { $('proof-error').textContent = 'The question could not be saved.'; return; }
          render({ ...proof, questions: (await response.json()).questions });
        });
        form.append(label, input, button); card.append(form);
        list.append(card);
      }
      // Each correction: which line, what it was, what it became, the reason, both totals, and the question it answered.
      const revisions = proof.revisions || [];
      $('revisions-pane').hidden = revisions.length === 0;
      const history = $('revisions'); history.replaceChildren();
      for (const r of revisions) {
        const li = el('li', 'revision'); li.id = `revision-${r.version}`;
        const was = `${r.before.quantity} × USD ${r.before.rate}`;
        const what = r.after ? `${r.ref} · ${r.before.description}: ${was} → ${r.after.quantity} × USD ${r.after.rate}` : `${r.ref} · ${r.before.description} (${was}) removed`;
        li.append(el('p', 'rev-head', `Version ${r.version - 1} → ${r.version}: ${what}`), el('p', 'rev-total', `Total USD ${r.total_before} → USD ${r.total_after}`), el('p', 'fine', `Reason: ${r.reason} · ${new Date(r.at).toLocaleString()}`));
        if (!r.after) for (const q of proof.questions.filter(q => q.ref === r.ref)) {
          li.append(el('p', 'fine', `You asked: ${q.note}`));
          if (q.answer) li.append(el('p', 'answer', `The freelancer replied: ${q.answer.text}`));
        }
        li.append(el('p', 'fine mono', `Fingerprint ${r.fingerprint_before.slice(0, 16)} → ${r.fingerprint_after.slice(0, 16)}`));
        history.append(li);
      }
      if (revisions.length) $('proof-title').textContent += ` · version ${revisions.length + 1}`;
      $('fingerprint').textContent = `Fingerprint (SHA-256): ${proof.fingerprint}\nCreated: ${proof.created_at}${revisions.length ? `\nVersion ${revisions.length + 1}, corrected ${revisions[revisions.length - 1].at}` : ''}`;
      if (p.payer_view_url) { const link = $('payer-link'); link.href = p.payer_view_url; link.hidden = false; }
    }
    load().then(proof => { if (proof) render(proof); }).catch(() => { $('proof-error').textContent = 'The proof could not be loaded.'; });
  })();
}
