-- sniper-v1 schema. Personal-use Resy reservation watcher.
-- All tables prefixed sniper_ to namespace inside the curaite Supabase project.
-- Drop with: drop table sniper_alerts, sniper_watches, sniper_credentials, sniper_pending_otp, sniper_chats cascade;

create table if not exists sniper_chats (
  chat_id text primary key,
  phone text,
  service text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists sniper_credentials (
  chat_id text primary key references sniper_chats(chat_id) on delete cascade,
  encrypted_token text not null,
  iv text not null,
  tag text not null,
  phone text,
  connected_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table if not exists sniper_pending_otp (
  chat_id text primary key references sniper_chats(chat_id) on delete cascade,
  phone text not null,
  claim_token text,
  challenge_id text,
  required_fields jsonb,
  created_at timestamptz not null default now()
);

create table if not exists sniper_watches (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null references sniper_chats(chat_id) on delete cascade,
  raw_request text not null,
  venue_name text not null,
  venue_id bigint,
  venue_url text,
  date_start date not null,
  date_end date not null,
  party_size int not null,
  time_start time not null,
  time_end time not null,
  auto_book boolean not null default true,
  status text not null default 'active' check (status in ('active', 'matched', 'booked', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  last_polled_at timestamptz,
  matched_at timestamptz,
  booked_at timestamptz,
  resy_token text,
  notes text
);

create index if not exists sniper_watches_active_idx on sniper_watches(status, last_polled_at) where status = 'active';
create index if not exists sniper_watches_chat_idx on sniper_watches(chat_id);

create table if not exists sniper_alerts (
  id uuid primary key default gen_random_uuid(),
  watch_id uuid not null references sniper_watches(id) on delete cascade,
  slot_date date not null,
  slot_time time not null,
  config_token text not null,
  venue_url text not null,
  outcome text not null default 'notified' check (outcome in ('notified', 'booked', 'book_failed')),
  resy_token text,
  failure_reason text,
  sent_at timestamptz not null default now(),
  unique (watch_id, slot_date, slot_time)
);

-- pg_cron + pg_net for the scheduled poller. Both are pre-installed on Supabase
-- but live in dedicated schemas and need to be enabled per project.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net  with schema extensions;
