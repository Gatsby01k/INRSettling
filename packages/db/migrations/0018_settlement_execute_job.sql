-- Execution is recorded in the same transaction as authorization/cancellation.
-- The runtime currently registers only sandbox adapters. This task does not
-- grant a principal permission to authorize or change settlement status.
INSERT INTO job_tasks(task_name, description) VALUES
  ('settlement.execute', 'Advance an already authorized settlement through the configured providers')
ON CONFLICT (task_name) DO NOTHING;
