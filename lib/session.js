// The edit loop's memory.
//
// Lives here rather than in server.js so it can be driven without a phone, a webhook, or an OpenAI
// bill — this is the subtle part of the feature, and the full product learned most of these rules
// by getting them wrong first (see the branching and finality notes below).
//
// Three pieces of state, and they are not redundant:
//   sessions       phone   -> the image thread that phone currently has open
//   sent_versions  msg SID -> the version that outbound image showed. Twilio hands the same SID
//                             back as OriginalRepliedMessageSid when the user swipes-to-reply,
//                             which is the entire hinge of the edit loop.
//   closed_cards   cardIds the user has finalized. Replies still name a version long after their
//                             session is gone, so finality is tracked per card, not per session.
//
// DURABLE, in Supabase (db/schema.sql). This used to be in-memory Maps — but that meant a restart
// forgot every open image, so a reply to yesterday's image (the process had restarted overnight)
// found nothing and was silently treated as a brand-new generation. The tables here are the fix: a
// reply resolves regardless of restarts, deploys, or `node --watch`. (lib/ratelimit.js moved its
// spend ledger to the same database for the same reason.)
//
// Same Supabase project as image hosting, and the same SERVICE ROLE key (bypasses RLS). Every
// function that touches state is async; the pure helpers (isFinalize) are not.

require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. See .env.example');
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }, // a server, not a browser
});

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// A bare (non-reply) message edits the open image only while the session is still warm. Past this
// the user has almost certainly moved on, and treating "make a diwali card" as an edit of the
// birthday card they made an hour ago is worse than just making the diwali card. (Replies carry no
// time limit — an explicit reply resolves via sent_versions however old it is.)
const EDIT_WINDOW_MS = Number(process.env.EDIT_WINDOW_MIN ?? 30) * 60 * 1000;

// Exact-token match only. "finalize but make the border gold" is an edit, not a finalize — a stray
// substring match would silently close the user's image instead of changing it.
const FINALIZE_TOKENS = new Set(['finalize', 'finalized', 'finalise', 'finalised', 'done', 'final']);
const isFinalize = (text) => FINALIZE_TOKENS.has(text.toLowerCase().replace(/[.!\s]+$/, ''));

// A Version is { url, mimeType, prompt } — a Supabase URL, never bytes. See storage.fetchCard.
// Two versions are the same version iff their url matches: each upload gets a unique random-UUID
// path, so url is a stable identity across the round-trip through jsonb (object identity is not).
const sameVersion = (a, b) => a && b && a.url === b.url;

// sessions row -> the in-code session shape the rest of the module (and server.js) expects.
const rowToSession = (r) =>
  r && {
    cardId: r.card_id,
    versions: r.versions ?? [],
    status: r.status,
    lastActivity: Number(r.last_activity),
  };

async function newSession(phone, seedVersions = []) {
  const session = {
    cardId: crypto.randomUUID(),
    versions: [...seedVersions],
    status: 'open',
    lastActivity: Date.now(),
  };
  // Upsert on the phone PK: a new session replaces that phone's previous one, exactly as
  // `sessions.set(phone, session)` did in memory.
  const { error } = await db.from('sessions').upsert({
    phone,
    card_id: session.cardId,
    versions: session.versions,
    status: session.status,
    last_activity: session.lastActivity,
  });
  if (error) throw error;
  return session;
}

async function liveSession(phone) {
  const { data, error } = await db.from('sessions').select('*').eq('phone', phone).maybeSingle();
  if (error) throw error;

  const session = rowToSession(data);
  if (!session || session.status !== 'open') return null;
  if (Date.now() - session.lastActivity > EDIT_WINDOW_MS) return null;
  return session;
}

async function getSent(sid) {
  const { data, error } = await db.from('sent_versions').select('*').eq('sid', sid).maybeSingle();
  if (error) throw error;
  return data && { phone: data.phone, cardId: data.card_id, version: data.version };
}

