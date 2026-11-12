/** Official-document-informed, synthetic-only boundary. No transport, credentials or live API.
 * Sources and unresolved differences: ../research/official-contract-findings.md.
 * Sandbox-only link parsing is validation, NEVER permission to follow an arbitrary href.
 */
import { validate } from '../offline-core/core.ts';
import { createHash } from 'node:crypto';
import type { Draft } from '../offline-core/core.ts';

export type CreateReceipt = { kind: 'receipt'; remoteId: string; format: 'representation' | 'self-link' };
export type CreateResult = CreateReceipt | { kind: 'unknown'; reason: string } | { kind: 'failed'; reason: 'SYNTHETIC_REJECTION' };
/** USD amounts PayPal reports on the invoice. A transaction without a PayPal payment id cannot be refunded through PayPal. */
export type InvoicePaid = { value: string; transactions: { payment_id: string | null; method: string | null; amount: string | null }[] };
export type InvoiceRefunded = { value: string; ids: string[] };
export type ReadResult ={ kind: 'invoice'; remoteId: string; status: string; number?: string; total?: string; items?: { name: string; quantity: string; unit_amount: { currency_code: string; value: string } }[]; currency?: string; value?: string; recipient_view_url?: string | null; paid?: InvoicePaid; refunded?: InvoiceRefunded } | { kind: 'unavailable'; code: 'READ_TIMEOUT' | 'READ_NOT_FOUND' | 'READ_MALFORMED' | 'READ_UNAVAILABLE' };
export type ReadScenario = 'DRAFT' | 'TIMEOUT' | 'NOT_FOUND' | 'MALFORMED' | 'UNAVAILABLE' | 'WRONG_ID' | 'SENT';
export const readScenarios = ['DRAFT','TIMEOUT','NOT_FOUND','MALFORMED','UNAVAILABLE','WRONG_ID','SENT'] as const;
const sandboxOrigin = 'https://api-m.sandbox.paypal.com';
// Requests go to sandboxOrigin only. Live create responses (observed 2026-11-10) link through the older sandbox host, so a link may name either.
const sandboxLinkOrigins = new Set([sandboxOrigin, 'https://api.sandbox.paypal.com']);
const invoiceId = (value: unknown): value is string => typeof value === 'string' && /^INV2-[A-Z0-9-]{1,80}$/.test(value);
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function payerViewUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.origin === 'https://www.sandbox.paypal.com' && !url.username && !url.password && url.pathname === '/invoice/p/' && !url.search && /^#[A-Z0-9-]+$/.test(url.hash) ? value : null;
  } catch { return null; }
}

