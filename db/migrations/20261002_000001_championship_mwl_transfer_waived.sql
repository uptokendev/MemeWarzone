-- Quarterly Championship: an MWL month's bonus transfer can be WAIVED (founder decision 2026-10-02:
-- Q3 2026 closes without placement bonuses, because no bonus policy was ever set). A waived transfer
-- credits nothing and no longer blocks closing its quarter. It is the explicit opposite of
-- 'pending_policy' (waiting) and 'applied' (credited under a policy version).
ALTER TABLE public.arena_championship_mwl_transfers
  DROP CONSTRAINT IF EXISTS arena_championship_mwl_transfers_status_check;
ALTER TABLE public.arena_championship_mwl_transfers
  ADD CONSTRAINT arena_championship_mwl_transfers_status_check
  CHECK (status IN ('pending_policy', 'applied', 'waived'));

ALTER TABLE public.arena_championship_mwl_transfers
  DROP CONSTRAINT IF EXISTS arena_championship_mwl_transfers_applied_check;
ALTER TABLE public.arena_championship_mwl_transfers
  ADD CONSTRAINT arena_championship_mwl_transfers_applied_check CHECK (
    (status = 'pending_policy' AND applied_at IS NULL)
    OR (status = 'applied' AND applied_at IS NOT NULL AND policy_version IS NOT NULL)
    OR (status = 'waived' AND applied_at IS NOT NULL AND policy_version IS NULL)
  );
