# apps/api — the public /v1 API

API-key auth only; no session cookies are accepted on this host.

Holds **no** payout-provider credentials and **no** payout-destination
decryption capability (SECURITY.md § 8). It records intent; `worker` executes.

Arrives in Stage 8.
