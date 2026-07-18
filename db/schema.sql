-- wcgen v1.1 — edit-loop persistence.
--
-- Run this ONCE, in the Supabase SQL editor for the project referenced by SUPABASE_URL
-- (the same project used for image hosting). It creates the three tables that let the
-- reply-to-edit loop survive a server restart / deploy / `node --watch` reload.
--
-- Before this, all of edit-loop state lived in memory: a reply to yesterday's image found
-- nothing (the process had restarted overnight) and was treated as a brand-new generation.
--
-- Written only by the server with the SERVICE ROLE key. RLS is enabled at the bottom with zero
-- policies, so the anon/publishable key can read nothing — sent_versions and sessions hold phone
-- numbers. The service role bypasses RLS by design; that is the intended and only access path.

-- Every outbound image, keyed by its Twilio message SID. When a user swipes-to-reply, Twilio
-- hands that same SID back as OriginalRepliedMessageSid; we look the base version up here. This
-- is the hinge of the edit loop, and the table whose loss made next-day replies fail.
create table if not exists sent_versions (
  sid         text primary key,
  phone       text not null,
  card_id     uuid not null,
  version     jsonb not null,                     -- { url, mimeType, prompt }
  created_at  timestamptz not null default now()
);
create index if not exists sent_versions_phone_idx on sent_versions (phone);

-- The image thread each phone currently has open. One row per phone (upserted): a new session
-- replaces the previous one, exactly as the in-memory Map did.
create table if not exists sessions (
  phone          text primary key,
  card_id        uuid not null,
  versions       jsonb not null default '[]'::jsonb,  -- [ { url, mimeType, prompt }, ... ]
  status         text not null default 'open',        -- 'open' | 'closed'
  last_activity  bigint not null                      -- epoch ms, compared against Date.now()
);

-- Finalized cards. Finality is per-card, not per-session: a reply still names a version long
-- after its session is gone, and a branched session shares its seed version's card lineage.
create table if not exists closed_cards (
  card_id    uuid primary key,
  closed_at  timestamptz not null default now()
);

-- Lock the front door. RLS on with no policies: the anon/publishable key can neither read nor
-- write. Only the service role (server-side, never shipped to a browser) gets through — which is
-- exactly how lib/session.js connects.
alter table sent_versions enable row level security;
alter table sessions      enable row level security;
alter table closed_cards  enable row level security;
