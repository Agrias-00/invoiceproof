// Sandbox only; draft only; synthetic data.
import { describeCreateRequest, invoiceNumberFor, normalizeCreate, normalizeRead, payerViewUrl } from './paypal-contract.ts';
import type { CreateReceipt, Presentation, ReadResult } from './paypal-contract.ts';
import type { Draft } from '../offline-core/core.ts';

export const SANDBOX_ORIGIN = 'https://api-m.sandbox.paypal.com';
/** One match is the invoice of the operation. None is not proof that nothing was created. */
export type FindResult = { kind: 'found'; remoteId: string; status: string } | { kind: 'none' } | { kind: 'ambiguous'; count: number } | { kind: 'unavailable'; code: 'FIND_TIMEOUT' | 'FIND_UNAVAILABLE' | 'FIND_MALFORMED' };
export type SandboxCreateResult = CreateReceipt | { kind: 'unknown'; reason: string } | { kind: 'failed'; reason: 'PROVIDER_REJECTED' | 'CREDENTIALS_REFUSED'; status: number; debugId: string | null };

type Options = { clientId: string; clientSecret: string; baseUrl?: string; fetch?: typeof globalThis.fetch; timeoutMs?: number };
/** One invoice item as this app writes it: the line's description is the item name; `description` carries its quotes. */
export type InvoiceItem = { name: string; description: string; quantity: string; rate: string };
/** The note PayPal holds on a refund, as PayPal returns it; absent when the reply carries none. */
const noteOf = (data: any): { note?: string } => typeof data?.note_to_payer === 'string' && data.note_to_payer ? { note: data.note_to_payer.slice(0, 255) } : {};

