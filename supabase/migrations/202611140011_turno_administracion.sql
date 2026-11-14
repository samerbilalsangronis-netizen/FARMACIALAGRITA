-- 011: catálogo completo con pendientes de precio y turnos propios de administración.
-- La caja 4 representa Administración. No se reasignan ventas anteriores ni se modifican productos.
begin;
alter table public.register_shifts drop constraint register_shifts_register_no_check;
alter table public.register_shifts add constraint register_shifts_register_no_check check(register_no between 1 and 4);
alter table public.sales drop constraint sales_register_no_check;
alter table public.sales add constraint sales_register_no_check check(register_no between 1 and 4);
alter table public.settings add column admin_shifts_started_at timestamptz not null default clock_timestamp();
create function private.operator_register(actor uuid) returns smallint
language sql stable set search_path = '' as $$
  select case when role='admin' then 4::smallint else register_no end from public.profiles where id=actor and active;
$$;
revoke execute on function private.operator_register(uuid) from public,anon,authenticated;
create or replace function public.open_register_shift(request_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.require_role(); p public.profiles; previous public.register_shifts; box smallint;
begin
  select * into p from public.profiles where id = actor;
  box := private.operator_register(actor);
  if box is null then raise exception 'Tu usuario debe tener una caja asignada'; end if;
  if request_id is null then raise exception 'Falta identificar el turno'; end if;
  perform pg_advisory_xact_lock(50423,box::integer);
  select * into previous from public.register_shifts where id = request_id;
  if previous.id is not null then
    if previous.cashier_id <> actor then raise exception 'Turno no autorizado'; end if;
    return previous.id;
  end if;
  select * into previous from public.register_shifts where register_no = box and ended_at is null;
  if previous.id is not null then
    if previous.cashier_id <> actor then raise exception 'La caja tiene un turno abierto de otra cajera'; end if;
    return previous.id;
  end if;
  insert into public.register_shifts(id,register_no,cashier_id,cashier_name)
    values(request_id,box,actor,p.username);
  return request_id;
end $$;

create or replace function public.authorize_device() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.require_role(); g public.device_grants; s public.settings; box smallint; turn uuid;
begin
  perform pg_advisory_xact_lock(50422);
  box := private.operator_register(actor);
  if box is not null then
    perform pg_advisory_xact_lock(50423,box::integer);
    select id into turn from public.register_shifts where register_no = box and cashier_id = actor and ended_at is null;
  end if;
  select * into strict s from public.settings;
  insert into public.device_grants(cashier_id,expires_at,rate_hours,stale_policy,methods,shift_id,shift_required)
  values(actor,clock_timestamp() + make_interval(hours => s.offline_hours),s.rate_hours,s.stale_policy,
    array(select code from public.payment_methods where active),turn,box is not null) returning * into g;
  return to_jsonb(g) || jsonb_build_object('catalog',public.catalog());
end $$;

create or replace function private.assign_sale_register() returns trigger
language plpgsql set search_path = '' as $$
declare g public.device_grants; turn public.register_shifts;
begin
  new.register_no := private.operator_register(new.cashier_id);
  if new.register_no is null then return new; end if;
  perform pg_advisory_xact_lock(50423,new.register_no::integer);
  select * into g from public.device_grants where id = (new.payload->>'grant_id')::uuid;
  if g.shift_required then
    if g.shift_id is null then raise exception 'Inicia un turno y actualiza el dispositivo antes de vender'; end if;
    select * into turn from public.register_shifts where id = g.shift_id;
    if turn.id is null or turn.cashier_id <> new.cashier_id or turn.register_no <> new.register_no
      or new.occurred_at < turn.started_at or (turn.ended_at is not null and new.occurred_at >= turn.ended_at) then
      raise exception 'La venta está fuera del turno autorizado. Actualiza el dispositivo';
    end if;
    new.shift_id := turn.id;
  else
    select * into turn from public.register_shifts s where s.cashier_id = new.cashier_id
      and s.register_no = new.register_no and new.occurred_at >= s.started_at
      and (s.ended_at is null or new.occurred_at < s.ended_at) order by s.started_at desc limit 1;
    if turn.id is not null then new.shift_id := turn.id;
    elsif (new.register_no=4 and new.occurred_at >= (select admin_shifts_started_at from public.settings where id)) or exists (select 1 from public.register_shifts s where s.cashier_id = new.cashier_id and s.started_at <= new.occurred_at) then
      raise exception 'Inicia un turno y actualiza el dispositivo antes de vender';
    end if;
  end if;
  -- Las autorizaciones anteriores a 007 conservan sus ventas sin turno.
  return new;
end $$;

create or replace function public.close_register_shift(shift uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.require_role(); turn public.register_shifts; previous public.shift_closures; snapshot jsonb;
begin
  select * into turn from public.register_shifts where id = shift and cashier_id = actor;
  if turn.id is null then raise exception 'Turno no autorizado'; end if;
  perform pg_advisory_xact_lock(50423,turn.register_no::integer);
  update public.register_shifts set ended_at = coalesce(ended_at,clock_timestamp()) where id = shift;
  snapshot := private.shift_summary(shift);
  select * into previous from public.shift_closures where shift_id = shift order by revision desc limit 1;
  if previous.revision is not null and previous.summary = snapshot then return previous.revision; end if;
  insert into public.shift_closures(shift_id,revision,summary) values(shift,coalesce(previous.revision,0)+1,snapshot)
    returning revision into previous.revision;
  return previous.revision;
end $$;

create or replace function public.register_shift_day(report_day date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := private.require_role(); admin boolean := private.app_role() = 'admin';
begin
  if report_day is null or report_day > (current_timestamp at time zone 'America/Caracas')::date then
    raise exception 'Selecciona una fecha válida';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(t) order by t.register_no,t.started_at) from (
    select s.id,s.cashier_id,s.register_no,s.cashier_name,s.business_day,s.started_at,s.ended_at,
      private.shift_summary(s.id) - 'sale_ids' as summary,
      case when c.revision is not null then jsonb_build_object('revision',c.revision,'closed_at',c.closed_at,'summary',c.summary - 'sale_ids') end as closure,
      c.revision is not null and c.summary <> private.shift_summary(s.id) as changed
    from public.register_shifts s
    left join lateral (select * from public.shift_closures where shift_id = s.id order by revision desc limit 1) c on true
    where (admin or s.cashier_id = actor) and (s.business_day = report_day or s.ended_at is null)
  ) t), '[]'::jsonb);
