-- ============================================================
-- Grants — close what anon was left holding
--
-- Found on 2026-10-18. RLS has been on for these tables since 0002, so anon
-- could read nothing through them — but the table grants themselves were
-- still the dashboard's defaults (anon = arwdDxtm), which means one policy
-- written `using (true)` by mistake, or RLS switched off for a debug session,
-- and the publishable key reads and rewrites the user's finances. The grant is
-- the second lock; it should be locked.
--
--   1. anon loses every privilege on the four finance tables that still had
--      them (cc_transactions, cc_redemptions, net_worth_entries,
--      user_settings), and — as a sweep — on every table, view and function
--      in public. Nothing the app calls is anonymous: the login page talks to
--      GoTrue, not PostgREST. The four PUBLIC/anon EXECUTE grants that
--      existed were on trigger functions (touch_updated_at, food_items_touch,
--      cc_follow_merge, ledger_link_people_from_note), which never need
--      EXECUTE to fire.
--   2. Every function in schema health loses EXECUTE for PUBLIC, anon and
--      authenticated. They were unreachable anyway (the schema grants USAGE
--      only to postgres and service_role), but a default PUBLIC EXECUTE is
--      one `grant usage` away from exposing helpers that take a bare
--      p_user_id. The public.health_* / life_* wrappers are SECURITY DEFINER,
--      run as postgres, and keep working; service_role keeps EXECUTE.
--   3. Default privileges for objects postgres creates in public stop
--      granting anon anything. authenticated and service_role keep their
--      default grants, so a function added by a later migration is still
--      callable by the signed-in app without a per-function grant — exactly
--      as before.
--
-- Not changed: the supabase_admin default ACLs in public (they also grant
-- anon). Only supabase_admin can alter its own defaults, and it creates
-- nothing in public in this project.
--
-- Run order: any time after 0018. Idempotent.
-- ============================================================

-- 1. anon on public
revoke all on table public.cc_transactions, public.cc_redemptions,
                    public.net_worth_entries, public.user_settings from anon;
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from public, anon;

-- authenticated and service_role keep their explicit per-function grants. No
-- blanket re-grant here: public.health_ingest is deliberately service_role only.

-- 2. health functions
revoke execute on all functions in schema health from public, anon, authenticated;
grant  execute on all functions in schema health to service_role;

-- 3. defaults for what postgres creates next in public
alter default privileges for role postgres in schema public revoke all on tables    from anon, public;
alter default privileges for role postgres in schema public revoke all on sequences from anon, public;
alter default privileges for role postgres in schema public revoke all on functions from anon, public;
alter default privileges for role postgres in schema public grant execute on functions to authenticated, service_role;

-- And the same for health, where nothing should default to PUBLIC.
alter default privileges for role postgres in schema health revoke execute on functions from public;

select json_build_object(
  'anon_table_grants', (select count(*) from information_schema.role_table_grants
                         where table_schema = 'public' and grantee = 'anon'),
  'anon_or_public_exec_public', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                  where n.nspname = 'public'
                                    and (has_function_privilege('anon', p.oid, 'execute'))),
  'health_exec_by_authenticated', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                    where n.nspname = 'health'
                                      and has_function_privilege('authenticated', p.oid, 'execute')));
