-- Ejecuta 202611100006_cajas.sql primero.
-- Crea cajera1, cajera2 y cajera3 en Authentication > Users con el dominio de
-- acceso de FarmaWorld, correo confirmado y contraseñas privadas y distintas.
-- Completa el dominio debajo con el valor de SUPABASE_LOGIN_DOMAIN, sin @.

begin;
set local farmacia.dominio_acceso = '';

do $$
declare
  dominio text := lower(btrim(current_setting('farmacia.dominio_acceso')));
  caja smallint;
  usuario text;
  cuenta uuid;
begin
  if dominio = '' then raise exception 'Indica el dominio de acceso de FarmaWorld'; end if;
  for caja in 1..3 loop
    usuario := 'cajera' || caja;
    select id into cuenta from auth.users where lower(email) = usuario || '@' || dominio;
    if cuenta is null then raise exception 'Falta crear la cuenta % en Supabase Auth', usuario; end if;
    insert into public.profiles(id,username,role,active,register_no)
      values(cuenta,usuario,'cashier',true,caja)
      on conflict(id) do nothing;
    if exists (select 1 from public.profiles p where p.id = cuenta and p.username = usuario and p.role = 'cashier'
               and p.active and p.register_no is null) then
      if exists (select 1 from public.sales s where s.cashier_id = cuenta) then
        raise exception 'La cuenta % ya registró ventas. Usa una cuenta nueva para la caja', usuario;
      end if;
      update public.profiles set register_no = caja where id = cuenta;
    end if;
    if not exists (select 1 from public.profiles p where p.id = cuenta and p.username = usuario and p.role = 'cashier'
                   and p.active and p.register_no = caja) then
      raise exception 'La cuenta % no coincide con la caja %', usuario, caja;
    end if;
  end loop;
end $$;
commit;

select register_no as caja, username as usuario from public.profiles where register_no is not null order by register_no;
