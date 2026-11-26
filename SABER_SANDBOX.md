# Saber Money sandbox integration

This connector sends signed requests to Saber's actual sandbox. It runs
separately from INRSettle settlement execution. All workspace payments still
use the persistent simulator. Local tests validate the published protocol;
they do not establish that Saber has accepted the merchant integration.

## Access and configuration

1. Request merchant sandbox access at <https://saber.money/contact>.
2. Generate the **sandbox** Client ID/API Key and Client Secret in their
   dashboard. They differ from INRSettle's workspace test key.
3. Run `pnpm saber:configure`, then fill `SABER_CLIENT_ID` and
   `SABER_CLIENT_SECRET` in `.env.saber`. The empty template is owner-only,
   git-ignored and never overwritten. Secret-manager environment variables
   are also supported. Never use production credentials here.
4. Run `pnpm saber:status`. Keys present means `configured_untested`, not
   connected. Restart `pnpm sandbox` to update the workspace indicator.

Only `https://api.sandbox.saber.money` is used; custom hosts and production
configuration are rejected. Requests use HMAC-SHA256 with `X-Api-Key`,
`X-Signature`, `X-Timestamp`, `X-Request-Id` and, for user calls, `X-User-Id`.
The client secret is never transmitted. Redirects are refused, responses are
bounded and calls time out. Provider response bodies are not echoed in errors.

## Operator test workflow

Use Saber-approved **synthetic** fixtures. Do not submit actual KYC or bank
details through this local harness. Save plan files under ignored `.sandbox/`.
Every mutation requires a stable `--operation` reference for the same intent.
Replace example UUIDs with your actual sandbox identities.

Create `.sandbox/saber-user.json` with a new UUID and an email/phone accepted
by the Saber sandbox (the examples below do not imply a pre-approved fixture):

```json
{
  "syntheticSandboxData": true,
  "email": "sandbox-user@example.com",
  "phone": "+919876543210",
  "userId": "550e8400-e29b-41d4-a716-446655440000",
  "reference": "inrsettle-user-1"
}
```

```sh
pnpm saber user-create --plan .sandbox/saber-user.json --operation user-1
```

Save the returned UUID in `SABER_TEST_USER_ID` in `.env.saber`, then:

```sh
pnpm saber:check
pnpm saber kyc-url
```

`check` performs a signed read-only lookup and verifies the returned identity.
Only success prints `authenticated`. The generated KYC URL is sensitive and
valid for ten minutes; open it privately. A widget redirect does not prove KYC
passed: `check` must report `kyc_status: Verified`. If test KYC needs manual
approval, request it from Saber. This connector cannot fake approval.

For `.sandbox/saber-bank.json`, use `syntheticSandboxData: true`, `userId`,
`accountNumber` and `ifsc`. The bank-link API returns the new bank UUID:

```sh
pnpm saber bank-add --plan .sandbox/saber-bank.json --operation bank-1
pnpm saber bank --bank BANK_UUID
```

To approve a pending **test** bank, a plan needs `syntheticSandboxData: true`,
`userId` and `bankId`:

```sh
pnpm saber bank-approve --plan .sandbox/saber-approve.json --operation approve-1
```

Saber can credit a dummy crypto balance without an on-chain transfer. A funding
plan needs `syntheticSandboxData: true`, `userId`, `symbol` (`USDT` or `USDC`),
`amount` (decimal string) and a merchant-enabled `network`. For Pool Sell,
**fund the merchant pool user supplied by Saber**, not the recipient wallet.

```sh
pnpm saber fund-test --plan .sandbox/saber-pool-funding.json --operation fund-1
pnpm saber balance --user POOL_USER_UUID --symbol USDT
pnpm saber quote --amount 2000.00 --side fiat --symbol USDT
```

The quote is informational. Pool Sell executes at market rate. The API
reference lists `quote_id`, but Available Flows says Pool Sell locking is a
future feature. Confirm this inconsistency with Saber before promising a
locked rate or exact net INR. The connector does not rely on that field.

Review a `.sandbox/saber-sell.json` plan:

```json
{
  "syntheticSandboxData": true,
  "acknowledgeMarketRate": true,
  "firstParty": true,
  "userId": "550e8400-e29b-41d4-a716-446655440000",
  "bankId": "d6b32285-d653-4d10-9c0c-ad0aee12e1c0",
  "symbol": "USDT",
  "cryptoAmount": "25.000001",
  "reference": "07825d5d-1879-4cc7-a87f-f5ed45ee391b"
}
```

Set `firstParty` to the actual test flow agreed with Saber. It does not bypass
third-party payout conditions. The client `reference` UUID is correlation,
not a proven provider idempotency key.

```sh
pnpm saber sell --plan .sandbox/saber-sell.json --operation sell-1
pnpm saber transaction --transaction RETURNED_TRANSACTION_UUID
```

The sell command first pulls user and bank state and requires identity-matched
`Verified`/`APPROVED` records. Monetary inputs are decimal strings, emitted as
exact JSON number tokens; provider number tokens are preserved as strings.
The wallet-balance route remains `/api/v1/wallet/balance` even in the v2
reference, and is intentionally not rewritten to a guessed v2 path.

## Lost responses and retries

Mutations reserve and fsync a journal entry **before** HTTP, under
`.sandbox/saber-operations/<merchant-hash>/`. Successful acknowledgements are
atomically persisted. Repeating the same operation replays the saved result;
different terms are refused. Concurrent calls share the same reservation.

Errors, malformed acknowledgements and crashes leave an uncertain operation.
No second submission is sent. Preserve the journal across restarts/deploys.
Do not delete records, change operation IDs or switch machines to retry a
payment. A multi-machine deployment needs a shared transactional store first.
This local guard is not a claim of server-side idempotency.

Locate an uncertain transaction through the Saber dashboard/support, using
the client reference, and compare user, bank, amounts and time. Once the actual
transaction ID is known, use the read-only transaction command. Public docs
do not establish reference lookup or deduplication retention guarantees.

## Remaining acceptance gates

- Verify merchant access and this flow against the actual Saber sandbox.
- Agree permitted business recipients and first/third-party payout model.
- Verify exact net INR, fees/tax, rounding and quote locking. External Sell
  may be a candidate; this connector implements only Pool Sell.
- Establish provider duplicate prevention and reference-based recovery.
- Obtain webhook signing canonicalization, headers, replay rules, event IDs
  and agreed signature vectors. Public docs mention a Webhook Key/Secret but
  do not specify a complete verifier; no Saber webhook is trusted here.
- Verify UTR and independent net-bank-credit evidence. `COMPLETED` stays
  `provider_completed`; it does not finalize an INRSettle settlement. Crypto
  refunds remain distinct from bank returns. New statuses stay unsupported.

The authenticated `/workspace/saber` route only exposes setup state and public
links. Keys are never returned. No automatic switch of funding, quote, payout,
receipt or reconciliation providers happens when credentials are entered.
See [partner acceptance](reference/partner/README.md) before a live pilot.

## Verification and official sources

`pnpm test:saber` covers fixed independent HMAC vectors, widget URLs, endpoint
contracts, lossless decimals, errors, concurrency, lost replies, persisted
acknowledgements, corruption/restarts, credential isolation and KYC/bank guards.
Run `pnpm run verify` for the complete repository checks.

Protocol reviewed on 2026-10-19 against the official sources:

- [Authentication](https://guides.saber.money/getting-started/auth)
- [INR flow](https://guides.saber.money/offramp/currencies/inr)
- [Available flows](https://guides.saber.money/offramp/available-flows)
- [Pool Sell](https://guides.saber.money/api-reference/offramp/from-pool-wallet/create-pool-sell-transaction)
- [Wallet balance](https://guides.saber.money/api-reference/wallet-operations/get-wallet-balance)
- [Test funding](https://guides.saber.money/api-reference/wallet-operations/crypto-deposit/add-dummy-balance-sandbox-only)
- [Test bank approval](https://guides.saber.money/api-reference/bank-account-operations/approve-bank-account-sandbox-only)
- [Webhook configuration](https://guides.saber.money/client/dashboard/webhooks)
- [Lifecycle](https://guides.saber.money/offramp/operations/lifecycle)