export class SandboxPayPal {
  private clientId: string;
  private clientSecret: string;
  private fetcher: typeof globalThis.fetch;
  private timeoutMs: number;
  private token: string | null = null;
  private expiresAt = 0;
  constructor({ clientId, clientSecret, baseUrl = SANDBOX_ORIGIN, fetch = globalThis.fetch, timeoutMs = 15000 }: Options) {
    if (baseUrl !== SANDBOX_ORIGIN || !clientId || !clientSecret) throw new Error('Invalid sandbox configuration');
    this.clientId = clientId; this.clientSecret = clientSecret; this.fetcher = fetch; this.timeoutMs = timeoutMs;
  }
  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try { return await this.fetcher(SANDBOX_ORIGIN + path, { ...init, signal: controller.signal }); }
    catch { if (controller.signal.aborted) throw new Error('TIMEOUT'); throw new Error('NETWORK'); }
    finally { clearTimeout(timer); }
  }
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt) return this.token;
    const response = await this.request('/v1/oauth2/token', { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
    // Refused credentials are a definite failure, not a network fault: nothing reached the invoice API.
    if (response.status === 401 || response.status === 403) throw new Error('AUTH');
    if (!response.ok) throw new Error('NETWORK');
    let data: any;
    try { data = await response.json(); } catch { throw new Error('NETWORK'); }
    if (typeof data?.access_token !== 'string' || !data.access_token || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in)) throw new Error('NETWORK');
    this.token = data.access_token; this.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return this.token;
  }
  private async api(path: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      const response = await this.request(path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
      if (response.status !== 401 || attempt === 1) return response;
      this.token = null; this.expiresAt = 0;
    }
  }
  async createDraft(draft: Draft, requestId: string, presentation?: Presentation): Promise<SandboxCreateResult> {
    let description: ReturnType<typeof describeCreateRequest>;
    try { description = describeCreateRequest(draft, requestId, presentation); } catch { return { kind: 'unknown', reason: 'CREATE_MALFORMED' }; }
    const { email_address: _email, ...invoicer } = description.body.invoicer;
    let response: Response;
    try { response = await this.api(description.path, { method: description.method, headers: { ...description.headers, Prefer: 'return=representation' }, body: JSON.stringify({ ...description.body, invoicer }) }); }
    catch (error) {
      const cause = error instanceof Error ? error.message : '';
      if (cause === 'AUTH') return { kind: 'failed', reason: 'CREDENTIALS_REFUSED', status: 401, debugId: null };
      return { kind: 'unknown', reason: cause === 'TIMEOUT' ? 'CREATE_TIMEOUT' : 'CREATE_NETWORK_ERROR' };
    }
    if (response.status === 429) return { kind: 'unknown', reason: 'CREATE_RATE_LIMITED' };
    if (response.status >= 500) return { kind: 'unknown', reason: 'CREATE_SERVER_ERROR' };
    let data: any;
    try { data = await response.json(); } catch {
      if (response.status >= 400 && response.status < 500) return { kind: 'failed', reason: 'PROVIDER_REJECTED', status: response.status, debugId: null };
      return { kind: 'unknown', reason: 'CREATE_MALFORMED' };
    }
    if (response.status >= 400 && response.status < 500) {
      // An invoice with this operation's number already exists: an earlier attempt landed. Resolve with findByOperation, never by a new create.
      if (response.status === 422 && Array.isArray(data?.details) && data.details.some((d: any) => d?.issue === 'DUPLICATE_INVOICE_NUMBER')) return { kind: 'unknown', reason: 'CREATE_DUPLICATE_NUMBER' };
      const debugId = typeof data?.debug_id === 'string' ? data.debug_id : null;
      const sensitive = [this.clientSecret, this.token, Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')].filter((s): s is string => !!s);
      return { kind: 'failed', reason: 'PROVIDER_REJECTED', status: response.status, debugId: debugId && sensitive.some(s => debugId.includes(s)) ? null : debugId };
    }
    return normalizeCreate(response.status, data);
  }
  /** Finds the invoice an operation created, by its invoice number. Reads only; never creates. */
  async findByOperation(requestId: string): Promise<FindResult> {
    const number = invoiceNumberFor(requestId);
    let response: Response;
    try { response = await this.api('/v2/invoicing/search-invoices?total_required=true&page_size=10', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invoice_number: number }) }); }
    catch (error) { return { kind: 'unavailable', code: error instanceof Error && error.message === 'TIMEOUT' ? 'FIND_TIMEOUT' : 'FIND_UNAVAILABLE' }; }
    if (!response.ok) return { kind: 'unavailable', code: 'FIND_UNAVAILABLE' };
    let data: any;
    try { data = await response.json(); } catch { return { kind: 'unavailable', code: 'FIND_MALFORMED' }; }
    if (data === null || typeof data !== 'object' || ('items' in data && !Array.isArray(data.items))) return { kind: 'unavailable', code: 'FIND_MALFORMED' };
    // The search may match by prefix; only an exact number counts.
    const exact = (data.items ?? []).filter((item: any) => item?.detail?.invoice_number === number);
    if (exact.length === 0) return { kind: 'none' };
    if (exact.length > 1) return { kind: 'ambiguous', count: exact.length };
    const [{ id, status }] = exact;
    if (typeof id !== 'string' || !/^INV2-[A-Z0-9-]{1,80}$/.test(id) || typeof status !== 'string') return { kind: 'unavailable', code: 'FIND_MALFORMED' };
    return { kind: 'found', remoteId: id, status };
  }
  async readInvoice(remoteId: string): Promise<ReadResult> {
    if (!/^INV2-[A-Z0-9-]{1,80}$/.test(remoteId)) return { kind: 'unavailable', code: 'READ_MALFORMED' };
    try {
      const response = await this.api(`/v2/invoicing/invoices/${remoteId}`, { method: 'GET' });
      let data: unknown = null;
      try { data = await response.json(); } catch { /* normalize the missing body */ }
      return normalizeRead(response.status, data);
    } catch (error) { return { kind: 'unavailable', code: error instanceof Error && error.message === 'TIMEOUT' ? 'READ_TIMEOUT' : 'READ_UNAVAILABLE' }; }
  }
  async sendInvoice(remoteId: string): Promise<string | null> {
    if (!/^INV2-[A-Z0-9-]{1,80}$/.test(remoteId)) throw new Error('Invalid invoice');
    const response = await this.api(`/v2/invoicing/invoices/${remoteId}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ send_to_recipient: false, send_to_invoicer: false }) });
    if (!response.ok) throw new Error('SEND_UNAVAILABLE');
    const data: any = await response.json();
    return data?.rel === 'payer-view' ? payerViewUrl(data.href) : null;
  }
  /**
   * Replaces the items and note of an existing invoice, sent or not, without e-mailing anyone. PayPal keeps the
   * invoice number and the payer link (measured in the sandbox, 2026-11-10: a sent invoice went from 2 items to 1,
   * HTTP 200). Fields PayPal computes or only reads are left out of the body. Throws UPDATE_REFUSED when PayPal
   * definitely did not apply it (the read failed, or the update got a 4xx), and UPDATE_UNKNOWN when it may have.
   * With `expect`, it throws UPDATE_CONFLICT without writing when the items (name, description, quantity, rate) or the
   * note PayPal holds are not the ones this app wrote, so an edit made elsewhere in PayPal is never overwritten.
   */
  async updateInvoice(remoteId: string, items: InvoiceItem[], note: string, expect?: { items: InvoiceItem[]; note: string }): Promise<void> {
    if (!/^INV2-[A-Z0-9-]{1,80}$/.test(remoteId) || items.length === 0) throw new Error('Invalid invoice');
    const current = await this.api(`/v2/invoicing/invoices/${remoteId}`, { method: 'GET' }).catch(() => null);
    if (!current?.ok) throw new Error('UPDATE_REFUSED');
    const invoice: any = await current.json().catch(() => null);
    if (!invoice || typeof invoice !== 'object' || invoice.id !== remoteId || typeof invoice.detail !== 'object') throw new Error('UPDATE_REFUSED');
    if (expect) {
      const held: any[] | null = Array.isArray(invoice.items) ? invoice.items : null;
      const same = (h: any, w: InvoiceItem) => String(h?.name ?? '') === w.name.slice(0, 200) && String(h?.description ?? '').trim() === w.description.slice(0, 1000).trim()
        && Number(h?.quantity) === Number(w.quantity) && Number(h?.unit_amount?.value) === Number(w.rate);
      if (!held || held.length !== expect.items.length || held.some((h, i) => !same(h, expect.items[i]!)) || String(invoice.detail.note ?? '').trim() !== expect.note.slice(0, 4000).trim()) throw new Error('UPDATE_CONFLICT');
    }
    const { links: _l, amount: _a, due_amount: _d, payments: _p, refunds: _r, gratuity: _g, status: _s, ...body } = invoice;
    body.detail = { ...invoice.detail, note: note.slice(0, 4000) };
    body.items = items.map(item => ({ name: item.name.slice(0, 200), description: item.description.slice(0, 1000), quantity: item.quantity, unit_amount: { currency_code: 'USD', value: item.rate } }));
    const response = await this.api(`/v2/invoicing/invoices/${remoteId}?send_to_recipient=false&send_to_invoicer=false`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(body) }).catch(() => null);
    // A timeout or network fault may still have reached PayPal; only a 4xx is a definite refusal.
    if (!response) throw new Error('UPDATE_UNKNOWN');
    if (response.status >= 400 && response.status < 500) throw new Error('UPDATE_REFUSED');
    if (!response.ok) throw new Error('UPDATE_UNKNOWN');
  }
  /**
   * Refunds part of a captured PayPal payment. `requestId` goes in PayPal-Request-Id: the same id sent again returns
   * the same refund instead of a second one (measured in the sandbox, 2026-11-10: 201 then 200, one refund id), so a
   * lost reply is retried with the id the caller saved before the first call. Throws REFUND_REFUSED on a 4xx (nothing
   * was refunded; `issue` says why) and REFUND_UNKNOWN when it may have been.
   */
  async refundCapture(captureId: string, amount: string, requestId: string, noteToPayer: string): Promise<{ id: string; status: string; amount: string; note?: string }> {
    if (!/^[A-Z0-9]{8,32}$/.test(captureId) || !/^\d{1,12}\.\d{2}$/.test(amount) || Number(amount) <= 0 || !/^[0-9a-f-]{36}$/.test(requestId)) throw new Error('Invalid refund');
    const response = await this.api(`/v2/payments/captures/${captureId}/refund`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'PayPal-Request-Id': requestId, Prefer: 'return=representation' }, body: JSON.stringify({ amount: { currency_code: 'USD', value: amount }, note_to_payer: noteToPayer.slice(0, 255) }) }).catch(() => null);
    if (!response) throw new Error('REFUND_UNKNOWN');
    const data: any = await response.json().catch(() => null);
    if (response.status >= 400 && response.status < 500 && response.status !== 429) throw Object.assign(new Error('REFUND_REFUSED'), { issue: typeof data?.details?.[0]?.issue === 'string' ? data.details[0].issue : null });
    if (!response.ok || typeof data?.id !== 'string' || typeof data?.status !== 'string') throw new Error('REFUND_UNKNOWN');
    return { id: data.id, status: data.status, amount: typeof data.amount?.value === 'string' ? data.amount.value : amount, ...noteOf(data) };
  }
  /** Reads a refund's current status, for one PayPal reported as PENDING. Throws REFUND_UNKNOWN when unread. */
  async readRefund(refundId: string): Promise<{ id: string; status: string; amount: string | null; note?: string }> {
    if (!/^[A-Z0-9]{8,32}$/.test(refundId)) throw new Error('Invalid refund');
    const response = await this.api(`/v2/payments/refunds/${refundId}`, { method: 'GET' }).catch(() => null);
    const data: any = response?.ok ? await response.json().catch(() => null) : null;
    if (typeof data?.id !== 'string' || typeof data?.status !== 'string') throw new Error('REFUND_UNKNOWN');
    return { id: data.id, status: data.status, amount: typeof data.amount?.value === 'string' ? data.amount.value : null, ...noteOf(data) };
  }
  async generateQrCode(remoteId: string): Promise<Buffer> {
    if (!/^INV2-[A-Z0-9-]{1,80}$/.test(remoteId)) throw new Error('Invalid invoice');
    const response = await this.api(`/v2/invoicing/invoices/${remoteId}/generate-qr-code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ width: 300, height: 300 }) });
    if (!response.ok) throw new Error('QR_UNAVAILABLE');
    const text = await response.text();
    const match = text.match(/(?:\r?\n\r?\n)([A-Za-z0-9+/=\r\n]+)(?:\r?\n--)/);
    if (!match) throw new Error('QR_MALFORMED');
    const png = Buffer.from(match[1].replace(/\s/g, ''), 'base64');
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('QR_MALFORMED');
    return png;
  }
}
export function sandboxFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxPayPal | null {
  const paypal = env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET ? new SandboxPayPal({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET }) : null;
  return paypal && env.INVOICEPROOF_FAULT === LOST_REFUND_REPLY ? withLostRefundReply(paypal) : paypal;
}
/** Opt-in fault for demonstrating recovery: `INVOICEPROOF_FAULT=refund-lost-reply`. */
export const LOST_REFUND_REPLY = 'refund-lost-reply';
/**
 * Lets the first refund of each request id reach PayPal for real, then drops PayPal's reply, as a dropped connection
 * would. The error is marked `simulated` so the screen says so. A retry with the same request id gets the reply.
 */
export function withLostRefundReply(paypal: SandboxPayPal): SandboxPayPal {
  const dropped = new Set<string>();
  const faulty = Object.create(paypal) as SandboxPayPal;
  faulty.refundCapture = async (captureId, amount, requestId, note) => {
    const refund = await paypal.refundCapture(captureId, amount, requestId, note);
    if (dropped.has(requestId)) return refund;
    dropped.add(requestId);
    throw Object.assign(new Error('REFUND_UNKNOWN'), { simulated: true });
  };
  return faulty;
}
