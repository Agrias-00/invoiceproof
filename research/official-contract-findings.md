# PayPal official-source contract findings

Checked 2026-11-08. Read-only documentation research only. No accounts, credentials, API calls, publishing, payments, or project changes. Documentation claims below are not sandbox-tested behavior.

## Create draft and get

Source: https://developer.paypal.com/api/invoicing/v2/invoices-create

Quote: “Creates a draft invoice. To move the invoice from a draft to payable state, you must send the invoice.”

POST /v2/invoicing/invoices accepts JSON invoice details, merchant information, and items. Merchant must have an account in good standing. The documented success is 201 JSON. The example is a full invoice object with id, status DRAFT, detail, items, amount, due_amount, and links. detail.currency_code is required and three characters; invoice_number has a maximum of 25 characters; invoice_date uses YYYY-MM-DD. The date regex explicitly does not validate all dates, so calendar validation is required locally. Header parameters show Authorization only.

Source: https://developer.paypal.com/api/invoicing/v2/invoices-get

Quote: “Shows details for an invoice, by ID.” GET /v2/invoicing/invoices/{invoice_id} returns 200 JSON. Its example includes id, status DRAFT, detail, invoicer, primary_recipients, items, amount, due_amount, settings, and links. Read scope is https://uri.paypal.com/services/invoicing/invoices/read. Create declares the corresponding invoices/readwrite scope.

Source: https://developer.paypal.com/api/invoicing

Quickstart updated September 3, 2026. Quote: “The response body contains an `href` link with your invoice ID (`INV2-XXXX-XXXX-XXXX-XXXX`).” This differs from the full-object reference example. It also says to save the returned id. Treat response normalization as an explicit compatibility concern, not proof that every create response contains top-level id/status. Prerequisites list a Business account with Invoicing enabled, sandbox credentials and an access token. Draft creation is separate from sending; the customer is not yet notified.

## Create idempotency: explicit guidance and documentation gap

Source: https://developer.paypal.com/invoicing/troubleshooting

Updated September 3, 2026. The section specifically names POST /v2/invoicing/invoices after timeout or 5xx. Quote: “Store the `PayPal-Request-Id` before making the request. If the request times out and you're unsure whether PayPal received it, retry with the same ID to safely retrieve the original result.” It prescribes a unique stable ID per logical operation and says duplicates return the original response. This is explicit create-invoice guidance, not an inference from generic idempotency. It recommends exponential backoff with jitter for 429/5xx. It also says invoicer.email_address must match the Business account associated with the token. Sandbox/live URLs and credentials are separate.

Source: https://developer.paypal.com/api/invoicing/v2/schema.json

The invoices.create operation parameters array references only components/parameters/authorization. A shared paypal_request_id component exists, but that is not an operation-level declaration. Therefore the current reference/schema and guide are inconsistent in coverage. No create-invoice request-ID retention duration was found. Do not import Orders retention durations or shared-component limits as the create contract.

Source: https://developer.paypal.com/api/rest/reference/idempotency/

Updated August 11, 2026. Quote: “Not all APIs support this header.” Generic guidance permits timeout/5xx retries only while the server stores the ID, says concurrent same-ID calls might fail the second request, and describes returning the latest status, unlike the invoicing guide's “original response” phrasing. It recommends UUIDs and mentions 38 single-byte characters. These generic statements do not establish create-specific retention or byte-identical replay responses.

Source: https://developer.paypal.com/invoicing/core-concepts/

Updated May 20, 2026. Quote: “This value is customer-visible and must be unique within your PayPal invoices.” This refers to detail.invoice_number. detail.reference is also customer-visible. DRAFT means no customer notification yet. The invoicing-specific idempotency explanation says same-ID retries avoid duplicate invoices. Do not put internal secrets into invoice_number or reference.

## Errors and reconciliation

Source: https://developer.paypal.com/invoicing/errors/

Updated June 17, 2026. Quote: “For `4xx` errors other than `401` and `429`, return the error to the user with the `debug_id`. Don't retry.” 401: refresh token and retry once, then surface failure. 429/5xx: exponential backoff with jitter. Preserve name/message/debug_id/details, not just status. Guide and schema differ on some symbolic names, so avoid exhaustive assumptions about error strings. No create-specific DUPLICATE_INVOICE_NUMBER or DUPLICATE_INVOICE_ID contract was found in the current schema; a duplicate-number error must not be equated with successful reconciliation.

Source: https://developer.paypal.com/api/invoicing/v2/invoices-search-invoices

POST /v2/invoicing/search-invoices supports invoice_number, reference, currency_code, recipient_email and other filters. Quote: “If you pass multiple criteria, the response lists invoices that match all criteria.” page_size defaults 20 and allows 1–100; page allows 1–1000. These are search capabilities, not a guarantee that zero results prove non-creation after a timeout or that search is immediately consistent.

Engineering recommendations, not PayPal guarantees: persist local operation identity and immutable request snapshot before dispatch; distinguish definitely-not-submitted from unknown outcome; retain remote ID if obtained; verify details with GET after extracting a validated invoice resource ID from documented full-object or href response shapes. When ID is absent, search by persisted invoice number/reference, exhaust relevant pages, and verify merchant, recipient, currency, line items and totals before adopting any match. Zero, multiple or mismatched candidates remain unresolved. Do not auto-create using a fresh key just because a timeout, 5xx, duplicate error or empty search occurred. A local idempotency ledger is not proof of remote exactly-once behavior. Keep all tests synthetic until a separately authorized sandbox integration exists.

## Sandbox prerequisites and limits

Source: https://developer.paypal.com/sandbox-testing/accounts

Updated October 29, 2026. Quote: “Use sandbox accounts to test PayPal transactions without moving real money.” Default personal buyer and Business seller accounts are created at first Developer Dashboard login; the Business account includes sandbox API credentials. Sandbox-generated emails/passwords are login credentials, separate from app client credentials. No universal invoice-count or request-rate quota was established from this page.

Source: https://developer.paypal.com/api/rest/

Updated August 17, 2026. Client ID identifies an app; client secret authenticates it. Both are exchanged for an OAuth access token. Use returned expires_in rather than a hardcoded lifetime. Quote: “Keep this secret safe.” Developer accounts can test US integrations; this guide says a Business account is needed to test outside the US or go live. A sandbox result does not prove production eligibility.

Source: https://developer.paypal.com/api/codes/currency

Updated August 17, 2026. Three-letter currency codes are required. HUF, JPY and TWD disallow decimals; BRL, CNY and MYR have country-specific restrictions. Currency/payment support depends on geography and payment type. A syntactically valid ISO code is not automatically supported. A USD-only synthetic implementation should say so rather than claim universal currency coverage.