export function normalizeCreate(status: number, payload: unknown): CreateResult {
  if (status !== 201 || !record(payload)) return { kind: 'unknown', reason: 'UNRECOGNIZED_CREATE_RESPONSE' };
  let linkedId: string | null = null;
  if ('href' in payload) {
    if (typeof payload.href !== 'string' || payload.rel !== 'self' || payload.method !== 'GET') return { kind: 'unknown', reason: 'INVALID_SELF_LINK' };
    try {
      const url = new URL(payload.href);
      if (!sandboxLinkOrigins.has(url.origin) || url.username || url.password || url.search || url.hash) return { kind: 'unknown', reason: 'INVALID_SELF_LINK' };
      const segments = url.pathname.split('/');
      if (segments.length !== 5 || segments.slice(0,4).join('/') !== '/v2/invoicing/invoices' || !invoiceId(segments[4])) return { kind: 'unknown', reason: 'INVALID_SELF_LINK' };
      linkedId = segments[4];
    } catch { return { kind: 'unknown', reason: 'INVALID_SELF_LINK' }; }
  }
  if ('id' in payload) {
    if (!invoiceId(payload.id) || (linkedId !== null && linkedId !== payload.id) || ('status' in payload && payload.status !== 'DRAFT')) return { kind: 'unknown', reason: 'CONFLICTING_CREATE_RECEIPT' };
    if ('links' in payload) {
      if (!Array.isArray(payload.links)) return { kind: 'unknown', reason: 'INVALID_REPRESENTATION_LINKS' };
      for (const link of payload.links) if (record(link) && link.rel === 'self') {
        const normalized = normalizeCreate(201, { href: link.href, rel: link.rel, method: link.method });
        if (normalized.kind !== 'receipt' || normalized.remoteId !== payload.id) return { kind: 'unknown', reason: 'CONFLICTING_CREATE_RECEIPT' };
      }
    }
    return { kind: 'receipt', remoteId: payload.id, format: 'representation' };
  }
  return linkedId ? { kind: 'receipt', remoteId: linkedId, format: 'self-link' } : { kind: 'unknown', reason: 'MISSING_CREATE_RECEIPT' };
}
export function normalizeRead(status: number, payload: unknown): ReadResult {
  if (status === 404) return { kind: 'unavailable', code: 'READ_NOT_FOUND' };
  if (status !== 200) return { kind: 'unavailable', code: 'READ_UNAVAILABLE' };
  if (!record(payload) || !invoiceId(payload.id) || typeof payload.status !== 'string' || !/^[A-Z_]{1,64}$/.test(payload.status)) return { kind: 'unavailable', code: 'READ_MALFORMED' };
  // The invoice number and the total are passed on exactly as the provider returned them, so the page can show what
  // the provider holds beside what the person approved. A missing or malformed one is left out, never filled in.
  const detail = record(payload.detail) ? payload.detail : {}, amount = record(payload.amount) ? payload.amount : {};
  const number = typeof detail.invoice_number === 'string' && /^[A-Za-z0-9-]{1,25}$/.test(detail.invoice_number) ? { number: detail.invoice_number } : {};
  const total = typeof amount.currency_code === 'string' && /^[A-Z]{3}$/.test(amount.currency_code) && typeof amount.value === 'string' && /^\d{1,12}(\.\d{1,2})?$/.test(amount.value) ? { total: `${amount.currency_code} ${amount.value}` } : {};
  const items = Array.isArray(payload.items) && payload.items.every((item: any) => typeof item?.name === 'string' && typeof item?.quantity === 'string' && typeof item?.unit_amount?.currency_code === 'string' && typeof item?.unit_amount?.value === 'string') ? { items: payload.items.map((item: any) => ({ name: item.name, quantity: item.quantity, unit_amount: { currency_code: item.unit_amount.currency_code, value: item.unit_amount.value } })) } : {};
  const amounts = typeof amount.currency_code === 'string' && /^[A-Z]{3}$/.test(amount.currency_code) && typeof amount.value === 'string' && /^\d{1,12}(\.\d{1,2})?$/.test(amount.value) ? { currency: amount.currency_code, value: amount.value } : {};
  const metadata = record(detail.metadata) ? detail.metadata : {};
  const recipient = 'recipient_view_url' in metadata ? { recipient_view_url: payerViewUrl(metadata.recipient_view_url) } : {};
  const money = (value: unknown) => record(value) && value.currency_code === 'USD' && typeof value.value === 'string' && /^\d{1,12}(\.\d{1,2})?$/.test(value.value) ? value.value : null;
  // Payments and refunds as PayPal records them. A payment counts as refundable only with its PayPal transaction id.
  const payments = record(payload.payments) ? payload.payments : null, refunds = record(payload.refunds) ? payload.refunds : null;
  const paid = payments && money(payments.paid_amount) !== null && Array.isArray(payments.transactions) ? { paid: { value: money(payments.paid_amount)!, transactions: payments.transactions.map((t: any) => ({ payment_id: typeof t?.payment_id === 'string' && /^[A-Z0-9]{8,32}$/.test(t.payment_id) ? t.payment_id : null, method: typeof t?.method === 'string' ? t.method : null, amount: money(t?.amount) })) } } : {};
  const refunded = refunds && money(refunds.refund_amount) !== null && Array.isArray(refunds.transactions) ? { refunded: { value: money(refunds.refund_amount)!, ids: refunds.transactions.flatMap((t: any) => typeof t?.recipient_transaction_id === 'string' ? [t.recipient_transaction_id] : typeof t?.refund_id === 'string' ? [t.refund_id] : []) } } : {};
  return { kind: 'invoice', remoteId: payload.id, status: payload.status, ...number, ...total, ...items, ...amounts, ...recipient, ...paid, ...refunded };
}
/**
 * The invoice number of one stored operation: PayPal refuses a second invoice with the same number
 * (422 DUPLICATE_INVOICE_NUMBER) and finds the first by it. The sandbox did not treat a repeated
 * PayPal-Request-Id as the same create (observed 2026-11-10, research/2026-11-10-sandbox-observations.md),
 * so the number, not the header, is what makes one operation one invoice.
 */
