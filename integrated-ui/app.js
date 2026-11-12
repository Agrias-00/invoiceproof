(function (root) {
  'use strict';
  function mount(document, client) {
    const $ = id => document.getElementById(id);
    const fields = ['description', 'quantity', 'rate'];
    $('read-scenario').value = 'DRAFT';
    let state = null, busy = false, dirty = false, failed = false, pending = Promise.resolve();
    let preserved = null, errorState = null, errorText = '', invalidField = null;
    function values() { return Object.fromEntries(fields.map(field => [field, $(field).value])); }
    function describe(line) { return line ? `Description: ${line.description}\nQuantity: ${line.quantity}\nRate (USD): ${line.rate}` : 'Unavailable'; }
    function focus(id) { $(id).focus(); }
    function render() {
      const editable = !!state && ['NEEDS_REVIEW', 'APPROVED'].includes(state.status);
      const blocked = busy || failed || !state;
      const needsChoice = preserved !== null;
      $('app-root').setAttribute('aria-busy', String(busy));
      for (const field of fields) {
        $(field).disabled = blocked || !editable || needsChoice;
        $(field).setAttribute('aria-invalid', String(invalidField === field));
        if (invalidField === field) $(field).setAttribute('aria-errormessage', 'error-summary');
        else $(field).removeAttribute('aria-errormessage');
      }
      $('save').disabled = blocked || !editable || !dirty || needsChoice;
      $('approve').disabled = blocked || !editable || dirty || needsChoice;
      for (const id of ['success', 'unknown', 'failure', 'receipt']) $(id).disabled = blocked || dirty || needsChoice || state.status !== 'APPROVED';
      $('refresh').disabled = busy;
      $('recover').disabled = blocked || state.status !== 'CREATING';
      $('reconcile').disabled = blocked || !['CREATING', 'UNKNOWN'].includes(state.status) || !state.remoteId;
      $('read-scenario').disabled = $('reconcile').disabled;
      $('restore-edits').disabled = blocked || !editable || !preserved;
      $('discard-edits').disabled = busy || failed || !preserved;
      $('status').textContent = state ? `${failed ? 'Last read state' : 'State'}: ${state.status} · Revision ${state.revision} · ${failed ? 'May be outdated; refresh required' : dirty || needsChoice ? 'Local edits are unapproved' : state.approval ? 'Mock approval stored' : 'No current mock approval'}` : 'State: unavailable';
      $('total').textContent = state && !dirty && !needsChoice && !failed ? `${state.total} USD` : 'Review and validate changes first';
      $('validation').textContent = failed ? 'Locked after an error. Refresh before acting.' : needsChoice ? 'Local edits are preserved below. Choose Restore for review or Discard before continuing.' : dirty ? 'Unsaved changes. Approval and simulation are blocked.' : busy ? 'Waiting for the local database. Repeated clicks are blocked.' : state ? 'Persisted evidence, quantity and rate match.' : 'Loading the local database.';
      $('storage').textContent = state ? `${state.storage} · ${state.draftId} · ${state.operationId || 'No operation'}` : 'No authoritative state loaded';
      $('recovery-summary').textContent = state?.recovery?.summary || 'Read the database before deciding how to recover.';
      $('recovery-next-step').textContent = state?.recovery?.nextStep || 'No retry has been sent.';
      $('recovery-receipt').textContent = state ? `Saved invoice ID: ${state.remoteId || 'None'} · Operation/request ID: ${state.operationId || 'None'}` : 'Receipt and operation unavailable';
      $('recovery-code').textContent = state ? `Reason: ${state.recoveryCode || 'NOT_STARTED'} · Read checks: ${state.readChecks ?? 0} · Last read status: ${state.lastReadStatus || 'None'}` : 'No durable recovery information';
      $('error-summary').hidden = !failed;
      $('error-summary').textContent = failed ? `${errorText} ${preserved ? 'Your unsaved values are preserved in this tab.' : ''} Refresh the database before continuing.`.trim() : '';
      $('comparison-panel').hidden = !preserved && !errorState;
      $('local-values').textContent = describe(preserved);
      $('server-values').textContent = describe((errorState || state)?.draft?.lines?.[0]);
      $('comparison-caption').textContent = errorState ? `Server snapshot returned with the error: revision ${errorState.revision}. Refresh before acting.` : failed ? 'Last loaded database values; they may be outdated.' : 'Currently loaded database values. Restoring local edits does not save or approve them.';
    }
    function receive(next) {
      state = next; dirty = false;
      const line = next.draft.lines[0]; for (const field of fields) $(field).value = line[field];
    }
    function act(fn, message, kind = 'action') {
      if (busy) return pending;
      if (kind === 'refresh' && dirty) preserved = values();
      busy = true; render();
      pending = (async () => {
        try {
          const result = await fn(); receive(result.state); failed = false; invalidField = null; errorState = null; errorText = '';
          if (kind === 'save') preserved = null;
          $('result').setAttribute('aria-live', 'polite');
          $('result').textContent = typeof message === 'function' ? message(result) : message;
        } catch (error) {
          if (dirty) preserved = values();
          failed = true; errorText = error.message; errorState = error.serverState || null;
          invalidField = /Rate differs/.test(errorText) ? 'rate' : /Quantity differs/.test(errorText) ? 'quantity' : /Description|description/.test(errorText) ? 'description' : null;
          $('result').setAttribute('aria-live', 'off');
          $('result').textContent = errorText;
        } finally {
          busy = false; render();
          if (failed) focus('error-summary');
          else if (kind === 'save') focus('approve');
          else if (kind === 'refresh') focus(preserved ? 'comparison-heading' : 'result');
          else if (kind !== 'initial') focus('result');
        }
      })();
      return pending;
    }
    for (const field of fields) $(field).addEventListener('input', () => {
      if ($(field).disabled) return;
      dirty = true; invalidField = null; $('result').textContent = 'Local edit only. Save it before approving.'; render();
    });
    $('draft-form').addEventListener('submit', event => event.preventDefault());
    $('save').addEventListener('click', () => { if (!$('save').disabled) return act(() => client.save(values(), state.revision), 'Saved. The previous mock approval is invalid.', 'save'); });
    $('approve').addEventListener('click', () => { if (!$('approve').disabled) return act(() => client.approve(state.revision), 'Mock approval committed to the local database.'); });
    for (const [id, outcome] of [['success', 'DRAFT'], ['unknown', 'UNKNOWN'], ['failure', 'FAILED'], ['receipt', 'RECEIPT_SAVED']]) $(id).addEventListener('click', () => {
      if (!$(id).disabled) return act(() => client.simulate(state.approval, outcome), result => result.started ? `SIMULATED: ${result.state.status}. No invoice exists on PayPal.` : 'Existing operation restored. No new simulation was started.');
    });
    $('refresh').addEventListener('click', () => { if (!$('refresh').disabled) return act(() => client.load(), () => preserved ? 'Database refreshed. Local edits are preserved below; choose Restore or Discard.' : 'Authoritative database state loaded.', 'refresh'); });
    $('restore-edits').addEventListener('click', () => {
      if ($('restore-edits').disabled) return;
      for (const field of fields) $(field).value = preserved[field];
      preserved = null; dirty = true; errorState = null; invalidField = null;
      $('result').textContent = 'Local edits restored for review only. Save and approve a new revision before simulating.'; render(); focus('description');
    });
    $('discard-edits').addEventListener('click', () => {
      if ($('discard-edits').disabled) return;
      preserved = null; errorState = null; $('result').textContent = 'Preserved local edits discarded. The loaded database revision is unchanged.'; render(); focus('result');
    });
    $('recover').addEventListener('click', () => { if (!$('recover').disabled) return act(() => client.recover(), 'Interrupted synthetic operation fenced as UNKNOWN. No retry is available.'); });
    $('reconcile').addEventListener('click', () => { if (!$('reconcile').disabled) return act(() => client.reconcile($('read-scenario').value), result => result.state.status === 'DRAFT_VERIFIED' ? 'Saved synthetic receipt matched a simulated DRAFT read. No external API called.' : `Still unresolved: ${result.state.recoveryCode}. No create was retried.`); });
    const ready = act(() => client.load(), 'Persistent synthetic state loaded.', 'initial');
    return { ready, idle: () => pending };
  }
  root.InvoiceProofLocal.mount = mount;
  if (root.document && root.fetch) root.invoiceProofApp = mount(root.document, new root.InvoiceProofLocal.Client(root.fetch.bind(root)));
})(globalThis);
