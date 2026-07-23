-- Increase hosted runtime concurrency now that runtime cleanup and inline limit UX are stronger.

update billing_plans
set max_active_hosted_runtimes = case id
    when 'starter' then 5
    when 'pro' then 20
    when 'scale' then 50
    else max_active_hosted_runtimes
  end,
  updated_at = now()
where id in ('starter', 'pro', 'scale');
