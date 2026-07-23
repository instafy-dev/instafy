-- Align hosted-runtime concurrency with what each plan's credit budget can
-- actually fund (2026-07-11 runtime review). A standard machine burns
-- ~97.5 credits/hour, so the old caps (5/20/50) sold parallelism no budget
-- could pay for — and the platform-wide admission cap is 8, so 20/50 were
-- undeliverable twice over.
--
--   starter:  200/day ≈ 2h of ONE machine            → 1
--   pro:     2000/day ≈ 3 machines for ~7h           → 3
--   scale:  10000/day ≈ 8 machines for ~13h          → 8 (= platform cap)

update billing_plans
set max_active_hosted_runtimes = case id
    when 'starter' then 1
    when 'pro' then 3
    when 'scale' then 8
    else max_active_hosted_runtimes
  end,
  updated_at = now()
where id in ('starter', 'pro', 'scale');
