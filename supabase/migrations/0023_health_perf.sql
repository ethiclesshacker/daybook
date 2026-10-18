-- ============================================================
-- Health — read days from a rollup, not from samples
--
-- Measured on 2026-10-18 (180k rows in health.metrics, +1.1k a day, one user):
--
--   health_catalog          7.4 s cold, 1.8 s mean   counted every sample, every call
--   health_overview  30 d   0.85 s
--   health_overview  90 d   2.8 s
--   life_days        30 d   0.44 s                    (calls health_overview)
--
-- The (user_id, type, start_at) index was already being used. The scan was
-- not the cost: reading the 29,781 samples behind a 30-day overview takes
-- 28 ms. What cost 1.4 s was everything done per sample after it was read —
-- `start_at at time zone timezone` on each row, the CTE materialising the
-- jsonb metadata, and grouping thirty thousand rows into 180 numbers, on every
-- page load, to get the same 180 numbers as last time. A day that is over does
-- not change, and HealthKit only ever sends a few hundred new samples at a time.
--
-- So the day is computed once, when the samples arrive:
--
--   health.metric_days   one row per (user, type, local day, kind, unit, source)
--                        holding count / sum / min / max / latest / first / last.
--                        ~15 types × ~120 days × a few sources ≈ 10k rows.
--
--   kind                 raw          a HealthKit sample (metadata.aggregation is null)
--                        sum_full     a backfilled daily_sum spanning ≥ 23 h
--                        sum_partial  a backfilled daily_sum spanning < 23 h
--                        other        anything else (daily_average backfill rows):
--                                     counted in the catalog, read by nothing else —
--                                     exactly as before
--
-- It is kept current by statement-level triggers on health.metrics, so every
-- writer — health_ingest, a deletion tombstone, a fix typed in the SQL editor —
-- maintains it, and health_ingest itself is unchanged. Each statement
-- recomputes only the (type, day) pairs its rows touched, from the
-- (user_id, type, start_at) index: a typical sync batch of 20–800 samples
-- touches a handful of pairs. A per-user advisory lock serialises two syncs
-- racing on the same day, so the second recomputes after the first commits
-- and neither overwrites the other with a total that lacks its rows.
--
-- A group whose samples have all been deleted is zeroed (n = 0), not removed;
-- readers ignore n = 0.
--
-- The readers keep their signatures and output exactly:
--   health.daily_cumulative  same tiers: full aggregate, then the largest
--                            single-source raw sum, then a partial aggregate
--   health.daily_discrete    min / avg / max / latest over raw samples, plus
--                            the ledger's weights (0011) — unchanged union
--   public.health_catalog    per-type rows / first_day / last_day / unit from
--                            the rollup instead of a full scan
-- health.nights, health_intraday and health.activity_feed still read samples:
-- they need the samples themselves (sleep intervals, buckets inside one day),
-- and they were already 10–15 ms.
--
-- Run order: after 0011_life_api.sql (which owns the current daily_discrete).
-- Re-runnable: the backfill at the bottom rebuilds every group.
-- ============================================================


begin;

-- Writes to the samples wait (a few seconds) while the triggers go in and the
-- backfill runs, so no sync can land between "trigger exists" and "rollup
-- built" and be missed by both.
lock table health.metrics in share row exclusive mode;

-- ────────────────────────────────────────────────────────────
-- The rollup
-- ────────────────────────────────────────────────────────────
create table if not exists health.metric_days (
  user_id         uuid             not null,
  type            text             not null,
  day             date             not null,   -- (start_at at time zone metrics.timezone)::date
  kind            text             not null check (kind in ('raw', 'sum_full', 'sum_partial', 'other')),
  unit            text             not null default '',   -- '' stands for null
  source_key      text             not null default '',   -- coalesce(source_bundle_id, source_name); '' for null
  n               bigint           not null,
  total           double precision,
  min_value       double precision,
  max_value       double precision,
  latest_value    double precision,
  first_at        timestamptz,
  last_at         timestamptz,
  source_name_max text,
  updated_at      timestamptz      not null default now(),
  primary key (user_id, type, day, kind, unit, source_key)
);

