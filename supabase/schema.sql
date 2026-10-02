-- ============================================================================
-- Névoa Cifras — schema Supabase
-- Execute este arquivo no SQL Editor do Supabase (Dashboard > SQL Editor).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- PROFILES: perfil do usuário (nome de login único + email)
-- O trigger cria a linha automaticamente no cadastro.
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  username text not null unique,
  created_at timestamptz not null default now()
);

-- trigger: após criar usuário em auth.users, cria o perfil usando o username
-- enviado no metadata do cadastro (options.data.username).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
  v_base text;
  v_n int := 0;
begin
  v_username := lower(trim(coalesce(new.raw_user_meta_data ->> 'username', '')));
  v_username := regexp_replace(v_username, '[^a-z0-9._]', '', 'g');
  if v_username is null or length(v_username) < 2 then
    v_base := lower(split_part(coalesce(new.email, 'user'), '@', 1));
    v_base := regexp_replace(v_base, '[^a-z0-9._]', '', 'g');
    if length(v_base) < 2 then
      v_base := 'user';
    end if;
    v_base := left(v_base, 18);
    v_username := v_base;
    while exists (select 1 from public.profiles where username = v_username) loop
      v_n := v_n + 1;
      v_username := left(v_base, 16) || v_n::text;
    end loop;
  end if;

  insert into public.profiles (id, email, username)
  values (
    new.id,
    coalesce(new.email, ''),
    v_username
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- RPC: email a partir do username (para login "por usuário")
create or replace function public.get_email_for_username(p_username text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select email
  from public.profiles
  where username = lower(trim(p_username))
  limit 1;
$$;

-- RPC: username está disponível? (usado antes do cadastro)
create or replace function public.username_available(p_username text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1 from public.profiles where username = lower(trim(p_username))
  );
$$;

alter table public.profiles enable row level security;

-- usuário só vê/edita o próprio perfil
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (auth.uid() = id);

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert with check (auth.uid() = id);

-- ----------------------------------------------------------------------------
-- SONGS: catálogo compartilhado de cifras (lido por todos, escrito via Edge
-- Function com service_role).
-- ----------------------------------------------------------------------------
create table if not exists public.songs (
  id uuid primary key default gen_random_uuid(),
  artist text not null,
  title text not null,
  slug_artist text not null,
  slug_title text not null,
  version text not null default 'original',
  cifraclub_url text,
  youtube_url text,
  image_url text,
  tuning text not null default 'E A D G C F',
  tone_root text,
  content jsonb not null default '[]',
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint songs_slug_key unique (slug_artist, slug_title, version)
);

-- Migração idempotente: permite a mesma música em várias versões
-- (ex.: original + simplificada). Seguro reexecutar após a criação da tabela.
alter table public.songs add column if not exists version text not null default 'original';
alter table public.songs drop constraint if exists songs_slug_key;
alter table public.songs add constraint songs_slug_key unique (slug_artist, slug_title, version);

create index if not exists songs_artist_idx on public.songs (artist);
create index if not exists songs_title_idx on public.songs (title);

alter table public.songs enable row level security;

drop policy if exists songs_select on public.songs;
create policy songs_select on public.songs
  for select using (true);

-- ----------------------------------------------------------------------------
-- LISTS: setlists/repertórios do usuário
-- ----------------------------------------------------------------------------
create table if not exists public.lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  name text not null,
  share_token uuid,
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Migração idempotente: compartilhamento público somente-leitura
alter table public.lists add column if not exists share_token uuid;
alter table public.lists add column if not exists is_public boolean not null default false;
create unique index if not exists lists_share_token_idx
  on public.lists (share_token)
  where share_token is not null;

create index if not exists lists_user_idx on public.lists (user_id);

alter table public.lists enable row level security;

-- dono vê sempre; qualquer usuário autenticado vê listas compartilhadas
drop policy if exists lists_select on public.lists;
create policy lists_select on public.lists
  for select using (
    auth.uid() = user_id
    or (is_public and share_token is not null and auth.uid() is not null)
  );

drop policy if exists lists_insert on public.lists;
create policy lists_insert on public.lists
  for insert with check (auth.uid() = user_id);

drop policy if exists lists_update on public.lists;
create policy lists_update on public.lists
  for update using (auth.uid() = user_id);

drop policy if exists lists_delete on public.lists;
create policy lists_delete on public.lists
  for delete using (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- LIST_SONGS: músicas dentro de uma lista, com ordem
-- ----------------------------------------------------------------------------
create table if not exists public.list_songs (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.lists (id) on delete cascade,
  song_id uuid not null references public.songs (id) on delete cascade,
  position integer not null default 0,
  shift integer not null default 0,
  capo integer not null default 0,
  created_at timestamptz not null default now(),
  constraint list_songs_unique unique (list_id, song_id)
);

alter table public.list_songs add column if not exists shift integer not null default 0;
alter table public.list_songs add column if not exists capo integer not null default 0;

create index if not exists list_songs_list_idx on public.list_songs (list_id);

alter table public.list_songs enable row level security;

-- políticas delegam ao dono da lista; listas públicas são somente-leitura
drop policy if exists list_songs_select on public.list_songs;
create policy list_songs_select on public.list_songs
  for select using (
    exists (
      select 1 from public.lists l
      where l.id = list_id
        and (
          l.user_id = auth.uid()
          or (l.is_public and l.share_token is not null and auth.uid() is not null)
        )
    )
  );

drop policy if exists list_songs_insert on public.list_songs;
create policy list_songs_insert on public.list_songs
  for insert with check (
    exists (select 1 from public.lists where id = list_id and user_id = auth.uid())
  );

drop policy if exists list_songs_update on public.list_songs;
create policy list_songs_update on public.list_songs
  for update using (
    exists (select 1 from public.lists where id = list_id and user_id = auth.uid())
  );

drop policy if exists list_songs_delete on public.list_songs;
create policy list_songs_delete on public.list_songs
  for delete using (
    exists (select 1 from public.lists where id = list_id and user_id = auth.uid())
  );

-- ----------------------------------------------------------------------------
-- FAVORITES: músicas favoritas do usuário
-- ----------------------------------------------------------------------------
create table if not exists public.favorites (
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  song_id uuid not null references public.songs (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, song_id)
);

alter table public.favorites enable row level security;

drop policy if exists favorites_select on public.favorites;
create policy favorites_select on public.favorites
  for select using (auth.uid() = user_id);

drop policy if exists favorites_insert on public.favorites;
create policy favorites_insert on public.favorites
  for insert with check (auth.uid() = user_id);

drop policy if exists favorites_delete on public.favorites;
create policy favorites_delete on public.favorites
  for delete using (auth.uid() = user_id);

-- troca as posições de dois itens da mesma lista
create or replace function public.swap_list_positions(p_a uuid, p_b uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_a int; v_b int; v_list uuid;
begin
  select list_id, position into v_list, v_a from public.list_songs where id = p_a;
  select position into v_b from public.list_songs where id = p_b;
  if v_list is null or v_b is null then
    return;
  end if;
  if not exists (select 1 from public.lists where id = v_list and user_id = auth.uid()) then
    raise exception 'not allowed';
  end if;
  update public.list_songs set position = -1 where id = p_a;
  update public.list_songs set position = v_a where id = p_b;
  update public.list_songs set position = v_b where id = p_a;
end;
$$;

-- função para reordenar de uma vez (posição por música)
create or replace function public.set_list_order(p_list_id uuid, p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid;
  i int;
begin
  select user_id into owner from public.lists where id = p_list_id;
  if owner is distinct from auth.uid() then
    raise exception 'not allowed';
  end if;
  for i in 1 .. array_length(p_ids, 1) loop
    update public.list_songs
    set position = i - 1
    where list_id = p_list_id and song_id = p_ids[i];
  end loop;
end;
$$;

-- ----------------------------------------------------------------------------
-- ÍNDICES auxiliares usados pelas consultas da tela
-- ----------------------------------------------------------------------------
create index if not exists list_songs_order_idx on public.list_songs (list_id, position);
create index if not exists favorites_song_idx on public.favorites (song_id);
create index if not exists songs_slug_idx on public.songs (slug_artist, slug_title, version);

-- ============================================================================
-- RLS COMPLETA + PERMISSÕES DE ROLES  (executar junto com o arquivo inteiro)
-- ============================================================================
-- Resumo do que cada role pode fazer:
--   * anon            -> só LÊ o catálogo público (songs) e executa os RPCs
--                        públicos de login/cadastro (username_available,
--                        get_email_for_username).
--   * authenticated   -> lê o catálogo + tudo que pertence ao próprio usuário
--                        (profiles, lists, list_songs, favorites).
--   * service_role    -> usado pela Edge Function fetch-song (SERVICE_ROLE_KEY)
--                        para gravar em songs; ignora a RLS (não passa por aqui).
--
-- As tabelas abaixo já têm row level security habilitado e políticas definidas
-- nas seções anteriores deste arquivo. A partir daqui só garantimos os grants,
-- para funcionar mesmo se o projeto não tiver as default privileges padrão.
-- ----------------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;

-- catálogo público: leitura para todos (anon inclui quem está deslogado)
grant select on public.songs to anon, authenticated;

-- perfil: cada usuário lê apenas o próprio (a linha é criada pelo trigger)
grant select, insert on public.profiles to authenticated;

-- listas e músicas das listas: só do próprio usuário (políticas por auth.uid())
grant select, insert, update, delete on public.lists to authenticated;
grant select, insert, update, delete on public.list_songs to authenticated;

-- favoritos: só do próprio usuário
grant select, insert, delete on public.favorites to authenticated;

-- RPCs usados pelo frontend
grant execute on function public.username_available(text) to anon, authenticated;
grant execute on function public.get_email_for_username(text) to anon, authenticated;
grant execute on function public.swap_list_positions(uuid, uuid) to authenticated;
grant execute on function public.set_list_order(uuid, uuid[]) to authenticated;