end $$;
create or replace function public.register_day(report_day date)
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
    from generate_series(1, 4) as b(no)
    left join lateral (select id,username from public.profiles where active and (register_no=b.no or (b.no=4 and role='admin')) order by id limit 1) p on true
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

create or replace function public.catalog() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare admin boolean;
begin
  perform private.require_role();
  admin := private.app_role() = 'admin';
  return jsonb_build_object(
    'pricing_enabled',true, 'simple_pricing_enabled',true, 'admin_shifts_enabled',true,
    'products',(select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('price_id',pr.id) ||
      case when admin then jsonb_build_object('net_cost',c.net_cost,'markup_percent',c.markup_percent) else '{}'::jsonb end
      order by p.name,p.code),'[]')
      from public.products p left join private.product_costs c on c.product_id=p.id
      left join lateral (select id from public.product_prices where product_id=p.id order by created_at desc,id desc limit 1) pr on true
      where p.active or admin),
    'settings',(select to_jsonb(s) from public.settings s),
    'rate',(select to_jsonb(r) from public.exchange_rates r order by created_at desc,id desc limit 1),
    'methods',(select coalesce(jsonb_agg(to_jsonb(m) order by m.label),'[]') from public.payment_methods m where m.active)
  );
end $$;


notify pgrst,'reload schema';
commit;