-- Unexposed, like the rest of the schema: only the SECURITY DEFINER readers
-- in public touch it.
revoke all on health.metric_days from public, anon, authenticated;
grant select on health.metric_days to service_role;

create index if not exists metric_days_user_day on health.metric_days (user_id, day);


-- ────────────────────────────────────────────────────────────
-- Recompute a set of (user, type, day) groups from the samples
-- ────────────────────────────────────────────────────────────
create or replace function health.refresh_metric_days(p_users uuid[], p_types text[], p_days date[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  if p_users is null or cardinality(p_users) = 0 then return; end if;

  -- Two syncs for the same user must not both recompute a day from snapshots
  -- that lack each other's rows. Sorted, so two users never deadlock.
  for v_user in select distinct u from unnest(p_users) u order by 1 loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('health.metric_days:' || v_user::text, 0));
  end loop;

  with keys as (
    select distinct k.user_id, k.type, k.day
      from unnest(p_users, p_types, p_days) as k(user_id, type, day)
     where k.user_id is not null and k.type is not null and k.day is not null
  ),
  fresh as (
    select m.user_id, m.type, k.day,
           case
             when m.metadata ->> 'aggregation' is null then 'raw'
             when m.metadata ->> 'aggregation' = 'daily_sum' and m.end_at - m.start_at >= interval '23 hours' then 'sum_full'
             when m.metadata ->> 'aggregation' = 'daily_sum' and m.end_at - m.start_at <  interval '23 hours' then 'sum_partial'
             else 'other'
           end as kind,
           coalesce(m.unit, '') as unit,
           coalesce(m.source_bundle_id, m.source_name, '') as source_key,
           count(*) as n, sum(m.value) as total, min(m.value) as min_value, max(m.value) as max_value,
           (array_agg(m.value order by m.start_at desc))[1] as latest_value,
           min(m.start_at) as first_at, max(m.start_at) as last_at,
           max(m.source_name) as source_name_max
      from keys k
      join health.metrics m
        on m.user_id = k.user_id and m.type = k.type
       and m.start_at >= k.day::timestamp - interval '14 hours'
       and m.start_at <  (k.day + 1)::timestamp + interval '14 hours'
     where (m.start_at at time zone m.timezone)::date = k.day
     group by m.user_id, m.type, k.day, 4, 5, 6
  ),
  zeroed as (
    update health.metric_days d
       set n = 0, total = null, min_value = null, max_value = null, latest_value = null,
           first_at = null, last_at = null, source_name_max = null, updated_at = now()
      from keys k
     where d.user_id = k.user_id and d.type = k.type and d.day = k.day
       and d.n <> 0
       and not exists (select 1 from fresh f
                        where f.user_id = d.user_id and f.type = d.type and f.day = d.day
                          and f.kind = d.kind and f.unit = d.unit and f.source_key = d.source_key)
    returning 1
  )
  insert into health.metric_days as d (user_id, type, day, kind, unit, source_key, n, total, min_value,
                                       max_value, latest_value, first_at, last_at, source_name_max, updated_at)
  select f.user_id, f.type, f.day, f.kind, f.unit, f.source_key, f.n, f.total, f.min_value,
         f.max_value, f.latest_value, f.first_at, f.last_at, f.source_name_max, now()
    from fresh f
  on conflict (user_id, type, day, kind, unit, source_key) do update set
    n = excluded.n, total = excluded.total, min_value = excluded.min_value, max_value = excluded.max_value,
    latest_value = excluded.latest_value, first_at = excluded.first_at, last_at = excluded.last_at,
    source_name_max = excluded.source_name_max, updated_at = now();
end;
$$;

revoke all on function health.refresh_metric_days(uuid[], text[], date[]) from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────
-- Keep it current: one trigger per event, because a transition table names
-- only the rows its event has (no OLD TABLE on insert, no NEW TABLE on delete).
-- An upsert fires both the insert and the update trigger, each with its rows.
-- ────────────────────────────────────────────────────────────
create or replace function health.metrics_rollup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_users uuid[]; v_types text[]; v_days date[];
begin
  if tg_op = 'INSERT' then
    select array_agg(k.user_id), array_agg(k.type), array_agg(k.day) into v_users, v_types, v_days
      from (select distinct r.user_id, r.type, (r.start_at at time zone r.timezone)::date as day from new_rows r) k;
  elsif tg_op = 'UPDATE' then
    select array_agg(k.user_id), array_agg(k.type), array_agg(k.day) into v_users, v_types, v_days
      from (select r.user_id, r.type, (r.start_at at time zone r.timezone)::date as day from new_rows r
            union
            select r.user_id, r.type, (r.start_at at time zone r.timezone)::date from old_rows r) k;
  else
    select array_agg(k.user_id), array_agg(k.type), array_agg(k.day) into v_users, v_types, v_days
      from (select distinct r.user_id, r.type, (r.start_at at time zone r.timezone)::date as day from old_rows r) k;
  end if;

  perform health.refresh_metric_days(v_users, v_types, v_days);
  return null;
end;
$$;

revoke all on function health.metrics_rollup() from public, anon, authenticated;

drop trigger if exists metrics_rollup_ins on health.metrics;
drop trigger if exists metrics_rollup_upd on health.metrics;
drop trigger if exists metrics_rollup_del on health.metrics;
create trigger metrics_rollup_ins after insert on health.metrics
  referencing new table as new_rows for each statement execute function health.metrics_rollup();
create trigger metrics_rollup_upd after update on health.metrics
  referencing old table as old_rows new table as new_rows for each statement execute function health.metrics_rollup();
create trigger metrics_rollup_del after delete on health.metrics
  referencing old table as old_rows for each statement execute function health.metrics_rollup();


-- ────────────────────────────────────────────────────────────
-- Readers
-- ────────────────────────────────────────────────────────────

-- Same tiers and tie-break as 0010: per day and type, a full-day HealthKit
-- aggregate beats raw samples, which beat a partial aggregate; within a tier
-- the larger value wins (so phone + Watch is never summed — the bigger
-- single-source total is the day).
create or replace function health.daily_cumulative(p_user_id uuid, p_from date, p_to date, p_types text[])
returns table(day date, type text, unit text, value double precision, basis text, source_key text)
language sql stable
set search_path = ''
as $$
  select distinct on (d.day, d.type)
         d.day, d.type, nullif(d.unit, ''),
         case when d.kind = 'raw' then d.total else d.max_value end,
         case d.kind when 'sum_full'    then 'healthkit_aggregate'
                     when 'sum_partial' then 'healthkit_aggregate_partial'
                     else d.source_name_max end,
         case when d.kind = 'raw' then nullif(d.source_key, '') end
    from health.metric_days d
   where d.user_id = p_user_id
     and d.type = any (p_types)
     and d.day between p_from and p_to
     and d.kind in ('raw', 'sum_full', 'sum_partial')
     and d.n > 0
   order by d.day, d.type,
            case d.kind when 'sum_full' then 1 when 'raw' then 2 else 3 end,
            case when d.kind = 'raw' then d.total else d.max_value end desc;
$$;

-- Raw samples only (backfilled daily_average rows stay invisible, as before),
-- unioned with the ledger's weights exactly as 0011 does.
create or replace function health.daily_discrete(p_user_id uuid, p_from date, p_to date, p_types text[])
returns table(day date, type text, unit text, n bigint, min_value double precision, avg_value double precision,
              max_value double precision, latest_value double precision)
language sql stable
set search_path = ''
as $$
  with rows as (
    select d.day, d.type, nullif(d.unit, '') as unit, d.n, d.total, d.min_value, d.max_value,
           d.latest_value, d.last_at
      from health.metric_days d
     where d.user_id = p_user_id
       and d.type = any (p_types)
       and d.kind = 'raw'
       and d.n > 0
       and d.day between p_from and p_to
    union all
    select w.day, 'body_mass', 'kg', 1, w.kg, w.kg, w.kg, w.kg, w.start_at
      from health.ledger_weights(p_user_id, p_from, p_to) w
     where 'body_mass' = any (p_types)
       and w.day between p_from and p_to
  )
  select r.day, r.type, max(r.unit), sum(r.n)::bigint, min(r.min_value), sum(r.total) / sum(r.n),
         max(r.max_value), (array_agg(r.latest_value order by r.last_at desc))[1]
    from rows r
   group by r.day, r.type;
$$;

-- Same rows as 0011. The zone is looked up once per call rather than once per
-- measurement row (ledger_setting_text is a user_settings index probe each time).
create or replace function health.ledger_weights(p_user_id uuid, p_from date, p_to date)
returns table(start_at timestamptz, day date, kg double precision)
language sql stable
set search_path = ''
as $$
  with tz as (select public.ledger_setting_text(p_user_id, 'ledger_timezone', 'Asia/Kolkata') as name)
  select e.occurred_at,
         (e.occurred_at at time zone tz.name)::date,
         w.value * case when lower(coalesce(e.data ->> 'unit', 'kg')) in ('lb', 'lbs') then 0.45359237 else 1 end
    from tz, public.events e
   -- Two shapes exist: {metric:'weight', value} from log_measurement, and an
   -- older {weight} written before that tool fixed the shape.
   cross join lateral (
     select case
       when e.data ->> 'metric' = 'weight' and (e.data ->> 'value') ~ '^[0-9]+(\.[0-9]+)?$' then (e.data ->> 'value')::double precision
       when (e.data ->> 'weight') ~ '^[0-9]+(\.[0-9]+)?$' then (e.data ->> 'weight')::double precision
     end as value) w
   where e.user_id = p_user_id
     and e.type = 'health' and e.subtype = 'measurement'
     and e.status <> 'dismissed'
     and w.value is not null
     and e.occurred_at >= p_from::timestamp - interval '14 hours'
     and e.occurred_at <  (p_to + 1)::timestamp + interval '14 hours';
$$;

create or replace function public.health_catalog(p_user_id uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_user uuid := health.reader(p_user_id);
  v_out  jsonb;
begin
  select jsonb_build_object(
    'last_sync_at', (select max(b.received_at) from health.sync_batches b where b.user_id = v_user),
    'types', coalesce((
      select jsonb_agg(jsonb_build_object(
               'type', t.type, 'unit', t.unit, 'rows', t.n, 'first_day', t.first_day, 'last_day', t.last_day,
               'kind', case when health.is_cumulative(t.type) then 'cumulative' else 'discrete' end) order by t.n desc)
        from (select d.type, max(nullif(d.unit, '')) as unit, sum(d.n) as n,
                     min(d.first_at)::date as first_day, max(d.last_at)::date as last_day
                from health.metric_days d
               where d.user_id = v_user and d.n > 0
               group by d.type) t), '[]'::jsonb),
    'workouts', (select count(*) from health.workouts w where w.user_id = v_user))
  into v_out;
  return v_out;
end;
$$;


-- ────────────────────────────────────────────────────────────
-- Backfill: every (user, type, day) that has samples. Re-running rebuilds.
-- ────────────────────────────────────────────────────────────
select health.refresh_metric_days(array_agg(k.user_id), array_agg(k.type), array_agg(k.day))
  from (select distinct m.user_id, m.type, (m.start_at at time zone m.timezone)::date as day
          from health.metrics m) k;

commit;

analyze health.metric_days;

select json_build_object('groups', count(*), 'samples', sum(n)) from health.metric_days;