export function invoiceNumberFor(requestId: string): string {
  return 'IP-' + createHash('sha256').update(requestId).digest('hex').slice(0, 20).toUpperCase();
}
/** A reviewable request description, not an executable HTTP request. USD synthetic fixture only. */
/** What the client sees in PayPal besides the amounts: each item's quotes and the note that names the proof page. */
export type Presentation = { itemDescriptions: string[]; note: string };
export function describeCreateRequest(draft: Draft, requestId: string, presentation?: Presentation) {
  validate(draft);
  if (draft.currency !== 'USD') throw new Error('Only synthetic USD contract coverage exists');
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,38}$/.test(requestId)) throw new Error('Invalid persisted request ID');
  return {
    method: 'POST', path: '/v2/invoicing/invoices',
    headers: { 'Content-Type': 'application/json', 'PayPal-Request-Id': requestId },
    body: {
      detail: { currency_code: 'USD', reference: 'SYNTHETIC-ONLY', invoice_number: invoiceNumberFor(requestId), ...(presentation ? { note: presentation.note.slice(0, 4000) } : {}) },
      invoicer: { business_name: 'Synthetic Studio', email_address: 'merchant@example.invalid' },
      primary_recipients: [{ billing_info: { email_address: 'client@example.com', name: { given_name: 'Sample', surname: 'Client' } } }],
      items: draft.lines.map((line, i) => ({ name: line.description.slice(0, 200), ...(presentation?.itemDescriptions[i] ? { description: presentation.itemDescriptions[i].slice(0, 1000) } : {}), quantity: line.quantity, unit_amount: { currency_code: 'USD', value: line.rate } })),
    },
  };
}
export interface InvoiceProvider {
  createDraft(draft: Draft, persistedRequestId: string, scenario: 'DRAFT' | 'LINK_RECEIPT' | 'RECEIPT_SAVED' | 'UNKNOWN' | 'FAILED'): CreateResult;
  readInvoice(remoteId: string, scenario: ReadScenario): ReadResult;
}
/** Every response is a local literal. There is intentionally no HTTP implementation or auth field. */
export class OfflinePayPalMock implements InvoiceProvider {
  createDraft(draft: Draft, persistedRequestId: string, scenario: 'DRAFT' | 'LINK_RECEIPT' | 'RECEIPT_SAVED' | 'UNKNOWN' | 'FAILED'): CreateResult {
    describeCreateRequest(draft, persistedRequestId);
    if (!['DRAFT','LINK_RECEIPT','RECEIPT_SAVED','UNKNOWN','FAILED'].includes(scenario)) return { kind: 'unknown', reason: 'INVALID_SYNTHETIC_SCENARIO' };
    if (scenario === 'UNKNOWN') return { kind: 'unknown', reason: 'SYNTHETIC_TIMEOUT' };
    if (scenario === 'FAILED') return { kind: 'failed', reason: 'SYNTHETIC_REJECTION' };
    const id = 'INV2-SYNTHETIC-0001';
    return normalizeCreate(201, scenario === 'LINK_RECEIPT' ? { href: `${sandboxOrigin}/v2/invoicing/invoices/${id}`, rel: 'self', method: 'GET' } : { id, status: 'DRAFT' });
  }
  readInvoice(remoteId: string, scenario: ReadScenario): ReadResult {
    if (!readScenarios.includes(scenario)) return { kind: 'unavailable', code: 'READ_MALFORMED' };
    if (!invoiceId(remoteId)) return { kind: 'unavailable', code: 'READ_MALFORMED' };
    if (scenario === 'TIMEOUT') return { kind: 'unavailable', code: 'READ_TIMEOUT' };
    if (scenario === 'NOT_FOUND') return normalizeRead(404, {});
    if (scenario === 'MALFORMED') return normalizeRead(200, { status: 'DRAFT' });
    if (scenario === 'UNAVAILABLE') return normalizeRead(503, {});
    return normalizeRead(200, { id: scenario === 'WRONG_ID' ? 'INV2-SYNTHETIC-OTHER' : remoteId, status: scenario === 'SENT' ? 'SENT' : 'DRAFT' });
  }
}
