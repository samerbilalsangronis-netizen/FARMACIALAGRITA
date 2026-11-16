-- Panel: turno abierto o último turno cerrado de cada caja, sin recortar por día.
begin;
create function public.register_overview() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := private.require_role(); admin boolean := private.app_role()='admin';
begin
 return coalesce((select jsonb_agg(to_jsonb(t) order by t.register_no) from (
  select b.no as register_no,p.username,
   coalesce(c.summary,case when s.id is not null then private.shift_summary(s.id) end,
    '{"sales":0,"units":0,"usd":0,"ves":0,"cop":0,"without_rate":0,"discounts":0,"products":[],"payments":[]}'::jsonb) - 'sale_ids' as summary,
   case when s.id is not null then jsonb_build_object('id',s.id,'started_at',s.started_at,'ended_at',s.ended_at,'cashier_name',s.cashier_name) end as turn,
   case when c.revision is not null then jsonb_build_object('revision',c.revision,'closed_at',c.closed_at,'cashier_name',s.cashier_name,'summary',c.summary-'sale_ids') end as closure,
   coalesce(c.revision is not null and c.summary<>private.shift_summary(s.id),false) as changed
  from generate_series(1,4) b(no)
  left join lateral (select id,username from public.profiles where active and (register_no=b.no or (b.no=4 and role='admin')) order by id limit 1) p on true
  left join lateral (select * from public.register_shifts where register_no=b.no and (admin or cashier_id=actor) order by (ended_at is null) desc,started_at desc,id desc limit 1) s on true
  left join lateral (select * from public.shift_closures where shift_id=s.id order by revision desc limit 1) c on true
  where admin or p.id=actor
 ) t),'[]'::jsonb);
end $$;
revoke execute on function public.register_overview() from public,anon;
grant execute on function public.register_overview() to authenticated;
notify pgrst,'reload schema';
commit;
