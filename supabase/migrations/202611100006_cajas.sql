begin;

alter table public.profiles
  add column register_no smallint unique check (register_no is null or (register_no between 1 and 3 and role = 'cashier'));
alter table public.sales
  add column register_no smallint check (register_no between 1 and 3);

create index sales_register_day on public.sales(register_no, occurred_at) where register_no is not null;

create table public.register_closures (
  register_no smallint not null check (register_no between 1 and 3),
  business_day date not null,
  revision integer not null check (revision > 0),
  closed_at timestamptz not null default clock_timestamp(),
  closed_by uuid not null references public.profiles(id),
  cashier_name text not null,
  summary jsonb not null,
  primary key (register_no, business_day, revision)
);
alter table public.register_closures enable row level security;
revoke all on public.register_closures from public, anon, authenticated;

create function private.assign_sale_register() returns trigger
language plpgsql set search_path = ''
as $$
begin
  select register_no into new.register_no from public.profiles where id = new.cashier_id;
  if new.register_no is not null then
    perform pg_advisory_xact_lock(50423, new.register_no::integer);
  end if;
  return new;
end $$;

create trigger assign_sale_register before insert on public.sales
for each row execute function private.assign_sale_register();

create function private.lock_register_void() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.register_no is not null and new.fiscal_status = 'void' and old.fiscal_status <> 'void' then
    perform pg_advisory_xact_lock(50423, new.register_no::integer);
  end if;
  return new;
end $$;

create trigger lock_register_void before update of fiscal_status on public.sales
for each row execute function private.lock_register_void();

create function private.register_summary(box integer, report_day date)
returns jsonb language sql stable set search_path = ''
as $$
  with sales_day as (
    select s.id, s.total, s.discount, s.rate_id
    from public.sales s
    where s.register_no = box
      and s.occurred_at >= (report_day::timestamp at time zone 'America/Caracas')
      and s.occurred_at < ((report_day + 1)::timestamp at time zone 'America/Caracas')
      and s.fiscal_status <> 'void'
  ), totals as (
    select count(*) as sales, coalesce(sum(s.total), 0) as usd,
           sum(round(s.total * r.ves, 2)) as ves, sum(round(s.total * r.cop)) as cop,
           count(*) filter (where r.id is null) as without_rate,
           coalesce(sum(s.discount), 0) as discounts,
           coalesce(jsonb_agg(s.id order by s.id), '[]') as sale_ids
    from sales_day s left join public.exchange_rates r on r.id = s.rate_id
  ), products as (
    select i.product_id, i.name, sum(i.quantity) as units, sum(i.quantity * i.unit_price) as subtotal
    from sales_day s join public.sale_items i on i.sale_id = s.id
    group by i.product_id, i.name
  ), payments as (
    select p.currency, p.method, sum(p.amount - p.change_amount) as net
    from sales_day s join public.sale_payments p on p.sale_id = s.id
    group by p.currency, p.method
  )
  select jsonb_build_object(
    'sales', t.sales, 'usd', t.usd,
    'ves', case when t.without_rate = 0 then coalesce(t.ves, 0) end,
    'cop', case when t.without_rate = 0 then coalesce(t.cop, 0) end,
    'without_rate', t.without_rate, 'discounts', t.discounts, 'sale_ids', t.sale_ids,
    'units', coalesce((select sum(p.units) from products p), 0),
    'products', coalesce((select jsonb_agg(to_jsonb(p) order by p.name, p.product_id) from products p), '[]'),
    'payments', coalesce((select jsonb_agg(to_jsonb(p) order by p.currency, p.method) from payments p), '[]')
  ) from totals t;
$$;

create function public.register_day(report_day date)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  actor uuid := private.require_role();
  admin boolean := private.app_role() = 'admin';
begin
  if report_day is null or report_day > (current_timestamp at time zone 'America/Caracas')::date then
    raise exception 'Selecciona una fecha válida de cierre';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'register_no', b.no, 'username', p.username, 'summary', s.summary - 'sale_ids',
      'closure', case when c.revision is not null then jsonb_build_object(
        'revision', c.revision, 'closed_at', c.closed_at, 'cashier_name', c.cashier_name,
        'summary', c.summary - 'sale_ids'
      ) end,
      'changed', c.revision is not null and c.summary <> s.summary
    ) order by b.no)
    from generate_series(1, 3) as b(no)
    left join public.profiles p on p.register_no = b.no and p.active
    cross join lateral (select private.register_summary(b.no, report_day) as summary) s
    left join lateral (
      select revision, closed_at, cashier_name, summary
      from public.register_closures c
      where c.register_no = b.no and c.business_day = report_day
      order by revision desc limit 1
    ) c on true
    where admin or p.id = actor
  ), '[]'::jsonb);
end $$;

create function public.close_register(report_day date)
returns integer language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := private.require_role();
  box smallint;
  operator_name text;
  previous public.register_closures;
  snapshot jsonb;
begin
  if report_day is null or report_day > (current_timestamp at time zone 'America/Caracas')::date then
    raise exception 'Selecciona una fecha válida de cierre';
  end if;
  select p.register_no, p.username into box, operator_name
  from public.profiles p where p.id = actor and p.active and p.role = 'cashier';
  if box is null then raise exception 'Tu usuario debe tener una caja asignada'; end if;
  perform pg_advisory_xact_lock(50423, box::integer);
  snapshot := private.register_summary(box, report_day);
  select * into previous from public.register_closures c
  where c.register_no = box and c.business_day = report_day
  order by revision desc limit 1;
  if previous.revision is not null and previous.summary = snapshot then
    return previous.revision;
  end if;
  insert into public.register_closures(register_no,business_day,revision,closed_by,cashier_name,summary)
  values(box,report_day,coalesce(previous.revision,0) + 1,actor,operator_name,snapshot)
  returning revision into previous.revision;
  return previous.revision;
end $$;

revoke execute on function private.assign_sale_register(), private.lock_register_void(), private.register_summary(integer,date)
  from public, anon, authenticated;
revoke execute on function public.register_day(date), public.close_register(date) from public, anon;
grant execute on function public.register_day(date), public.close_register(date) to authenticated;

commit;
