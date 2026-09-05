#!/usr/bin/env bash
# The worked flow from API_CONTRACT.md § 9, end to end, in curl.
#
# Every value below is a sandbox value. `sk_test_` keys address sandbox objects
# and cannot address live ones — a live id under a sandbox key is a 404, never a
# 403, because a wrong-environment key must not confirm that an object exists.
set -euo pipefail

: "${INRSETTLE_KEY:?export INRSETTLE_KEY=sk_test_...}"
API="https://api.inrsettle.com/v1"

# 1 — quote, recipient-first. You say what the beneficiary receives; the funding
#     side is derived, and every fee is itemised rather than folded into the rate.
curl -sS -X POST "$API/quotes" \
  -H "Authorization: Bearer $INRSETTLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "direction": "recipient_first",
        "recipient_amount": { "currency": "INR", "minor_units": "500000000" },
        "funding_currency": "USDT",
        "beneficiary_id": "ben_7Ld2ZxKp0Wq4"
      }'

# 2 — settlement. The Idempotency-Key is required here, and it is what makes a
#     retry safe: same key and same body replays the original response, same key
#     and a different body is a 409.
#
#     This returns 202, not 201, and the settlement comes back with
#     "status": null — preflight runs asynchronously, and null is the absence of
#     a status while it decides rather than a sixth one.
curl -sS -X POST "$API/settlements" \
  -H "Authorization: Bearer $INRSETTLE_KEY" \
  -H "Idempotency-Key: 6f2c1a90-contractor-sept-0142" \
  -H "Content-Type: application/json" \
  -d '{
        "beneficiary_id": "ben_7Ld2ZxKp0Wq4",
        "recipient_amount": { "currency": "INR", "minor_units": "500000000" },
        "purpose_code": "SOFTWARE_SERVICES",
        "funding_currency": "USDT",
        "quote_id": "qt_9Xm4Bv7NsLt2",
        "external_reference": "INVOICE-2026-0914"
      }'

# 3 — wait for preflight. Poll until `status` is non-null, or subscribe to
#     settlement.created and skip the polling. `ready` means authorize now;
#     `action_required` means `requirements` says what is missing.
until [ "$(curl -sS "$API/settlements/stl_2Rn8Kq5TzYw6" \
             -H "Authorization: Bearer $INRSETTLE_KEY" \
           | sed -n 's/.*"status":[ ]*"\([a-z_]*\)".*/\1/p')" = "ready" ]; do
  sleep 1
done

# 4 — authorize. This freezes the instruction; it does not make execution
#     irreversible. The settlement stays cancellable while `cancellable` is true.
curl -sS -X POST "$API/settlements/stl_2Rn8Kq5TzYw6/authorize" \
  -H "Authorization: Bearer $INRSETTLE_KEY" \
  -H "Idempotency-Key: 6f2c1a90-contractor-sept-0142-auth"

# 5 — receipt, once settled. 404 until then: a receipt that does not exist yet
#     is not an empty receipt.
curl -sS "$API/settlements/stl_2Rn8Kq5TzYw6/receipt" \
  -H "Authorization: Bearer $INRSETTLE_KEY"
