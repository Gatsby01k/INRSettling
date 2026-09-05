# Verifying an INRSettle webhook — Python 3.8+
#
# Three rules, and each one is a vulnerability if you skip it:
#
#   1. Compare in constant time. `==` on a hex digest leaks the answer one byte
#      at a time to anyone who can send you requests and time them.
#   2. Reject a timestamp outside five minutes in EITHER direction. A stale
#      timestamp is exactly what a replay looks like; checking only the future
#      side leaves the replay window open forever.
#   3. Treat event["id"] as an idempotency key. Redelivery is expected, not a
#      fault, and events can arrive out of order — created_at orders them.
#
# For anything irreversible on your side, re-read the settlement over the API
# rather than trusting the payload alone.

import hashlib
import hmac
import time

TOLERANCE_SECONDS = 300


def verify_inrsettle_signature(raw_body, signature_header, secrets, now_seconds=None):
    """raw_body: bytes or str. secrets: one, or two during a rotation overlap."""
    if now_seconds is None:
        now_seconds = int(time.time())
    if isinstance(raw_body, bytes):
        raw_body = raw_body.decode("utf-8")

    timestamp = None
    presented = []
    for part in signature_header.split(","):
        key, _, value = part.partition("=")
        key, value = key.strip(), value.strip()
        if key == "t" and value.isdigit():
            timestamp = int(value)
        elif key == "v1" and all(c in "0123456789abcdefABCDEF" for c in value) and value:
            presented.append(value.lower())

    if timestamp is None or not presented:
        return False

    # Rule 2 — both directions.
    if abs(now_seconds - timestamp) > TOLERANCE_SECONDS:
        return False

    signed_payload = "{}.{}".format(timestamp, raw_body).encode("utf-8")
    for secret in secrets:
        expected = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
        for candidate in presented:
            # Rule 1 — constant time.
            if hmac.compare_digest(expected, candidate):
                return True
    return False


# Flask, for example. Note request.get_data(): the signature covers the raw body,
# so a JSON parser that has already re-serialised it will not verify.
#
#   @app.post("/webhooks/inrsettle")
#   def inrsettle_webhook():
#       ok = verify_inrsettle_signature(
#           request.get_data(),
#           request.headers.get("INRSettle-Signature", ""),
#           [os.environ["INRSETTLE_WEBHOOK_SECRET"]],
#       )
#       if not ok:
#           return "bad signature", 400
#       event = request.get_json()
#       if already_handled(event["id"]):   # rule 3
#           return "", 200
#       handle(event)
#       return "", 200
