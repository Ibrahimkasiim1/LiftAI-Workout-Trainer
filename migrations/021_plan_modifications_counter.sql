-- Migration 021: plan modifications counter
--
-- Free tier gets 3 permanent plan modifications (swap-permanent, shift schedule,
-- modify-plan-permanently) before being gated. Premium users are unlimited.
--
-- Backend tools increment this counter on success. Resetting the counter is
-- intentionally NOT automatic on subscribe — we let it persist so a user who
-- subscribes and later downgrades can't churn through 3 more edits per cycle.
-- If product wants a periodic reset (monthly), add a cron-driven UPDATE.

ALTER TABLE user_quotas
    ADD COLUMN IF NOT EXISTS plan_modifications_used INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN user_quotas.plan_modifications_used IS
    'Lifetime count of permanent plan modifications. Free tier capped at 3; premium unlimited.';
