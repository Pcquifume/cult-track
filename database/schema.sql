-- ============================================================================
-- cult-track · Schéma de base de données (Supabase / PostgreSQL)
-- À exécuter une seule fois dans l'éditeur SQL de votre projet Supabase
-- (Dashboard → SQL Editor → New query → Run).
--
-- Le Worker Cloudflare accède à ces tables avec la clé "service_role"
-- (clé "role key"), qui contourne les RLS. Vérification : vous êtes
-- bien ADMIN de votre projet — ne partagez jamais cette clé.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Utilisateurs (un utilisateur = un compte Cults3D relié)
-- ---------------------------------------------------------------------------
create table if not exists users (
  id                uuid primary key default gen_random_uuid(),
  nick              text not null unique,
  avatar_url        text,
  bio               text,
  profile_url       text,
  followers         integer not null default 0,
  currency          text not null default 'EUR',
  -- Clé API Cults3D chiffrée (AES-256-GCM) : base64url(iv).base64url(data)
  encrypted_api_key text not null,
  -- Petit aperçu (ex: "abcd…") pour l'afficher sans jamais révéler la clé
  key_prefix        text not null default '',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on column users.encrypted_api_key is
  'Clé API Cults3D chiffrée avec AES-256-GCM via le secret ENC_KEY du Worker.';
comment on column users.key_prefix is
  'Premiers caractères de la clé, à titre indicatif uniquement.';

-- ---------------------------------------------------------------------------
-- Sessions applicatives (jetons d'accès au tableau de bord)
-- ---------------------------------------------------------------------------
-- On stocke le SHA-256 du jeton (pas le jeton en clair).
create table if not exists sessions (
  token_hash   text primary key,
  user_id      uuid not null references users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create index if not exists sessions_user_id_idx on sessions(user_id);

-- ---------------------------------------------------------------------------
-- Créations Cults3D (état courant, mis à jour à chaque sync)
-- ---------------------------------------------------------------------------
create table if not exists creations (
  id                 text primary key,          -- identifier Cults3D
  user_id            uuid not null references users(id) on delete cascade,
  name               text,
  url                text,
  image_url          text,
  price_value        numeric(12,2),
  currency           text not null default 'EUR',
  visibility         text,
  published_at       timestamptz,
  made_with_ai       boolean,
  tags               jsonb,
  sales_total_cents  bigint not null default 0, -- totalSalesAmount (API)
  updated_at         timestamptz not null default now()
);

create index if not exists creations_user_id_idx on creations(user_id);

-- ---------------------------------------------------------------------------
-- Historique des créations (une ligne par sync et par création)
-- Permet de tracer les courbes vues / likes / téléchargements dans le temps.
-- ---------------------------------------------------------------------------
create table if not exists creations_history (
  id                bigserial primary key,
  user_id           uuid not null references users(id) on delete cascade,
  creation_id       text not null references creations(id) on delete cascade,
  captured_at       timestamptz not null default now(),
  downloads         integer not null default 0,
  views             integer not null default 0,
  likes             integer not null default 0,
  sales_amount_cents bigint not null default 0
);

create index if not exists creations_history_user_captured_idx
  on creations_history(user_id, captured_at);
create index if not exists creations_history_creation_captured_idx
  on creations_history(creation_id, captured_at);

-- ---------------------------------------------------------------------------
-- Snapshots du profil (agrégats globaux capturés périodiquement)
-- Courbes globales : abonnés, vues, téléchargements, revenus…
-- ---------------------------------------------------------------------------
create table if not exists snapshots (
  id                bigserial primary key,
  user_id           uuid not null references users(id) on delete cascade,
  captured_at       timestamptz not null default now(),
  followers         integer not null default 0,
  creations_count   integer not null default 0,
  total_views       bigint not null default 0,
  total_downloads   bigint not null default 0,
  total_likes       bigint not null default 0,
  total_revenue_cents bigint not null default 0,
  total_sales       integer not null default 0,
  raw               jsonb
);

create index if not exists snapshots_user_captured_idx on snapshots(user_id, captured_at);

-- ---------------------------------------------------------------------------
-- Ventes Cults3D (historique complet, delta-sync par id)
-- Source des courbes de revenus / ventes par jour.
-- ---------------------------------------------------------------------------
create table if not exists sales (
  id                    text primary key,           -- id Cults3D de la vente
  user_id               uuid not null references users(id) on delete cascade,
  -- Pas de FK vers creations : une vente peut référencer une création absente
  -- de notre table (suppression côté Cults3D, etc.). On garde l'identifiant tel
  -- quel et l'index permet la jointure quand la création existe.
  creation_id           text,
  creation_name         text,
  buyer_nick            text,
  income_cents          bigint not null default 0,
  currency              text not null default 'EUR',
  vat_cents             bigint not null default 0,
  discount_percentage   numeric(5,2),
  creation_views_count  integer,
  creation_likes_count  integer,
  created_at            timestamptz,
  payed_out_at          timestamptz
);

create index if not exists sales_user_created_idx on sales(user_id, created_at);
create index if not exists sales_user_creation_idx on sales(user_id, creation_id);

-- ---------------------------------------------------------------------------
-- Progression d'une synchronisation en cours (reprise par chunks)
-- ---------------------------------------------------------------------------
create table if not exists sync_state (
  user_id    uuid primary key references users(id) on delete cascade,
  stage      text not null,              -- 'creations' | 'sales'
  synced_offset integer not null default 0,
  total      integer,
  run_id     bigint,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Journal des synchronisations (pour l'affichage "dernière mise à jour")
-- ---------------------------------------------------------------------------
create table if not exists sync_runs (
  id                 bigserial primary key,
  user_id            uuid references users(id) on delete cascade,
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  status             text not null default 'running',  -- running | ok | error
  message            text,
  creations_synced   integer not null default 0,
  sales_synced       integer not null default 0,
  new_sales          integer not null default 0,
  rate_limit_remaining integer
);

create index if not exists sync_runs_user_finished_idx
  on sync_runs(user_id, finished_at desc nulls last);