async function isClosed(cardId) {
  const { data, error } = await db
    .from('closed_cards')
    .select('card_id')
    .eq('card_id', cardId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

/**
 * What is this inbound message pointing at?
 *
 * @returns {Promise<{ ref: object|null, base: object|null, refIsFinal: boolean }>}
 *   base === null means "brand new image"; anything else means "edit this version".
 */
async function resolveTarget(phone, repliedSid) {
  const sent = repliedSid ? await getSent(repliedSid) : null;

  // Only the person we sent an image to may edit it. sent_versions is keyed by a SID alone, so
  // without this a sender who names someone else's SID edits THEIR image and gets it back — one
  // WhatsApp user's private design handed to another. Reaching it means guessing a 34-char SID you
  // never received, but it is free to close, so close it.
  const ref = sent && sent.phone === phone ? sent : null;

  const session = await liveSession(phone);

  // A finalized image is done. Replying to one starts fresh instead of editing it — the bot tells
  // users to reply to images, so without this their finished design silently becomes the base for
  // their next, unrelated prompt.
  const refIsFinal = ref ? await isClosed(ref.cardId) : false;

  // An explicit reply names its version; otherwise a warm session implies its latest. Neither
  // means this is a brand new image.
  const base = ref ? (refIsFinal ? null : ref.version) : session?.versions.at(-1) ?? null;

  return { ref, base, refIsFinal };
}

/**
 * Which session should the new version be appended to?
 *
 * Replying to an image from a closed session (or a different lineage) branches a NEW session seeded
 * from that image, rather than resurrecting stale state.
 *
 * @returns {Promise<object>} the session to append to (already persisted)
 */
async function resolveSession(phone, ref, base) {
  const session = await liveSession(phone);
  if (ref && (!session || session.cardId !== ref.cardId)) {
    console.log(`↪️  Branching new image from ${ref.cardId.slice(0, 8)}`);
    return newSession(phone, [base]);
  }
  return session ?? newSession(phone, base ? [base] : []);
}

/**
 * Append a freshly-generated version to a session and persist it. Replaces the in-memory
 * `target.versions.push(version)` that used to be enough when state lived in a Map.
 *
 * Scoped to phone AND card_id so that if a concurrent message for the same phone already replaced
 * the row with a newer session, this update touches zero rows rather than clobbering it.
 */
async function appendVersion(phone, session, version) {
  session.versions.push(version);
  session.lastActivity = Date.now();
  const { error } = await db
    .from('sessions')
    .update({ versions: session.versions, last_activity: session.lastActivity })
    .eq('phone', phone)
    .eq('card_id', session.cardId);
  if (error) throw error;
  return session;
}

/** Record that `version` went out as message `sid`, so a reply to it can be resolved. */
async function recordSent(sid, phone, cardId, version) {
  const { error } = await db
    .from('sent_versions')
    .upsert({ sid, phone, card_id: cardId, version });
  if (error) throw error;
}

async function markClosed(cardId) {
  const { error } = await db
    .from('closed_cards')
    .upsert({ card_id: cardId }, { onConflict: 'card_id' });
  if (error) throw error;
}

/**
 * Close the image the user pointed at. Returns false if there was nothing to close.
 *
 * @returns {Promise<boolean>}
 */
async function closeCard(phone, ref, base) {
  if (!base) return false;

  // Match on version identity rather than cardId: a branched session carries a fresh cardId but
  // shares its seed version with the image it grew from, so a cardId compare misses it and the
  // image can never be closed. Replying "finalize" to an image from some other lineage still must
  // not close whatever is open now.
  const { data, error } = await db.from('sessions').select('*').eq('phone', phone).maybeSingle();
  if (error) throw error;
  const session = rowToSession(data);
  if (session && session.versions.some((v) => sameVersion(v, base))) {
    const { error: updErr } = await db
      .from('sessions')
      .update({ status: 'closed' })
      .eq('phone', phone)
      .eq('card_id', session.cardId);
    if (updErr) throw updErr;
    await markClosed(session.cardId);
  }
  // The image the user pointed at is done too, even if a later session branched off it —
  // otherwise replying to it keeps reviving the same design.
  if (ref) await markClosed(ref.cardId);
  return true;
}

/**
 * Fail loudly on boot if the tables are missing, rather than on the first user's message. Mirrors
 * storage.ensureBucket and the env-var checks in server.js: a misconfigured deploy should not look
 * healthy and then silently drop every reply back to brand-new generation.
 */
async function assertSchema() {
  for (const table of ['sent_versions', 'sessions', 'closed_cards']) {
    const { error } = await db.from(table).select('*').limit(1);
    if (error) {
      throw new Error(
        `Supabase table "${table}" is not reachable (${error.message}). ` +
          'Run db/schema.sql once in the Supabase SQL editor for the SUPABASE_URL project.'
      );
    }
  }
}

/** Test seam. */
async function reset() {
  await db.from('sent_versions').delete().neq('sid', '');
  await db.from('sessions').delete().neq('phone', '');
  await db.from('closed_cards').delete().neq('card_id', NIL_UUID);
}

module.exports = {
  EDIT_WINDOW_MS,
  isFinalize,
  newSession,
  liveSession,
  resolveTarget,
  resolveSession,
  appendVersion,
  recordSent,
  closeCard,
  assertSchema,
  reset,
};
