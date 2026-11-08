begin;

create function public.manage_profile(profile uuid, new_role text, enabled boolean)
returns void language plpgsql security definer set search_path = ''
as $$
declare actor uuid := private.require_role(true);
begin
  if profile is null or profile=actor then raise exception 'Gestiona esta cuenta desde otra cuenta administradora'; end if;
  update public.profiles set role=new_role,active=enabled where id=profile;
  if not found then raise exception 'Usuario no encontrado'; end if;
  insert into public.audit_logs(actor_id,action,entity_id,detail)
  values(actor,'profile.update',profile,jsonb_build_object('role',new_role,'active',enabled));
end $$;

create function public.save_payment_method(method_code text, method_label text, enabled boolean)
returns void language plpgsql security definer set search_path = ''
as $$
declare actor uuid := private.require_role(true);
begin
  if method_code !~ '^[a-z][a-z0-9_-]{1,31}$' or length(btrim(method_label)) not between 1 and 80 then
    raise exception 'Código o nombre del método inválido';
  end if;
  if method_code='cash' and not enabled then raise exception 'Conserva el método de efectivo activo'; end if;
  perform pg_advisory_xact_lock(50422);
  insert into public.payment_methods(code,label,active) values(method_code,btrim(method_label),enabled)
    on conflict(code) do update set label=excluded.label,active=excluded.active;
  insert into public.audit_logs(actor_id,action,detail)
    values(actor,'payment_method.update',jsonb_build_object('code',method_code,'active',enabled));
end $$;

revoke execute on function public.manage_profile(uuid,text,boolean),public.save_payment_method(text,text,boolean) from public, anon;
grant execute on function public.manage_profile(uuid,text,boolean),public.save_payment_method(text,text,boolean) to authenticated;

commit;
