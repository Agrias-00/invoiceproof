/* Offline synthetic demonstration. No network or storage adapter exists. */
(function (root) {
  'use strict';
  const fixture = () => ({ description: 'Synthetic design work', quantity: '2', rate: '50.00' });
  const minor = value => {
    if (typeof value !== 'string' || !/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(value)) throw Error('Use a nonnegative decimal with at most 2 places.');
    const [w, f = ''] = value.split('.'); return BigInt(w) * 100n + BigInt(f.padEnd(2, '0'));
  };
  class Model {
    #draft = fixture(); #revision = 1; #approvedRevision = null; #state = 'NEEDS_REVIEW'; #operation = null;
    snapshot() { return { draft: { ...this.#draft }, revision: this.#revision, approvedRevision: this.#approvedRevision, state: this.#state, operation: this.#operation }; }
    total() {
      if (!this.#draft.description.trim() || this.#draft.description.length > 200) throw Error('Enter a description (1–200 characters).');
      const q = minor(this.#draft.quantity), r = minor(this.#draft.rate);
      if (q !== 200n || r !== 5000n) throw Error('Evidence mismatch: source-1 supports only 2 hours × USD 50.00.');
      const cents = (q * r + 50n) / 100n;
      return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
    }
    edit(field, value) {
      if (!['NEEDS_REVIEW', 'APPROVED'].includes(this.#state)) throw Error('Editing is locked after a simulation starts.');
      if (!['description', 'quantity', 'rate'].includes(field) || typeof value !== 'string') throw Error('Invalid field.');
      this.#draft[field] = value; this.#revision++; this.#approvedRevision = null; this.#state = 'NEEDS_REVIEW';
    }
    approve() {
      if (!['NEEDS_REVIEW', 'APPROVED'].includes(this.#state)) throw Error('Approval is locked.');
      this.total(); this.#approvedRevision = this.#revision; this.#state = 'APPROVED';
    }
    begin(id) {
      if (this.#operation === id && id) return false;
      if (typeof id !== 'string' || !id || this.#state !== 'APPROVED' || this.#approvedRevision !== this.#revision) throw Error('A current mock approval is required; retry is blocked.');
      this.total(); this.#operation = id; this.#state = 'CREATING'; return true;
    }
    finish(outcome) {
      if (this.#state !== 'CREATING') throw Error('No pending simulation.');
      if (outcome === 'DRAFT') this.#state = 'DRAFT_VERIFIED';
      else this.#state = 'UNKNOWN';
    }
  }
  root.InvoiceProofDemo = { Model, minor, fixture };
  if (typeof module !== 'undefined') module.exports = root.InvoiceProofDemo;
})(globalThis);
