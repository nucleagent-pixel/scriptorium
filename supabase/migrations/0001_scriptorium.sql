-- =====================================================================
-- Scriptorium: base de datos
-- Todas las tablas llevan el prefijo sc_ para poder vivir en el mismo
-- proyecto de Supabase que el NUCLEA Dashboard sin chocar con sus tablas.
-- =====================================================================

-- Personas del equipo con acceso a Scriptorium (aparte de los roles del Dashboard).
create table if not exists sc_members (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  name       text not null,
  role       text not null default 'pendiente' check (role in ('admin', 'equipo', 'pendiente')),
  created_at timestamptz not null default now()
);

create or replace function sc_is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from sc_members where user_id = auth.uid() and role in ('admin', 'equipo'));
$$;

create or replace function sc_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from sc_members where user_id = auth.uid() and role = 'admin');
$$;

-- Todo el contenido del equipo: productos, encontrados, líneas, tareas, post-its,
-- eventos, chats y entregas. Cada fila es un documento JSON de una colección.
create table if not exists sc_items (
  id         uuid primary key default gen_random_uuid(),
  col        text not null check (col in ('products', 'found', 'lines', 'tasks', 'notes', 'events', 'chats', 'deliverables')),
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_by uuid default auth.uid()
);
create index if not exists sc_items_col on sc_items (col);

-- Configuración compartida (metas del mes, etc.).
create table if not exists sc_config (
  id         text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into sc_config (id) values ('main') on conflict do nothing;

create or replace function sc_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if auth.uid() is not null then new.updated_by := auth.uid(); end if;
  return new;
end $$;

drop trigger if exists sc_items_touch on sc_items;
create trigger sc_items_touch before update on sc_items for each row execute function sc_touch();

-- Cambiar solo algunos campos de un documento, sin pisar los demás
-- (dos personas pueden editar campos distintos al mismo tiempo).
create or replace function sc_patch(p_id uuid, p_patch jsonb) returns void
language sql security invoker set search_path = public as $$
  update sc_items set data = data || p_patch where id = p_id;
$$;

create or replace function sc_patch_config(p_patch jsonb) returns void
language sql security invoker set search_path = public as $$
  update sc_config set data = data || p_patch, updated_at = now() where id = 'main';
$$;

-- No dejar el equipo sin admin.
create or replace function sc_guard_last_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin')
     and (select count(*) from sc_members where role = 'admin') <= 1 then
    raise exception 'Scriptorium necesita al menos un admin';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists sc_members_guard on sc_members;
create trigger sc_members_guard before update or delete on sc_members
  for each row execute function sc_guard_last_admin();

-- ---------------------------------------------------------------------
-- Permisos (RLS)
-- ---------------------------------------------------------------------
alter table sc_members enable row level security;
alter table sc_items   enable row level security;
alter table sc_config  enable row level security;

drop policy if exists sc_members_read on sc_members;
create policy sc_members_read on sc_members for select to authenticated
  using (user_id = auth.uid() or sc_is_member());
drop policy if exists sc_members_admin on sc_members;
create policy sc_members_admin on sc_members for update to authenticated
  using (sc_is_admin()) with check (sc_is_admin());
drop policy if exists sc_members_admin_del on sc_members;
create policy sc_members_admin_del on sc_members for delete to authenticated
  using (sc_is_admin());

drop policy if exists sc_items_all on sc_items;
create policy sc_items_all on sc_items for all to authenticated
  using (sc_is_member()) with check (sc_is_member());

drop policy if exists sc_config_all on sc_config;
create policy sc_config_all on sc_config for all to authenticated
  using (sc_is_member()) with check (sc_is_member());

revoke all on sc_members, sc_items, sc_config from anon;
grant select, update, delete on sc_members to authenticated;
grant select, insert, update, delete on sc_items, sc_config to authenticated;
revoke execute on function sc_patch(uuid, jsonb) from public, anon;
revoke execute on function sc_patch_config(jsonb) from public, anon;
grant execute on function sc_patch(uuid, jsonb) to authenticated;
grant execute on function sc_patch_config(jsonb) to authenticated;

-- Cambios en vivo para que todo el equipo vea lo mismo sin recargar.
do $$
begin
  begin alter publication supabase_realtime add table sc_items; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table sc_config; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table sc_members; exception when duplicate_object then null; end;
end $$;
