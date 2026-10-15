-- Rows created with `autoProvision: false` before the deferred marker existed
-- are pending with no provision job on purpose. Mark every pending eager-tier
-- row so the orphaned-pending sweep cannot fail one. The marker only gates the
-- sweep; a row that has a provision job is not changed by it.
UPDATE agent_sandboxes
SET agent_config = COALESCE(agent_config, '{}'::jsonb) || '{"__agentProvisioningDeferred": true}'::jsonb
WHERE status = 'pending'
  AND pool_status IS NULL
  AND execution_tier IN ('dedicated-always', 'custom');
