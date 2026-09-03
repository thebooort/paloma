-- ============================================================
-- PALOMA — esquema Supabase
-- Pega TODO este archivo en:
-- Supabase → SQL Editor → New query → Run
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists public.deliveries (
  id uuid primary key default gen_random_uuid(),

  origin text not null,
  destination text not null,
  distance_km double precision not null,

  -- El mensaje está cifrado en el navegador con AES-GCM.
  ciphertext text not null,
  iv text not null,
  salt text not null,

  start_at timestamptz not null,
  arrival_at timestamptz not null,

  -- Nunca se devuelve al navegador antes de que ocurra.
  failure_at timestamptz null,

  created_at timestamptz not null default now()
);

alter table public.deliveries enable row level security;

-- Nadie desde el navegador puede leer/escribir la tabla directamente.
revoke all on table public.deliveries from anon, authenticated;

-- ============================================================
-- CREAR ENVÍO
-- El servidor fija la hora y calcula la llegada a 80 km/h.
-- También decide de forma privada si la paloma se pierde.
-- ============================================================

create or replace function public.create_delivery(
  p_origin text,
  p_destination text,
  p_distance_km double precision,
  p_ciphertext text,
  p_iv text,
  p_salt text
)
returns table (
  id uuid,
  start_at timestamptz,
  arrival_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := gen_random_uuid();
  v_start timestamptz := now();
  v_duration interval;
  v_arrival timestamptz;
  v_failure timestamptz := null;
  v_failure_fraction double precision;
begin
  if p_origin is null or length(trim(p_origin)) < 1 or length(p_origin) > 120 then
    raise exception 'Origen no válido';
  end if;

  if p_destination is null or length(trim(p_destination)) < 1 or length(p_destination) > 120 then
    raise exception 'Destino no válido';
  end if;

  if p_distance_km is null or p_distance_km < 0 or p_distance_km > 21050 then
    raise exception 'Distancia no válida';
  end if;

  if p_ciphertext is null or length(p_ciphertext) < 1 or length(p_ciphertext) > 50000 then
    raise exception 'Mensaje cifrado no válido';
  end if;

  if p_iv is null or length(p_iv) > 200 or p_salt is null or length(p_salt) > 200 then
    raise exception 'Parámetros criptográficos no válidos';
  end if;

  -- Distancia / 80 km/h → segundos.
  -- Mínimo 5 segundos para que incluso un envío muy cercano tenga animación.
  v_duration := make_interval(
    secs => greatest(5.0, (p_distance_km / 80.0) * 3600.0)
  );

  v_arrival := v_start + v_duration;

  -- 8 % de probabilidad de fallo.
  -- Si falla, ocurre entre el 15 % y el 85 % del trayecto.
  if random() < 0.08 then
    v_failure_fraction := 0.15 + random() * 0.70;
    v_failure := v_start + (v_duration * v_failure_fraction);
  end if;

  insert into public.deliveries (
    id,
    origin,
    destination,
    distance_km,
    ciphertext,
    iv,
    salt,
    start_at,
    arrival_at,
    failure_at
  )
  values (
    v_id,
    trim(p_origin),
    trim(p_destination),
    p_distance_km,
    p_ciphertext,
    p_iv,
    p_salt,
    v_start,
    v_arrival,
    v_failure
  );

  return query
  select v_id, v_start, v_arrival;
end;
$$;

-- ============================================================
-- CONSULTAR UN ENVÍO
-- No revela failure_at.
-- No devuelve ciphertext/iv/salt hasta que la entrega sea real.
-- ============================================================

create or replace function public.get_delivery(p_id uuid)
returns table (
  id uuid,
  origin text,
  destination text,
  distance_km double precision,
  start_at timestamptz,
  arrival_at timestamptz,
  state text,
  ciphertext text,
  iv text,
  salt text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    d.id,
    d.origin,
    d.destination,
    d.distance_km,
    d.start_at,
    d.arrival_at,

    case
      when d.failure_at is not null and now() >= d.failure_at
        then 'lost'
      when now() >= d.arrival_at
        then 'delivered'
      else 'traveling'
    end as state,

    case
      when now() >= d.arrival_at
           and (d.failure_at is null or d.failure_at > d.arrival_at)
        then d.ciphertext
      else null
    end as ciphertext,

    case
      when now() >= d.arrival_at
           and (d.failure_at is null or d.failure_at > d.arrival_at)
        then d.iv
      else null
    end as iv,

    case
      when now() >= d.arrival_at
           and (d.failure_at is null or d.failure_at > d.arrival_at)
        then d.salt
      else null
    end as salt

  from public.deliveries d
  where d.id = p_id
  limit 1;
$$;

-- Solo exponemos las dos funciones.
revoke all on function public.create_delivery(
  text, text, double precision, text, text, text
) from public;

revoke all on function public.get_delivery(uuid) from public;

grant execute on function public.create_delivery(
  text, text, double precision, text, text, text
) to anon, authenticated;

grant execute on function public.get_delivery(uuid)
to anon, authenticated;

-- La service_role sigue pudiendo administrar la tabla desde backend/dashboard.
grant all on table public.deliveries to service_role;

-- Opcional: índice útil si luego haces limpieza por antigüedad.
create index if not exists deliveries_created_at_idx
on public.deliveries (created_at);
