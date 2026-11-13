# e-Meterai delivery

e-Meterai is the one product in the catalogue that cannot be pre-stocked as a static code: the shop
generates a link per buyer at [e-meterai.co.id](https://e-meterai.co.id), the buyer opens it and stamps
their own PDF. This note records what is known about that flow, what was verified, and the one blocker
that stops automation today.

## What the site exposes

The dashboard is a single-page app that talks to its own REST services. Bases taken from the shipped
bundle:

| Purpose                           | Base                                                                   |
| --------------------------------- | ---------------------------------------------------------------------- |
| Login, registration, profile      | `https://backendservice.e-meterai.co.id`                               |
| Stamping, balance, serial numbers | `https://stampservice.e-meterai.co.id`                                 |
| Reseller links                    | `https://stampv2.e-meterai.co.id`, `https://inventory.e-meterai.co.id` |
| File upload                       | `https://fileupload.e-meterai.co.id`                                   |

Endpoints read out of the bundle's path table:

| Action                         | Path                            |
| ------------------------------ | ------------------------------- |
| Login                          | `api/users/login`               |
| Profile / reseller info        | `api/v2/reseller`               |
| Balance                        | `function/saldopos`             |
| Generate buyer link (reseller) | `api/v3/reseller/generate-link` |
| Existing links                 | `reseller/links`                |
| Serial number                  | `api/v2/serialnumber`           |

Requests carry `Authorization: Bearer <token>` and a `csrf-token` header read from a `csrf-token`
cookie. That is how the dashboard itself talks to the API; it is not a documented partner API, and
automating it is a decision about that service's terms, not only about code.

## What was verified, and what failed

`scripts/emeterai-probe.mjs` logs in with the credentials in `/home/apps/.emeterai_login`, prints the
answer with every token and cookie masked, reads the balance, and stops. It never calls generate-link,
because that call can spend paid quota.

Run on 2026-11-13, three attempts total, the last one with the full browser header set
(`Origin`, `Referer`, `Accept-Language`, a Chrome user agent):

```
csrf     http 404  no token                       (/csrf not at the API root)
login    http 500  {"statusCode":"09","message":"error","result":"Login Failed"}
login    http 500  same, with browser headers
```

No cookie is set by any of the three origins, so there is no CSRF value to fetch before the first
login, which means the dashboard is not protecting its first call with one either.

Two conclusions, stated plainly:

1. The endpoint exists and answers in its own error format, so the request reached the right service and
   the payload shape is not the problem.
2. The login was refused three times, the last time with headers identical to a browser. What is left is
   the credential itself, an extra step the dashboard performs (email OTP, device check), or an account
   that is not enabled for anything but interactive use. The probe stops here: further attempts risk
   locking a real account, and none of the remaining causes can be fixed by guessing.

## What closes it

- Confirm in a browser that `/home/apps/.emeterai_login` still signs in. If it does not, update the file
  and rerun `node scripts/emeterai-probe.mjs`.
- If it does sign in, capture the login request once from the browser's network panel (field names and
  headers) and the adapter can be written against the real shape instead of a guess.
- If the account is a reseller or wholesale account, ask for the documented API and its key: an
  integration built on a published contract is worth more than one built on the dashboard's private
  endpoints.

## Until then

The shop can keep generating links by hand. The platform already delivers a per-order link: create the
digital product with `deliveryKind = LINK` and `externalUrl`, map the Shopee variation to it, and the
buyer receives the link in the portal after verification. One link per product is enough when the shop
issues the same template, and insufficient when each buyer needs a unique link, which is the case for
stamping a specific PDF. That gap is the reason the automation above is worth finishing.

## Environment

The credentials file is read by the probe only, never by the API or the worker, and it is not committed.
If automation is enabled later, the credentials belong in the settings table encrypted with
`APP_ENCRYPTION_KEY`, the same way Shopee tokens are, and the session token must never be logged.
