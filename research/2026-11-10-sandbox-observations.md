# Sandbox observations, 2026-11-10

What the PayPal sandbox did when called, as opposed to what the guides say.
Each row is an observation on one sandbox Business account on one day, not a
statement about PayPal in general. Calls: `POST /v2/invoicing/invoices` with
the synthetic fixture, `GET /v2/invoicing/invoices/{id}`,
`POST /v2/invoicing/search-invoices`. Host: `https://api-m.sandbox.paypal.com`.

| # | Question | Observed | Times | Consequence in the app |
|---|---|---|---|---|
| 1 | Which host do the links of a create response name? | `https://api.sandbox.paypal.com`, not the `api-m` host the request went to. Body: full invoice (`id`, `status: DRAFT`, `links` with `self`, `send`, `replace`, `delete`, `record-payment`). | 1 | `normalizeCreate` accepts a self link on either sandbox host; any other host is still a conflict. Requests go to the `api-m` host only. |
| 2 | Does a repeated `PayPal-Request-Id` return the first invoice? | No. The same header value and the same body, sent twice in sequence (once immediately, once 3 s apart), returned `201` twice with two different invoice ids and two different automatic invoice numbers. | 2 | The header is still sent but nothing relies on it. |
| 3 | Does a repeated `detail.invoice_number` create a second invoice? | No. The second create returned `422 UNPROCESSABLE_ENTITY` with issue `DUPLICATE_INVOICE_NUMBER`. | 1 probe, 1 test run | Each stored operation derives one invoice number (`invoiceNumberFor`). A duplicate-number answer is `unknown / CREATE_DUPLICATE_NUMBER`: an earlier attempt landed, and it is resolved by lookup, never by another create. |
| 4 | Can the first invoice be found by that number? | Yes. Search by `invoice_number` returned exactly that invoice, status `DRAFT`, immediately and again after 5 s. A number never used returned no item. | 2 probes, 1 test run | `findByOperation` returns `found` only for exactly one exact-number match; none is reported as none, not as proof that nothing was created. |

Row 2 differs from the guide quoted in `official-contract-findings.md`
("retry with the same ID to safely retrieve the original result") and agrees
with the schema, which declares no request-id parameter on this operation.

Proof: `local-app/sandbox.test.ts`, test "live sandbox: one operation creates
one draft, reads it back and finds it again" (runs only with sandbox keys in
the environment), 11 of 11 passing on 2026-11-10. The probes that produced
rows 1 to 4 were scratch scripts and are not kept; the test repeats rows 1, 3
and 4 on every keyed run.

Not observed: how long a number stays reserved after an invoice is deleted,
search consistency under load, and behaviour on a live account.
