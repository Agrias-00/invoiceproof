// InvoiceProof product page: draft lines from a work log, check their quotes, read the AI review, approve,
// create and send the PayPal invoice, and follow the client's proof page. The offline failure-case lab is /lab.
if (globalThis.document && globalThis.fetch && document.querySelector('.workspace')) {
  (() => {
    const $ = id => document.getElementById(id);
    let rows = [];            // results from the server, each with its AI review and the person's tick and override
    let draftId = null;       // the server's id for the draft the rows came from; an approval names it
    let textVersion = 0;      // bumps whenever the pasted text changes or a draft is requested
    let drafting = false;
    let proofPath = null, pollTimer = null;
    const TEXT_CHANGED = 'The text changed. Draft the lines again.';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const reasons = { MALFORMED_LINE: 'The line is malformed.', EMPTY_QUOTE: 'No quote supports it.', WORK_QUOTE_NOT_FOUND: 'The work quote is not in the work log.', PRICE_QUOTE_NOT_FOUND: 'The price quote is not in the price list.', QUANTITY_NOT_IN_WORK_QUOTE: 'The quantity is not in the work quote.', RATE_NOT_IN_PRICE_QUOTE: 'The rate is not in the price quote.', QUOTE_SPANS_LINES: 'A quote runs across more than one line.', WORK_QUOTE_REUSED: 'Another line already bills these words of the work log.', ORIGINAL_LINE_NOT_ACCEPTED: 'This line was not originally accepted.' };
    const errors = { INVOICE_NOT_REVISABLE: 'PayPal shows a payment on this invoice, so it can no longer be corrected in place.', PAYPAL_UPDATE_REFUSED: 'PayPal refused the correction. The proof was not changed.', LAST_LINE: 'The only line cannot be removed. Revoke the proof and cancel the invoice in PayPal instead.', QUOTE_CHECK_FAILED: 'The new quantity or rate is not in the line’s quotes.', REVISION_IN_PROGRESS: 'Another correction to this invoice is still running.', INVOICE_CHANGED_ELSEWHERE: 'The invoice was changed in PayPal since approval. Nothing was overwritten; check the proof page.', PAYPAL_UPDATE_UNCONFIRMED: 'PayPal did not confirm the correction. It is settled from PayPal on the next read; check the proof page.', REVISION_UNCONFIRMED: 'An earlier correction is not confirmed by PayPal yet. Try again shortly.', MODEL_NOT_CONFIGURED: 'No model key is set. The two examples work without one; your own text needs OPENROUTER_API_KEY.', MODEL_REPLY_INVALID: 'The model reply could not be read. Try again.', MODEL_REQUEST_FAILED: 'The model request failed. Try again.', LINES_NOT_REVIEWED: 'Compare every line with its quotes and tick it before approving.', DRAFT_OUT_OF_DATE: 'These lines are from an older draft. Draft the lines again.', REVIEW_OVERRIDE_REQUIRED: 'The AI review disputes a line. Remove it, or write why you keep it.', ALREADY_INVOICED: 'A line bills work that is already on an invoice. Remove it, or write why you bill it again.', REFUND_NEEDS_PAYPAL: 'Refunds need the PayPal sandbox; the offline mock has no payment to refund.', ALREADY_REFUNDED: 'This line was already refunded.', INVOICE_NOT_PAID: 'PayPal shows no payment on this invoice yet. Correct it in place instead.', PAYMENT_NOT_REFUNDABLE: 'This invoice was not paid in one PayPal payment, so it cannot be refunded from here. Refund it in PayPal.', REFUND_EXCEEDS_PAID: 'The line is more than what is left of the payment.', PAYPAL_REFUND_REFUSED: 'PayPal refused the refund. Nothing was refunded and the proof was not changed.', PAYPAL_REFUND_PENDING: 'PayPal accepted the refund but has not completed it. Press refund again later to read its status; the client sees it only once completed.', PAYPAL_REFUND_UNCONFIRMED: 'PayPal did not confirm the refund. Press refund again: the same request is resent, and PayPal answers it with the refund it already made instead of a second one.', REFUND_UNCONFIRMED: 'An earlier refund is not confirmed by PayPal yet. Press its refund button again to confirm it.' };
    async function request(path, payload) {
      const response = await fetch(path, payload === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) { const error = new Error(data.errorCode || data.error || 'Request failed.'); error.data = data; throw error; }
      return data;
    }
    function message(text) { $('flow-status').textContent = text; $('flow-error').textContent = ''; }
    function fail(code) { $('flow-error').textContent = errors[code] || code; }
    function step(name) {
      const order = ['sources', 'review', 'paypal'];
      order.forEach((id, i) => { const li = $(`step-${id}`); li.classList.toggle('on', id === name); li.classList.toggle('done', i < order.indexOf(name)); });
    }
    const amountOf = line => { const value = Number(line.quantity) * Number(line.rate); return Number.isFinite(value) ? value : null; };
    const accepted = () => rows.filter(row => row.status === 'accepted');
    // A disputed line, and a work-log line already on a live invoice, are kept only with a reason the client sees.
    const needsReason = row => (row.review && row.review.verdict !== 'supports') || !!row.billed;
    function updateTotal() {
      const lines = accepted(), compared = lines.filter(row => row.reviewed).length, total = lines.reduce((sum, row) => sum + (amountOf(row.line) ?? 0), 0);
      $('flow-total').textContent = lines.length ? `${lines.length} lines · USD ${total.toFixed(2)} · ${compared} of ${lines.length} compared` : 'No lines yet.';
    }

    /** The two source texts in reading mode, each quote marked with the line that uses it. */
    function renderSources() {
      for (const [field, target, key, offset] of [['work-log', 'read-log', 'work_quote', 'work_offset'], ['price-list', 'read-prices', 'price_quote', 'price_offset']]) {
        const text = $(field).value, spans = [];
        rows.forEach(row => {
          const quote = typeof row.line?.[key] === 'string' ? row.line[key] : '';
          if (!quote) return;
          const at = Number.isInteger(row[offset]) ? row[offset] : text.indexOf(quote);
          if (at >= 0) spans.push({ at, end: at + quote.length, ref: row.ref });
        });
        spans.sort((a, b) => a.at - b.at);
        const pre = $(target); pre.replaceChildren();
        let cursor = 0;
        for (const span of spans) {
          if (span.at < cursor) { const sup = [...pre.querySelectorAll('mark')].pop()?.querySelector('sup'); if (sup) sup.textContent += ` ${span.ref}`; continue; }  // a price quote shared by two lines is marked once
          pre.append(text.slice(cursor, span.at));
          const mark = document.createElement('mark'); mark.dataset.ref = span.ref; mark.textContent = text.slice(span.at, span.end);
          const sup = document.createElement('sup'); sup.textContent = span.ref; mark.append(sup); pre.append(mark);
          cursor = span.end;
        }
        pre.append(text.slice(cursor));
      }
      $('source-edit').hidden = rows.length > 0; $('source-read').hidden = rows.length === 0;
    }
    function highlight(ref) {
      if (ref === threadRef && thread) return;
      document.querySelectorAll('.source-text mark').forEach(mark => mark.classList.toggle('on', mark.dataset.ref.split(' ').includes(ref) || (mark.querySelector('sup')?.textContent.split(' ').includes(ref) ?? false)));
      document.querySelectorAll('.card').forEach(card => card.classList.toggle('focus', card.dataset.ref === ref));
      drawThread(ref, true);
    }
    /** The proof thread: a curve from the focused line card to each source passage it quotes. Side-by-side layout only. */
    let thread = null, threadRef = null;
    function drawThread(ref, animate) {
      thread?.remove(); thread = null; threadRef = ref;
      const card = ref && document.querySelector(`.card[data-ref="${ref}"]`);
      if (!card || matchMedia('(max-width: 900px)').matches) return;
      // Rects are in viewport pixels; the overlay sits inside any CSS zoom on the page, so it draws in unzoomed units.
      const z = document.documentElement.currentCSSZoom || 1;
      const box = card.getBoundingClientRect(), x2 = box.left / z, y2 = (box.top + 26 * z) / z;
      if (box.top < 0 || box.top > innerHeight) return;
      const svg = document.createElementNS(SVG_NS, 'svg'); svg.setAttribute('class', `thread${animate ? '' : ' static'}`); svg.setAttribute('aria-hidden', 'true');
      document.body.append(svg); thread = svg;
      for (const mark of document.querySelectorAll('.source-text mark.on')) {
        const rects = mark.getClientRects(), end = rects[rects.length - 1]; if (!end) continue;
        const x1 = end.right / z + 2, y1 = (end.top + end.height / 2) / z; if (y1 < 0 || y1 * z > innerHeight || x1 >= x2) continue;
        const bend = Math.max(36, (x2 - x1) / 2), path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`); svg.append(path);
        path.style.setProperty('--len', String(Math.ceil(path.getTotalLength())));
        for (const [cx, cy] of [[x1, y1], [x2, y2]]) { const dot = document.createElementNS(SVG_NS, 'circle'); dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('r', 3.5); svg.append(dot); }
      }
    }
    let threadFrame = 0;
    const followThread = () => { cancelAnimationFrame(threadFrame); threadFrame = requestAnimationFrame(() => { if (thread) drawThread(threadRef, false); }); };
    addEventListener('scroll', followThread, { passive: true }); addEventListener('resize', followThread);
    function chip(text, kind) { const span = document.createElement('span'); span.className = `chip ${kind}`; span.textContent = text; return span; }
    function quote(label, text, found) {
      const p = document.createElement('p'); p.className = `quote${found ? '' : ' missing'}`;
      const b = document.createElement('b'); b.textContent = label; const q = document.createElement('q'); q.textContent = text || 'no quote';
      p.append(b, ' ', q); return p;
    }
    function field(labelText, id, value, onInput, wide) {
      const wrap = document.createElement('div'); const label = document.createElement('label'); label.htmlFor = id; label.textContent = labelText;
      const input = document.createElement('input'); input.id = id; input.value = value; if (!wide) input.inputMode = 'decimal';
      input.addEventListener('input', () => onInput(input.value)); wrap.append(label, input); return wrap;
    }

    function render() {
      const list = $('flow-results'); list.replaceChildren(); thread?.remove(); thread = null; threadRef = null;
      rows.forEach((row, index) => {
        const line = row.line || {}, ok = row.status === 'accepted', disputed = ok && needsReason(row);
        const card = document.createElement('article'); card.className = `card${ok ? '' : ' blocked'}${disputed ? ' disputed' : ''}`; card.dataset.ref = row.ref; card.tabIndex = -1;
        card.setAttribute('aria-label', `Line ${row.ref}`);
        card.addEventListener('focusin', () => highlight(row.ref)); card.addEventListener('mouseenter', () => highlight(row.ref));
        const head = document.createElement('div'); head.className = 'card-head';
        const ref = document.createElement('span'); ref.className = 'ref'; ref.textContent = row.ref; head.append(ref);
        if (!ok) head.append(chip(`Blocked · ${reasons[row.reason] || 'The line could not be accepted.'}`, 'bad'));
        else {
          head.append(chip('Quotes match', 'ok'));
          if (row.review?.verdict === 'supports') head.append(chip('AI review agrees', 'ok'));
          else if (row.review?.verdict === 'disputes') head.append(chip('AI review disputes', 'warn'));
          else head.append(chip('Not reviewed by AI', 'warn'));
          if (row.billed) head.append(chip(`Already on invoice ${row.billed.invoice_number}`, 'warn'));
        }
        card.append(head);
        const amount = document.createElement('div'); amount.className = 'amount'; amount.textContent = `USD ${amountOf(line)?.toFixed(2) ?? '—'}`;
        if (ok) {
          // An edited line has not been compared yet: the edit clears its tick.
          // An edited line is reviewed again by the AI when you approve; the earlier verdict was about other words.
          const edit = key => value => { line[key] = value; amount.textContent = `USD ${amountOf(line)?.toFixed(2) ?? '—'}`; row.reviewed = false; tick.checked = false; editedNote.hidden = false; updateTotal(); };
          var editedNote = document.createElement('p'); editedNote.className = 'fine edited-note'; editedNote.hidden = true; editedNote.textContent = 'Edited. The AI reviews this line again when you approve.';
          const fields = document.createElement('div'); fields.className = 'card-fields';
          fields.append(field('Description', `description-${index}`, line.description ?? '', edit('description'), true), field('Quantity', `quantity-${index}`, line.quantity ?? '', edit('quantity')), field('Rate (USD)', `rate-${index}`, line.rate ?? '', edit('rate')), amount);
          card.append(fields, editedNote);
        } else {
          const p = document.createElement('p'); p.className = 'blocked-line'; p.append(`${line.description || 'Untitled line'} · ${line.quantity ?? '?'} × ${line.rate ?? '?'} = `); p.append(amount.textContent); card.append(p);
        }
        const quotes = document.createElement('div'); quotes.className = 'quotes';
        quotes.append(quote('Work', line.work_quote, ok || !!line.work_quote && $('work-log').value.includes(line.work_quote)), quote('Price', line.price_quote, ok || !!line.price_quote && $('price-list').value.includes(line.price_quote)));
        card.append(quotes);
        if (ok && row.review) {
          const note = document.createElement('p'); note.className = `review-note ${row.review.verdict === 'supports' ? 'ok' : 'warn'}`;
          note.textContent = `AI review: ${row.review.reason}`; card.append(note);
        }
        if (ok && row.billed) {
          const note = document.createElement('p'); note.className = 'review-note warn';
          note.textContent = `This work-log line is already billed as ${row.billed.ref} on invoice ${row.billed.invoice_number}. Billing it again creates a second charge for the same work.`; card.append(note);
        }
        var tick = document.createElement('input');
        if (ok) {
          if (disputed) {
            const box = document.createElement('div'); box.className = 'override';
            const label = document.createElement('label'); label.htmlFor = `override-${index}`; label.textContent = 'Keep this line anyway? Say why. The client sees this reason.';
            const area = document.createElement('textarea'); area.id = `override-${index}`; area.rows = 2; area.maxLength = 200; area.value = row.override || '';
            area.addEventListener('input', () => { row.override = area.value; });
            box.append(label, area); card.append(box);
          }
          const foot = document.createElement('div'); foot.className = 'card-foot';
          tick.type = 'checkbox'; tick.id = `reviewed-${index}`; tick.checked = row.reviewed === true;
          tick.addEventListener('change', () => { row.reviewed = tick.checked; updateTotal(); });
          const label = document.createElement('label'); label.className = 'reviewed'; label.append(tick, ' I compared this line with its quotes');
          const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'ghost small'; remove.textContent = 'Remove line'; remove.setAttribute('aria-label', `Remove line ${row.ref}`);
          remove.addEventListener('click', () => { rows.splice(index, 1); render(); message(`Line ${row.ref} removed.`); });
          foot.append(label, remove); card.append(foot);
        }
        list.append(card);
      });
      renderSources(); updateTotal();
    }
    /** The drafted lines and their ticks belong to the text they were drafted from: once that text changes they are dropped. */
    function dropLines(text) {
      textVersion++; rows = []; draftId = null; render(); $('flow-source').textContent = ''; $('flow-source').removeAttribute('title');
      $('paypal-pane').hidden = true; stopPolling(); step('sources'); message(text);
    }
    for (const id of ['work-log', 'price-list']) $(id).addEventListener('input', () => { if (rows.length || drafting) dropLines(TEXT_CHANGED); else textVersion++; drafting = false; });
    for (const id of ['clean', 'tempting']) $(`example-${id}`).addEventListener('click', async () => {
      try { const cases = await request('/api/demo-cases'); const example = cases.find(item => item.id === id); $('work-log').value = example.log; $('price-list').value = example.prices; dropLines('Example loaded. Draft the lines.'); }
      catch (error) { fail(error.message); }
    });
    $('edit-sources').addEventListener('click', () => { $('source-edit').hidden = false; $('source-read').hidden = true; $('work-log').focus(); });
    $('draft-lines').addEventListener('click', async () => {
      const asked = ++textVersion;     // a second press also makes the first reply out of date
      const current = () => asked === textVersion;
      try {
        drafting = true; message('The AI is drafting lines, the app is checking every quote, and a second AI is reviewing them…'); $('draft-lines').disabled = true;
        const data = await request('/api/draft', { log: $('work-log').value, prices: $('price-list').value });
        if (!current()) return;        // a reply for text that has changed since the request is not shown
        drafting = false;
        let reviewIndex = 0;
        rows = data.results.map((result, i) => { const at = result.status === 'accepted' ? reviewIndex++ : -1; return { ...result, ref: `L${i + 1}`, origin: at, review: at >= 0 ? data.reviews?.[at] ?? null : null, billed: at >= 0 ? data.billed?.[at] ?? null : null, reviewed: false, override: '' }; });
        draftId = data.draft_id; $('paypal-pane').hidden = true; stopPolling(); render(); step('review');
        const blocked = rows.filter(row => row.status !== 'accepted').length, disputed = accepted().filter(needsReason).length;
        message(`${rows.length} lines drafted. ${blocked} blocked by the quote check, ${disputed} disputed by the AI review. Compare each kept line with its quotes.`);
        const source = $('flow-source'); source.title = [data.model, data.review_model].filter(Boolean).join(' · ');
        source.textContent = data.recorded_at ? `Recorded model replies from ${data.recorded_at}: no model key is set, so no model was called now. The quote check ran now.` : 'Drafted and reviewed just now by two live AI model calls.';
      } catch (error) { if (current()) { drafting = false; fail(error.message); } }
      finally { $('draft-lines').disabled = false; }
    });
    $('flow-approve').addEventListener('click', async () => {
      const lines = accepted();
      if (!lines.length) { fail('Draft the lines first.'); return; }
      const missing = lines.find(row => !row.reviewed);
      if (missing) { fail('LINES_NOT_REVIEWED'); $(`reviewed-${rows.indexOf(missing)}`).focus(); return; }
      const unexplained = lines.find(row => needsReason(row) && !(row.override || '').trim());
      if (unexplained) { fail('REVIEW_OVERRIDE_REQUIRED'); $(`override-${rows.indexOf(unexplained)}`).focus(); return; }
      try {
        message('Creating the invoice in PayPal and reading it back…'); $('flow-approve').disabled = true;
        const data = await request('/api/flow-approve', { draft: draftId, lines: lines.map(row => row.line), origins: lines.map(row => row.origin), reviewed: lines.map(() => true), overrides: lines.map(row => needsReason(row) ? row.override.trim() : null) });
        // The total and the number are PayPal's own values from the read; the offline mock returns neither.
        $('flow-read').textContent = [`Invoice id: ${data.invoice_id}`, `Status: ${data.status}`, data.read_number && `Invoice number: ${data.read_number}`, data.read_total && `Total held by PayPal: ${data.read_total}`, `Fingerprint: ${(data.fingerprint || '').slice(0, 16)}`, `Read at: ${data.read_at}`, data.mode === 'sandbox' ? 'Mode: PayPal sandbox' : 'Mode: offline mock, no PayPal credentials'].filter(Boolean).join('\n');
        $('tl-draft').classList.add('done'); $('tl-draft-text').textContent = `${data.read_number || data.invoice_number} · ${data.status}`;
        proofPath = data.proof_path; reopenedToken = null; shownQuestions = ''; answering = false;
        const proofLink = $('proof-link'); if (proofPath) { proofLink.href = proofPath; proofLink.hidden = false; $('flow-revoke').hidden = false; }
        $('flow-send').hidden = false; $('flow-send').disabled = false; $('flow-send').textContent = 'Send through PayPal'; loadHistory();
        $('paypal-pane').hidden = false; step('paypal'); $('paypal-title').focus();
        message('Invoice created in PayPal as a draft. Send it when you are ready.');
        startPolling();
      } catch (error) {
        if (error.message === 'DRAFT_OUT_OF_DATE') { rows = []; draftId = null; render(); }
        // The server reviewed edited lines again: show the new verdicts and ask for a reason where one is disputed.
        if (error.message === 'REVIEW_OVERRIDE_REQUIRED' && Array.isArray(error.data?.reviews)) {
          error.data.reviews.forEach((review, i) => { if (lines[i]) lines[i].review = review; });
          render(); const first = lines[error.data.indexes?.[0]]; fail(error.message); if (first) $(`override-${rows.indexOf(first)}`)?.focus(); return;
        }
        fail(error.message);
      }
      finally { $('flow-approve').disabled = false; }
    });
    $('flow-send').addEventListener('click', async () => {
      try {
        message('Sending through PayPal…'); $('flow-send').disabled = true;
        const data = await request('/api/flow-send', reopenedToken ? { proof: reopenedToken } : { draft: draftId });
        $('tl-sent').classList.add('done'); $('tl-sent-text').textContent = `Status ${data.status}${data.read_total ? ` · ${data.read_total}` : ''}`;
        // The read-back shows PayPal's current status; the status before sending stays visible as history.
        $('flow-read').textContent = $('flow-read').textContent.replace(/^Status: .*$/m, `Status: ${data.status} (read at ${data.read_at}; was DRAFT before sending)`);
        $('flow-send').textContent = 'Sent through PayPal'; loadHistory();
        if (data.payer_view_url) { const link = $('payer-link'); link.href = data.payer_view_url; link.hidden = false; }
        if (data.qr_path) { $('qr').src = data.qr_path; $('qr-box').hidden = false; }
        message(data.mode === 'sandbox' ? 'Sent. The PayPal invoice shows each line with its quotes, and its note links to the proof page.' : 'Marked as sent in the offline mock.');
      } catch (error) { $('flow-send').disabled = false; fail(error.message); }
    });
    /** The freelancer sees the client's questions and whether PayPal still matches the proof. */
    let shownQuestions = '', answering = false, reopenedToken = null;
    /** What PayPal reports for the open proof: whether the client paid, and which lines were refunded. */
    let money = { paid: false, refunded: new Map() };
    const recovered = new Map();                    // proof + ref -> whether the lost reply was the simulated one, for refunds that landed on a retry this session
    const api = () => proofPath.replace('/proof/', '/api/proof/');
    /** One question, its published answer, or the answer agent's draft for the freelancer to edit and publish. */
    /**
     * Corrects the sent invoice when the client is right: remove the line, or change its quantity or rate to numbers
     * its quotes still show. PayPal's invoice is updated in place under the same number; the proof keeps both versions.
     */
    function reviseControls(q, index, line, base, suggested) {
      const box = document.createElement('div'); box.className = 'revise';
      const reasonLabel = document.createElement('label'); reasonLabel.className = 'reason'; reasonLabel.textContent = 'Reason shown to the client';
      const reason = document.createElement('input'); reason.maxLength = 200; reason.value = `${money.paid ? 'Refunded' : 'Corrected'} after the client's question: ${q.note}`.slice(0, 200); reasonLabel.append(reason);
      // Once the client has paid, PayPal no longer edits the invoice: the line is given back as a refund of exactly its amount.
      // A refunded line keeps PayPal's own reply in the card the freelancer acted on: amount, refund id and status, and,
      // after a lost reply, that the retry got back the first refund rather than a second one.
      const refundedRows = r => {
        const row = document.createElement('p'); row.className = 'refund-done'; row.id = `refund-done-${index}`; row.setAttribute('role', 'status');
        row.textContent = `Refunded on PayPal: USD ${r.amount} for ${line.ref} · refund …${r.refund_id.slice(-4)} · ${r.status}`;
        // Only the simulated fault is known to have reached PayPal first; after a real lost reply the retry may be the request that made the refund.
        const how = recovered.get(`${base}#${line.ref}`);
        const again = how !== undefined && Object.assign(document.createElement('p'), { className: 'fine', textContent: how ? 'The retry resent the same PayPal-Request-Id, so PayPal returned the refund it had already made. Refunded once.' : 'The retry resent the same PayPal-Request-Id, so PayPal made one refund for this request, not two.' });
        return again ? [row, again] : [row];
      };
      const done = money.refunded.get(line.ref);
      if (done) { box.append(...refundedRows(done)); return box; }
      if (money.paid) {
        const amount = (Math.round(Number(line.quantity) * Number(line.rate) * 100) / 100).toFixed(2);
        const refund = document.createElement('button'); refund.type = 'button'; refund.className = suggested ? 'primary small' : 'ghost small'; refund.id = `revise-refund-${index}`;
        refund.textContent = `Refund ${line.ref} (USD ${amount}) on PayPal`;
        refund.addEventListener('click', async () => {
          if (!confirm(`Refund USD ${amount} for ${line.ref} (${line.description}) on the client's PayPal payment? This cannot be undone.`)) return;
          refund.disabled = true;
          try {
            const done = await request(`${base}/refund`, { ref: line.ref, reason: reason.value });
            const r = done.refunds[done.refunds.length - 1];
            const lostNote = box.querySelector('.refund-note');
            if (lostNote) recovered.set(`${base}#${r.ref}`, lostNote.textContent.startsWith('Simulated lost reply'));
            // The card shows PayPal's reply at once; the list itself is not rebuilt while a reply is being written.
            box.replaceChildren(...refundedRows(r));
            message(`PayPal refunded USD ${r.amount} for ${r.ref} (refund ${r.refund_id}, ${r.status}). The client sees it on the proof page.`);
            shownQuestions = ''; poll(); loadHistory();
          } catch (error) {
            refund.disabled = false; fail(error.message);
            // A lost reply leaves the refund staged with its request id; the retry button says that it resends the same request.
            if (error.message === 'PAYPAL_REFUND_UNCONFIRMED') {
              const text = `${error.data?.simulated ? 'Simulated lost reply: PayPal processed the refund, but its answer was dropped on purpose for this demo. ' : ''}${errors.PAYPAL_REFUND_UNCONFIRMED}`;
              $('flow-error').textContent = text;
              const note = box.querySelector('.refund-note') ?? Object.assign(document.createElement('p'), { className: 'review-note warn refund-note', role: 'status' });
              note.textContent = text; refund.after(note);
              refund.textContent = `Retry ${line.ref} refund (same PayPal-Request-Id)`;
            }
          }
        });
        box.append(reasonLabel, refund); return box;
      }
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = suggested ? 'primary small' : 'ghost small'; remove.id = `revise-remove-${index}`;
      remove.textContent = `Remove ${line.ref} from the PayPal invoice`;
      const qty = document.createElement('input'); qty.value = line.quantity; qty.inputMode = 'decimal';
      const qtyLabel = document.createElement('label'); qtyLabel.className = 'num'; qtyLabel.append(`Quantity (${line.ref})`, qty);
      const rate = document.createElement('input'); rate.value = line.rate; rate.inputMode = 'decimal';
      const rateLabel = document.createElement('label'); rateLabel.className = 'num'; rateLabel.append('Rate, USD', rate);
      const change = document.createElement('button'); change.type = 'button'; change.className = 'ghost small'; change.textContent = 'Change quantity or rate'; change.id = `revise-change-${index}`;
      async function send(payload, ask) {
        if (!confirm(ask)) return;
        remove.disabled = change.disabled = true;
        try {
          const revised = await request(`${base}/revise`, { ref: line.ref, reason: reason.value, ...payload });
          const r = revised.revisions[revised.revisions.length - 1];
          message(revised.mode === 'sandbox'
            ? `PayPal invoice corrected in place: USD ${r.total_before} → USD ${r.total_after}. The proof is now version ${r.version}${revised.paypal.state === 'match' ? ' and PayPal matches it.' : '.'}`
            : `Proof corrected in place (offline mock, no PayPal invoice): USD ${r.total_before} → USD ${r.total_after}, version ${r.version}.`);
          shownQuestions = ''; poll(); loadHistory();
        } catch (error) { remove.disabled = change.disabled = false; fail(error.message); }
      }
      remove.addEventListener('click', () => send({ action: 'remove', quantity: null, rate: null }, `Remove ${line.ref} (${line.description}) from the sent PayPal invoice? The client keeps the same link and sees both versions.`));
      change.addEventListener('click', () => send({ action: 'change', quantity: qty.value.trim(), rate: rate.value.trim() }, `Change ${line.ref} to ${qty.value} × USD ${rate.value} on the sent PayPal invoice?`));
      box.append(reasonLabel, remove, qtyLabel, rateLabel, change);
      return box;
    }
    function questionItem(q, index, lines) {
      const base = api();   // the reply belongs to this proof even if another invoice is opened meanwhile
      const li = document.createElement('li'); li.className = 'question';
      const asked = document.createElement('p'); asked.className = 'asked'; asked.textContent = `${q.ref}: ${q.note}`; li.append(asked);
      const line = lines.find(l => l.ref === q.ref);
      if (q.answer) {
        const a = document.createElement('p'); a.className = 'answer'; a.textContent = `Your answer: ${q.answer.text}`; li.append(a);
        if (q.answer.quote) li.append(quote('Source', q.answer.quote, true));
        // An answered question usually closes the matter; the correction stays one click away.
        // A refunded line shows PayPal's refund in the open card; only a correction still to make sits behind a toggle.
        if (line && money.refunded.has(line.ref)) li.append(reviseControls(q, index, line, base, false));
        else if (line) { const more = document.createElement('details'); more.append(Object.assign(document.createElement('summary'), { textContent: money.paid ? `Refund ${line.ref} on PayPal` : `Correct ${line.ref} on the PayPal invoice` }), reviseControls(q, index, line, base, false)); li.append(more); }
        else li.append(Object.assign(document.createElement('p'), { className: 'fine', textContent: `${q.ref} was removed from the invoice.` }));
        return li;
      }
      if (!line) { li.append(Object.assign(document.createElement('p'), { className: 'fine', textContent: `${q.ref} was removed from the invoice. Reply to close the question.` })); }
      const draft = document.createElement('button'); draft.type = 'button'; draft.className = 'small'; draft.id = `answer-draft-${index}`; draft.textContent = 'Draft a reply from the work log';
      draft.addEventListener('click', async () => {
        answering = true; draft.disabled = true; draft.textContent = 'Drafting from the work log and price list…';
        try {
          const drafted = await request(`${base}/answer-draft`, { index });
          const label = document.createElement('label'); label.htmlFor = `answer-${index}`; label.textContent = 'Reply to the client (edit before publishing)';
          const area = document.createElement('textarea'); area.id = `answer-${index}`; area.rows = 3; area.maxLength = 400; area.value = drafted.text;
          const source = drafted.quote ? quote('Source', drafted.quote, true) : Object.assign(document.createElement('p'), { className: 'review-note warn', textContent: 'The work log does not answer this. Add the missing detail yourself.' });
          // What the app's own checks found wrong comes first and apart from the model's advice: a real quote does not
          // make the rest of the reply true.
          const warnings = (drafted.warnings ?? []).map(text => Object.assign(document.createElement('p'), { className: 'review-note warn', textContent: `Fix before publishing: ${text}` }));
          const advice = drafted.note ? [Object.assign(document.createElement('p'), { className: 'review-note', textContent: `For you only, not sent: ${drafted.note}` })] : [];
          const note = document.createElement('p'); note.className = 'fine'; note.textContent = !drafted.model ? 'No model key: this draft is the line’s own work quote.' : drafted.quote ? 'Drafted by an AI from your two texts. The quote was found word for word in them; the rest of the reply is yours to check.' : 'Drafted by an AI from your two texts.';
          const publish = document.createElement('button'); publish.type = 'button'; publish.className = 'primary small'; publish.id = `answer-send-${index}`; publish.textContent = 'Publish the reply on the proof page';
          publish.addEventListener('click', async () => {
            try { await request(`${base}/answer`, { index, text: area.value, quote: drafted.quote, drafted_by: drafted.model }); answering = false; shownQuestions = ''; message('Reply published. The client sees it on the proof page.'); poll(); }
            catch (error) { fail(error.message); }
          });
          // When the work log does not support the line, the same correction is offered as the first choice.
          if (!drafted.quote) li.querySelector(`#revise-remove-${index}, #revise-refund-${index}`)?.classList.replace('ghost', 'primary');
          draft.replaceWith(label, area, source, ...warnings, ...advice, note, publish); area.focus();
        } catch (error) { answering = false; draft.disabled = false; draft.textContent = 'Draft a reply from the work log'; fail(error.message); }
      });
      li.append(draft);
      // The freelancer may simply agree with the client: the correction is offered before any reply.
      if (line) { const fix = reviseControls(q, index, line, base, false); fix.id = `revise-${index}`; li.append(fix); }
      return li;
    }
    async function poll() {
      if (!proofPath) return;
      try {
        const proof = await request(api());
        // The list is rebuilt only when the questions change, and never under a reply being written.
        const paid = ['PAID', 'PARTIALLY_REFUNDED'].includes(proof.paypal.status);
        const seen = JSON.stringify([proof.questions, proof.lines.map(l => [l.ref, l.quantity, l.rate]), paid, proof.refunds]);
        if (seen !== shownQuestions && !answering) {
          shownQuestions = seen; money = { paid, refunded: new Map((proof.refunds || []).map(r => [r.ref, r])) };
          const list = $('questions'); list.replaceChildren();
          if (!proof.questions.length) { const li = document.createElement('li'); li.className = 'fine'; li.textContent = 'None yet.'; list.append(li); }
          proof.questions.forEach((q, i) => list.append(questionItem(q, i, proof.lines)));
        }
        const state = { match: 'PayPal matches the proof.', changed: 'PayPal no longer matches the proof.', could_not_check: 'Could not check PayPal just now.' }[proof.paypal.state];
        const settled = proof.paypal.paid ? ` Paid USD ${proof.paypal.paid}${proof.paypal.refunded ? `, refunded USD ${proof.paypal.refunded}` : ''}.` : '';
        $('tl-client-text').textContent = `${state}${settled}${proof.questions.length ? ` ${proof.questions.length} question(s).` : ''}`;
        // The client step is done only once the client can see the invoice: after sending, while PayPal still matches.
        $('tl-client').classList.toggle('done', proof.sent && proof.paypal.state === 'match');
      } catch { /* the next poll tries again */ }
    }
    // Polling follows the current proof; a new draft forgets it (stopPolling), a new approval names it first.
    function startPolling() { if (pollTimer) clearInterval(pollTimer); poll(); pollTimer = setInterval(poll, 4000); }
    function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; proofPath = null; reopenedToken = null; shownQuestions = ''; answering = false; }
    $('flow-revoke').addEventListener('click', async () => {
      if (!proofPath || !confirm('Revoke the proof link? The client will no longer be able to open it. The PayPal invoice is not changed.')) return;
      try { await request(`${api()}/revoke`, {}); $('proof-link').hidden = true; $('flow-revoke').hidden = true; stopPolling(); $('tl-client-text').textContent = 'Proof link revoked.'; message('Proof link revoked. The PayPal invoice is unchanged.'); loadHistory(); }
      catch (error) { fail(error.message); }
    });
    /** Earlier invoices, so a reload never loses a proof or its questions. */
    async function loadHistory() {
      try {
        const { proofs } = await request('/api/proofs');
        const list = $('history'); list.replaceChildren(); $('history-pane').hidden = proofs.length === 0;
        for (const p of proofs) {
          const li = document.createElement('li');
          const text = document.createElement('span'); text.textContent = `${p.invoice_number} · ${p.lines} lines · USD ${p.total} · ${p.revoked ? 'link revoked' : p.sent ? 'sent' : 'draft'}${p.version > 1 ? ` · version ${p.version}` : ''}${p.unanswered ? ` · ${p.unanswered} unanswered` : ''}`;
          li.append(text);
          if (!p.revoked) {
            const open = document.createElement('button'); open.type = 'button'; open.className = 'ghost small'; open.textContent = 'Reopen'; open.setAttribute('aria-label', `Reopen ${p.invoice_number}`);
            open.addEventListener('click', () => reopen(p)); li.append(open);
          }
          list.append(li);
        }
      } catch { /* the list is a convenience; the flow works without it */ }
    }
    function reopen(p) {
      // A reply being written for another invoice is dropped: its editor is rebuilt for this proof.
      proofPath = `/proof/${p.token}`; reopenedToken = p.token; shownQuestions = ''; answering = false;
      $('flow-read').textContent = [`Invoice number: ${p.invoice_number}`, p.remote_id && `Invoice id: ${p.remote_id}`, `Reopened ${new Date().toLocaleString()}. PayPal is read again below.`].filter(Boolean).join('\n');
      $('tl-draft').classList.add('done'); $('tl-draft-text').textContent = p.invoice_number;
      $('tl-sent').classList.toggle('done', p.sent); $('tl-sent-text').textContent = p.sent ? 'Sent' : 'Not sent yet.';
      const send = $('flow-send'); send.hidden = false; send.disabled = p.sent; send.textContent = p.sent ? 'Sent through PayPal' : 'Send through PayPal';
      $('qr-box').hidden = true; $('payer-link').hidden = true;
      const link = $('proof-link'); link.href = proofPath; link.hidden = false; $('flow-revoke').hidden = false;
      $('paypal-pane').hidden = false; step('paypal'); $('paypal-title').focus(); startPolling();
    }
    loadHistory();
    $('flow-error').textContent = '';
  })();
}
