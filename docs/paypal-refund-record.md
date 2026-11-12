# What PayPal keeps about a line refund

Read from the PayPal sandbox on 2026-11-11 with `GET /v2/payments/refunds/{refund_id}`
for the whole-line refund (USD 100.00) of an earlier take (synthetic data); the refund in the current video is the 2026-11-12 one below. The payer block and
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

## The partial-quantity refund in the video (2026-11-12)

The video's refund gives back 1 of the line's 2 hours. The app read the note
back from PayPal's refund record after the refund (`refund.paypal_note` in the
take's `marks.json`): status `COMPLETED`, USD 50.00, and

```text
L5 Design on the homepage revisions (includes 1 hour client call walkthrough) (1 of 2): Refunded after the client's question: We didn't agree to the design rate for the hour on the call.
```

So PayPal's record also carries the part of the line that was given back.
