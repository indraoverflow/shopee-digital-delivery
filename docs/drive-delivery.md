# Delivering through Google Drive

Most of what these shops sell already lives in a Google Drive folder, and the way it is
sold today is manual: the buyer pays, the shop asks for an address in chat, and the file is
shared by hand. This document describes the automated version and, just as importantly,
what it cannot promise.

## What the buyer sees

1.  Enters the order number and proves it is theirs, as with every other product.
2.  The product card asks for a Gmail address, twice.
3.  Presses "Bagikan ke akun Google saya".
4.  The file appears in that account's "Shared with me", and Google sends the notification
    email. The card names the address it went to, masked.

That is one extra field pair compared with a download link. It is deliberately not a Google
sign-in: most buyers would have to log in mid-claim, and drop-off there costs more than the
typo it would prevent.

The mistake path matters more than the happy path:

| Situation                           | What happens                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| Same address submitted twice        | The existing grant is returned; no second permission is created                               |
| Different address within 15 minutes | The old permission is deleted first, then the new one created; the row keeps `corrected_from` |
| Different address after 15 minutes  | `ADDRESS_LOCKED`, 409. An operator has to step in                                             |
| Two addresses differ in the form    | Rejected before Google is called                                                              |
| Google refuses or is down           | `DRIVE_SHARE_FAILED`, 502, and the grant row stays `FAILED` for the operator list             |

## What the shop sets up, once

1. A Google Cloud project, OAuth client of type "Web application", redirect URI
   `https://api.qansa.web.id/api/admin/drive/callback`.
2. Scope `https://www.googleapis.com/auth/drive`. Publish the OAuth app to **Production**, not
   Testing: a Testing app's refresh token dies after seven days, which quietly breaks the
   automation every week.
3. Values in the server environment:

       GOOGLE_OAUTH_CLIENT_ID=...
       GOOGLE_OAUTH_CLIENT_SECRET=...
       GOOGLE_DRIVE_REDIRECT_URI=https://api.qansa.web.id/api/admin/drive/callback
       DRIVE_ADDRESS_FIX_MINUTES=15

4. In the console, open the store, press "Hubungkan Google Drive", approve once.

A consumer `@gmail.com` account cannot use domain-wide delegation and has no shared drives,
which is why this is a per-store user consent rather than a service account. The resulting
refresh token grants the whole account, so connect a dedicated account that owns only the
product folder, not the account used for mail, Photos and Gemini.

## What is stored and what is not

| Thing              | Where                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------- |
| Refresh token      | `drive_credentials.refresh_token_enc`, AES-256-GCM, never returned by any endpoint      |
| Who received what  | `drive_grants`: address, file id, permission id, status, timestamps                     |
| Correction history | `drive_grants.corrected_from` plus the revoked row                                      |
| Delivery proof     | `delivery_logs` with kind `DRIVE` and the masked address                                |
| Audit              | `drive.connected`, `drive.disconnected`, `drive.grant`, `drive.retry` in the hash chain |

The buyer's address is masked in every screen, log and audit row: `r***@gmail.com`. It is
personal data, and the raw value is only in the grant table where it is needed to revoke.

## The share has no expiry

A Drive share stays valid until the operator revokes it, so the buyer can reopen the portal and
copy the same link later. Reopening costs nothing and does not count against the product's
take-limit: `deliveries_used` stays at 0 for `DRIVE` products. What expires is the claim session,
not the product.

## Limits worth knowing before promising this to a buyer

- **No verification of ownership.** Because the address is typed, a sufficiently wrong typo
  sends a paid product to a stranger. The double entry and the 15-minute fix cover the
  common case, not a determined mistake. For legal documents, that is not good enough, which
  is why e-Meterai uses minted links instead.
- **Drive caps how many people one file can be shared with.** A best-seller can hit it. Plan
  to rotate copies of the file every so often, and keep track of which copy each buyer got.
- **Access is permanent until revoked.** Revoking a claim revokes access; nothing else does
  automatically today. A scheduled sweep is the obvious next step.
- **The token can be revoked by the owner at any time** in their Google account settings. When
  that happens the store shows `ERROR` with the reason, and shares start failing with
  `DRIVE_TOKEN_INVALID` until it is reconnected.
- **The buyer's Google quota is their own.** A 2 TB account does not help a buyer with a full
  Drive; the file still counts against them only if copied, not when shared as reader.

## Where to look when it goes wrong

    GET  /api/admin/stores/:id/drive          connection state, account, last error
    GET  /api/admin/drive-grants?status=FAILED shares Google refused
    POST /api/admin/drive-grants/:id/retry     try again for one buyer

A share that fails is visible to the buyer as a retry-able message, and to the operator in the
failed list. Nothing is silently lost: the grant row exists from before the Google call.
