-- ============================================================================
-- 0015 — corrections from the Stage 8 archive review
--
-- Three changes, each closing a gap the review found rather than adding
-- anything new:
--
--   1. A deleted webhook endpoint no longer takes its delivery history with it.
--   2. `pending_outbox_scopes` becomes a worker capability, not an application
--      one.
--   3. `webhook_endpoints` gets the soft-delete shape the rest of the system
--      already uses for anything money was sent against.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Delivery history outlives the endpoint it was sent to
-- ---------------------------------------------------------------------------
--
-- `webhook_deliveries.endpoint_id` cascaded from `webhook_endpoints`, so
-- deleting an endpoint erased every delivery and every attempt made to it. That
-- is the wrong half of the system to optimise for tidiness: `§ 10.3` promises
-- that *"every attempt, its response code and its body are visible in
-- Developers → Event logs"*, and the moment a customer most needs that history
-- is right after they have torn down the endpoint that was failing.
--
-- The same reasoning the schema already applies to a beneficiary — disabled,
-- never removed, because a settlement was sent against it — applies here: an
-- endpoint is evidence of what we tried to tell somebody.
ALTER TABLE webhook_deliveries
  DROP CONSTRAINT webhook_deliveries_endpoint_id_fkey;
ALTER TABLE webhook_deliveries
  ADD CONSTRAINT webhook_deliveries_endpoint_id_fkey
  FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE NO ACTION;

-- And `DELETE` is not granted at all, so "delete an endpoint" cannot become a
-- real delete by somebody reaching past the service. Disabling is the only
-- shape available.
REVOKE DELETE ON webhook_endpoints  FROM inrsettle_app;
REVOKE DELETE ON webhook_deliveries FROM inrsettle_app;

-- A disabled endpoint is one a customer removed. It keeps its id, so its
-- deliveries still resolve to something with a URL a customer recognises, and
-- it is never selected for a new delivery.
ALTER TABLE webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_status_check;
ALTER TABLE webhook_endpoints
  ADD CONSTRAINT webhook_endpoints_status_check
  CHECK (status IN ('enabled', 'disabled', 'circuit_open', 'deleted'));

-- A deleted endpoint is disabled and stamped, so "when did this stop
-- receiving" is answerable from the row rather than inferred from a gap in the
-- delivery log.
ALTER TABLE webhook_endpoints
  ADD CONSTRAINT webhook_endpoints_deleted_is_stamped
  CHECK (status <> 'deleted' OR disabled_at IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 2. The outbox scope lookup belongs to the worker
-- ---------------------------------------------------------------------------
--
-- `pending_outbox_scopes` answers "which tenants have deliveries waiting". Only
-- the drain needs that, and the drain runs in `worker` — so the application
-- role, which is what a public-facing `api` process authenticates as, has no
-- business holding it. `ARCHITECTURE.md § 3` puts every piece of state
-- progression in `worker`; this grant now says the same thing.
--
-- The scoped drain itself is unchanged and stays under ordinary RLS: the worker
-- learns *which* scopes have work, then opens a normal tenant transaction and
-- sees exactly what that tenant's policies allow.
REVOKE EXECUTE ON FUNCTION pending_outbox_scopes(integer) FROM inrsettle_app;
GRANT  EXECUTE ON FUNCTION pending_outbox_scopes(integer) TO inrsettle_worker;
