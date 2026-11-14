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
| `scripts/emeterai-balance.mts`    | balance of the account stored in settings               | no                 |

`emeterai-balance.mts` is the one that reads the live account: it loads `settings.meterai`,
decrypts the stored password and calls the balance endpoint, so a broken credential shows up as an
error rather than at the first buyer. Point `DATABASE_URL` at the published Postgres port of the
compose stack, not at the in-network host. A `saldo: null` answer means the dashboard replied
without a readable body; the script is a credential smoke test, not a ledger.

The credentials file may be either `email=...` / `password=...` lines or a captured
`curl ... --data '{"data":"<blob>"}'` from the browser; both are accepted, because the blob is encrypted
with the same static key and decrypts back to the credentials. Nothing is printed either way.

## Verified against the live account

2026-11-14, on the compose stack, account `igam07541@gmail.com` from `settings.meterai`:

| Check                               | Result                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| Login with the stored password      | succeeds                                                                         |
| Mint for a fulfilment of quantity 1 | one link, `alreadyMinted: false`, `minted_at` written, `meterai.mint` audited    |
| Mint for a fulfilment of quantity 5 | five links, one per stamp, and the balance spent is 5                            |
| Buyer path                          | `POST /api/claim/fulfillments/:id/access` returns that same link as `kind: LINK` |
| Balance read                        | login succeeds, but the endpoint answers without a readable body (`saldo: null`) |

The supplier answers with `linkUrl` as an **array**: one entry per stamp, and the balance drops by
the same count. A five-meterai order receives five links. The first implementation kept only
`linkUrl[0]`, so four paid links were thrown away; the stored value is now a JSON array under the
same encrypted column, with a fallback for rows written before that change. Both the portal and the
operator dialog list every link.

## Minting inside the pipeline

The design above is implemented.

| Piece                                                 | Where                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| Credential block, password encrypted with the app key | Settings -> e-Meterai (`settings.meterai`)                                      |
| Product marker                                        | `digital_products.meterai_enabled`, a checkbox on the product form              |
| The minted value, written once                        | `fulfillments.minted_secret_enc`, `minted_at`, `minted_by`                      |
| Serving it to the buyer                               | `accessDelivery` returns it as a `LINK` payload                                 |
| Operator action                                       | `POST /api/admin/fulfillments/:id/mint`, button "Buat tautan" on the order page |
| Audit                                                 | `METERAI_LINK_MINTED` order event plus `meterai.mint` audit row                 |

Behaviour that matters, all covered by tests:

- **Idempotent by column, not by hope.** A second call returns the stored link and reports
  `alreadyMinted: true`; the supplier is not called again, so a retry can never pay twice.
- **A refusal stores nothing.** A rejected login surfaces as `METERAI_LOGIN_FAILED`, an unconfigured
  account as `METERAI_DISABLED`, and neither writes a partial row.
- **The buyer gets one link.** If a meterai product has no minted link yet, `accessDelivery` answers
  `OUT_OF_STOCK` with "support will follow up" instead of falling back to a shared URL.
- **Resending is a first-class action.** If the buyer lost the link, an operator presses "Lihat tautan" on
  the order page. That calls `GET /api/admin/fulfillments/:id/minted-link`, decrypts the stored value on
  the server and writes a `meterai.reveal` audit row naming the operator, the fulfilment and the mint time.
  The link itself never enters the metadata of that row: it is the secret being revealed. Reading needs
  only `claim:read`, because resending costs nothing at the supplier, unlike minting.
- **Nothing leaks.** The order screen reports `hasMintedLink` and `mintedAt`, never the ciphertext; the
  settings endpoint reports `hasPassword`, never the password.

The manual script stays useful: `scripts/emeterai-mint.mjs` still mints one link by hand when the portal
is not the right tool, for example to test a channel before wiring a product.

## Before turning it on in production

1. Settings -> e-Meterai: paste the account user and password, leave the base URL empty, switch it on.
2. On the product that should mint, tick "Produk e-Meterai". Codes on that product stop being used.
   The tick is in Produk Digital, either in the "Produk baru" dialog or, for a product that already
   exists, through "Ubah" on its row; saving goes through `PATCH /api/admin/digital-products/:id`,
   which only writes the fields it is given.
3. Place one real order and press "Buat tautan"; confirm the buyer sees the `pdfViewer` link and the
   balance dropped by the ordered quantity.
4. Decide the failure policy out loud: when a mint fails, an operator has to follow up by hand, because
   the platform deliberately does not retry a paid call on its own.
