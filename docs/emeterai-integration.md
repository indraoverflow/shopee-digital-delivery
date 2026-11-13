# e-Meterai delivery

e-Meterai cannot be pre-stocked as a static code: the shop mints a link per buyer, the buyer opens it
and stamps their own PDF. This note records the protocol that was verified against the live service on
2026-11-13, the scripts that drive it, and what is still missing before a buyer receives the link from
the portal automatically.

This is the dashboard's private API, not a published partner contract. It can change without notice, and
driving someone else's billing system with it is a business decision, not only a technical one. A
reseller key from Peruri would be the durable answer; until one exists, this is what works.

## Verified protocol

Login is **not** a plain JSON call. The dashboard encrypts its bodies with a static AES key that ships in
the JavaScript every visitor downloads, and a login without the encryption is refused before the password
is looked at. That is why `{ email, password }` answered `{"statusCode":"09","result":"Login Failed"}`.

```
cipher   aes-256-cbc
key      sha256("jediljclksejdwklfjklsjaflkjflkwajkqlwjdsakljflkjfkldasjflkafjdklsafjdklsajfaskljfkdslajfkdsaljfkdsa")
iv       fixed "p3rUr13m3t3r41kv", or 16 random chars from a printable alphabet
wire     iv, key and ciphertext as base64, interleaved in four quarters (iv 6 chars, key 11, rest ciphertext)
```

| Call      | Where                                                                                                         | Body                                    |
| --------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Login     | `POST https://e-meterai.co.id/api/users/login`                                                                | `{"data": encrypt({ user, password })}` |
| Balance   | `POST https://e-meterai.co.id/api/function/saldopos`                                                          | `{}`                                    |
| Mint link | `GET https://e-meterai.co.id/api/v3/reseller/generate-link?data=<encrypt({fullpath:true,qty,partial:false})>` | none                                    |

The answer to a successful login is `{"statusCode":"00","token":"<jwt>","result":"<encrypted>"}`; the
encrypted part decrypts to the profile, and `token` is used as `Authorization: Bearer` afterwards.

A mint answers:

```json
{
  "status": "00",
  "message": "success",
  "result": {
    "message": "success generate link reseller sebanyak 1",
    "linkUrl": ["https://e-meterai.co.id/pdfViewer?refid=<id>="]
  }
}
```

`linkUrl` is already an absolute URL; that is what the buyer opens. Each call spends one unit of the
account's balance, so it is never called by a test, a smoke run or a preflight.

Only two hosts serve these paths: `https://e-meterai.co.id` and `https://inventory.e-meterai.co.id`.
`backendservice`, `stampv2` and `stampservice` 404 the same paths, which is worth knowing before
re-deriving them.

## Scripts

| Script                            | Does                                                    | Spends             |
| --------------------------------- | ------------------------------------------------------- | ------------------ |
| `scripts/emeterai-crypto.mjs`     | the cipher, encrypt and decrypt, with a round-trip test | no                 |
| `scripts/emeterai-probe.mjs`      | login, who the account is, balance                      | no                 |
| `scripts/emeterai-paths.mjs`      | which host serves which path                            | no                 |
| `scripts/emeterai-readonly.mjs`   | a short list of read-only GETs                          | no                 |
| `scripts/emeterai-mint.mjs [qty]` | mints one buyer link and prints the URL                 | **yes, qty units** |

The credentials file may be either `email=...` / `password=...` lines or a captured
`curl ... --data '{"data":"<blob>"}'` from the browser; both are accepted, because the blob is encrypted
with the same static key and decrypts back to the credentials. Nothing is printed either way.

## What the shop does today, and what is missing

Today: the operator runs `node scripts/emeterai-mint.mjs 1`, copies the printed `pdfViewer` URL, and
sends it to the buyer by hand. That works and is already better than clicking through the dashboard.

Missing, and deliberately not half-built: minting inside the fulfilment pipeline. The design is small and
fits what exists:

1. A credential block in settings, encrypted with `APP_ENCRYPTION_KEY` the way Shopee tokens are.
2. `fulfillments.minted_secret_enc` (plus `minted_at`), written once per fulfilment.
3. `accessDelivery` serves the minted value when present, and only falls back to the code pool otherwise.
4. An operator action "Buat tautan" that mints for one fulfilment and records the audit row, with
   idempotency so a retry never mints twice and never pays twice.
5. A failed mint is an `OUT_OF_STOCK`-class failure: tell the buyer support will follow up, notify the
   operator, and do not retry automatically, because each attempt costs money.

Until that lands, the manual step above is the honest state, and it is written here so nobody assumes the
portal already mints.
