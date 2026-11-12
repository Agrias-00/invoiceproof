# What PayPal keeps about a line refund

Read from the PayPal sandbox on 2026-11-11 with `GET /v2/payments/refunds/{refund_id}`
for the refund shown in the demo video (synthetic data). The payer block and
the fee breakdown are left out; the other fields are as PayPal returned them.

```json
{
  "status": "COMPLETED",
  "amount": { "currency_code": "USD", "value": "100.00" },
  "note_to_payer": "L5 Design on the homepage revisions: Refunded after the client's question: Your own log says these two hours were mostly waiting for our feedback.",
  "invoice_id": "INV2-83LV-NJU3-MXFW-JXZM"
}
```

So PayPal's own refund record names the invoice, the line (`L5` and its
description) and the reason. The link from a refund to its line can be read
from PayPal without InvoiceProof's database.

Not shown: how PayPal displays this note to a payer. The demo payer is a
guest with a test card and has no PayPal account to look at, and the invoice
read (`GET /v2/invoicing/invoices/{id}`) lists the refund's amount and date
but not the note.
