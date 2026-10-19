# First rail-partner acceptance record

Candidate flow: USDT → INR bank payout. Proposed counterparty: Saber Money.
This record is a checklist for joint validation, not a claim of partnership.

| Decision | Evidence needed | Status |
|---|---|---|
| Legal entity, permitted business recipients and third-party payouts | Written operating model; responsibilities for KYB, KYC/EDD, AML, purpose codes, retention and reporting | External confirmation required |
| Exact recipient INR | Working target-amount/locked-quote flow, all deductions, expiry, rounding and responsibility for differences | External confirmation required |
| Liquidity source | Pool funding ownership, timing, limits, withdrawals and relationship to INRSettle facility/drawdown/repayment | External confirmation required |
| Duplicate prevention | Same client reference on duplicate POST, retention period, body mismatch response, lookup after a lost creation response | External confirmation required |
| Provider identity | Stable mapping for merchant, user, bank instrument, quote and transaction; shared recipients across tenants | Contract test required |
| Trust | Agreed signature test vector, webhook event IDs, timestamp/replay rules, key rotation and versioned error/status mapping | Contract test required |
| Finality | Valid UTR, net credited amount/currency, report delivery and independent reconciliation evidence | Contract test required |
| Failure and return handling | Bank rejection, delayed outcome, refund versus post-credit return, partial/late returns and support responsibilities | Contract test required |
| Operating windows | Verified rail capabilities, holidays, limits, expected tail latency and escalation contacts | External confirmation required |
| Commercial terms | Partner pricing, applicable deductions, FX exposure, prefunding cost and margin per settlement | External confirmation required |

Internal acceptance before a limited live pilot:

- One approved flow and a versioned provider adapter pass contract tests.
- An uncertain submission never creates a second payout.
- A payout with a shortfall does not become settled.
- Signed/unverified, duplicate and reordered events behave as documented.
- A worker restart preserves submission identity, accounting and receipt hash.
- Reconciliation uses the agreed authoritative evidence.
- D-01/D-02 and actual purpose/document requirements are resolved.
- Separate credentials/KMS, backups, monitoring, incident ownership and restore/
  security drills are evidenced; pilot caps and stop criteria are agreed.

Materials to bring: a working sandbox URL, test key delivered securely, OpenAPI,
prose API reference, smoke command, the narrow customer use case, real demand/
volume estimates, proposed funds flow and the decision table above. Do not
present the simulator, sandbox prices or sample KYB record as live capabilities.
