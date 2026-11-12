(function (root) {
  'use strict';
  function validState(s) {
    return !!s && s.synthetic === true && Number.isSafeInteger(s.revision) && s.revision > 0 &&
      ['NEEDS_REVIEW','APPROVED','CREATING','UNKNOWN','FAILED','DRAFT_VERIFIED'].includes(s.status) &&
      !!s.draft && Array.isArray(s.draft.lines) && s.draft.lines.length === 1 && !!s.draft.lines[0] && typeof s.total === 'string' &&
      ['description','quantity','rate'].every(key => typeof s.draft.lines[0][key] === 'string') &&
      (s.status === 'NEEDS_REVIEW' ? s.approval === null : typeof s.approval === 'string' && /^[a-f0-9]{64}$/.test(s.approval));
  }
  class ClientError extends Error {
    constructor(message, code, status = null, serverState = null) {
      super(message); this.code = code; this.status = status; this.serverState = validState(serverState) ? serverState : null;
    }
  }
  class Client {
    constructor(fetcher, timeoutMs = 5000) { this.fetcher = fetcher; this.timeoutMs = timeoutMs; }
    async request(path, payload) {
      const options = { method: payload === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error' };
      if (payload !== undefined) { options.headers = { 'Content-Type': 'application/json' }; options.body = JSON.stringify(payload); }
      const controller = new AbortController(); options.signal = controller.signal;
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response, data;
      try { response = await this.fetcher(path, options); data = await response.json(); }
      catch { throw new ClientError('Connection or response failed. No retry was sent. Refresh authoritative state.', 'CONNECTION_UNCERTAIN'); }
      finally { clearTimeout(timer); }
      if (!data || typeof data !== 'object') throw new ClientError('Invalid server response. Controls remain locked.', 'INVALID_RESPONSE');
      if (!response.ok || !data.ok) throw new ClientError(data.error || 'Request failed. Refresh authoritative state.', typeof data.errorCode === 'string' ? data.errorCode : 'REQUEST_REJECTED', response.status, data.state);
      if (!validState(data.state)) throw new ClientError('Invalid server state. Controls remain locked.', 'INVALID_RESPONSE');
      return data;
    }
    load() { return this.request('/api/state'); }
    save(fields, expectedRevision) { return this.request('/api/edit', { ...fields, expectedRevision }); }
    approve(expectedRevision) { return this.request('/api/approve', { expectedRevision }); }
    simulate(approval, outcome) { return this.request('/api/simulate', { approval, outcome }); }
    recover() { return this.request('/api/recover', {}); }
    reconcile(scenario = 'DRAFT') { return this.request('/api/reconcile', { scenario }); }
  }
  root.InvoiceProofLocal = { Client, ClientError };
  if (typeof module !== 'undefined') module.exports = root.InvoiceProofLocal;
})(globalThis);
