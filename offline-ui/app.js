'use strict';
const model = new InvoiceProofDemo.Model();
const $ = id => document.getElementById(id);
function render() {
  const s = model.snapshot(); let valid = true;
  try { $('total').textContent = `${model.total()} USD`; $('validation').textContent = 'Source, quantity, rate and currency match.'; }
  catch (e) { valid = false; $('total').textContent = 'Blocked'; $('validation').textContent = e.message; }
  const editable = ['NEEDS_REVIEW', 'APPROVED'].includes(s.state);
  for (const field of ['description', 'quantity', 'rate']) $(field).disabled = !editable;
  $('approve').disabled = !valid || !editable;
  $('success').disabled = $('unknown').disabled = s.state !== 'APPROVED';
  $('status').textContent = `State: ${s.state} · Revision ${s.revision} · ${s.approvedRevision === null ? 'No current mock approval' : `Mock approval for revision ${s.approvedRevision}`}`;
}
function act(fn) { try { fn(); } catch (e) { $('result').textContent = e.message; } render(); }
for (const field of ['description', 'quantity', 'rate']) $(field).addEventListener('input', e => act(() => { model.edit(field, e.target.value); $('result').textContent = 'Edited: previous approval is invalid.'; }));
$('draft-form').addEventListener('submit', e => e.preventDefault());
$('approve').addEventListener('click', () => act(() => { model.approve(); $('result').textContent = 'Mock approval recorded locally for this revision only.'; }));
function simulate(outcome) { act(() => { if (model.begin('synthetic-operation-1')) { model.finish(outcome); $('result').textContent = outcome === 'DRAFT' ? 'SIMULATED: synthetic receipt and DRAFT read agree. No invoice exists on PayPal.' : 'SIMULATED: outcome unknown. This session is halted; no new operation can start.'; } }); }
$('success').addEventListener('click', () => simulate('DRAFT'));
$('unknown').addEventListener('click', () => simulate('UNKNOWN'));
render();
