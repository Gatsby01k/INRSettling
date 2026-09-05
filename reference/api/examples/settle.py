# The worked flow from API_CONTRACT.md § 9, end to end, in Python.
#
# minor_units is a string on the way in and on the way out. Python integers
# would survive the round trip, but the string is what the contract sends, and
# parsing it as one keeps your code correct against clients that would not.

import json
import os
import time
import urllib.request

API = "https://api.inrsettle.com/v1"
KEY = os.environ["INRSETTLE_KEY"]  # sk_test_... for sandbox


def call(method, path, body=None, idempotency_key=None):
    headers = {
        "Authorization": "Bearer " + KEY,
        "Content-Type": "application/json",
    }
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key

    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as e:
        error = json.loads(e.read())["error"]
        # Every error carries a code you can branch on, a message you can show,
        # and a request_id worth sending us.
        raise RuntimeError("{type}/{code}: {message} {detail} ({request_id})".format(
            detail=error.get("detail", ""), **{
                k: error[k] for k in ("type", "code", "message", "request_id")
            }))


def settle_five_million_rupees(beneficiary_id):
    quote = call("POST", "/quotes", {
        "direction": "recipient_first",
        "recipient_amount": {"currency": "INR", "minor_units": "500000000"},
        "funding_currency": "USDT",
        "beneficiary_id": beneficiary_id,
    })

    # One key per logical operation, reused on every retry of that operation.
    key = "contractor-sept-0142"

    # 202, not 201: preflight runs asynchronously, so "status" comes back None.
    # None is the absence of a status while preflight decides, not a sixth one.
    settlement = call("POST", "/settlements", {
        "beneficiary_id": beneficiary_id,
        "recipient_amount": {"currency": "INR", "minor_units": "500000000"},
        "purpose_code": "SOFTWARE_SERVICES",
        "funding_currency": "USDT",
        "quote_id": quote["id"],
        "external_reference": "INVOICE-2026-0914",
    }, idempotency_key=key)

    # In production, subscribe to settlement.created rather than polling. This
    # is the polling form because an example that opens a webhook receiver
    # first is an example nobody can run.
    status = settlement["status"]
    while status is None:
        time.sleep(1)
        status = call("GET", "/settlements/" + settlement["id"])["status"]

    # "action_required" is not a failure — "requirements" says what is missing,
    # and the settlement waits. Authorizing it now would be a 409.
    if status != "ready":
        return settlement["id"]

    call("POST", "/settlements/{}/authorize".format(settlement["id"]),
         idempotency_key=key + "-auth")

    # "settled" does not mean "and it will stay that way": a credited payout can
    # still be returned. Subscribe to settlement.return_confirmed, or filter
    # with ?has_confirmed_return=true.
    return settlement["id"]
