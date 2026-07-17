// The edit loop's memory.
//
// Lives here rather than in server.js so it can be driven without a phone, a webhook, or a Gemini
// bill — this is the subtle part of the feature, and the full product learned most of these rules
// by getting them wrong first (see the branching and finality notes below).
//
// Three pieces of state, and they are not redundant:
//   sessions    phone   -> the image thread that phone currently has open
//   sidToCard   msg SID -> the version that outbound image showed. Twilio hands the same SID back
//                          as OriginalRepliedMessageSid when the user swipes-to-reply, which is
//                          the entire hinge of the edit loop.
//   closedCards cardIds the user has finalized. Replies still name a version long after its
//                          session is gone, so finality is tracked per card, not per session.
//
// IN MEMORY, like the rate limiter: a restart forgets every open image, and `npm run dev`
// (node --watch) forgets on every file save. Durable state is the full product's Postgres
// (lib/store.js) and is the same roadmap item as the durable spend ledger.

const crypto = require('crypto');

// A bare (non-reply) message edits the open image only while the session is still warm. Past this
// the user has almost certainly moved on, and treating "make a diwali card" as an edit of the
// birthday card they made an hour ago is worse than just making the diwali card.
const EDIT_WINDOW_MS = Number(process.env.EDIT_WINDOW_MIN ?? 30) * 60 * 1000;

// Exact-token match only. "finalize but make the border gold" is an edit, not a finalize — a stray
// substring match would silently close the user's image instead of changing it.
const FINALIZE_TOKENS = new Set(['finalize', 'finalized', 'finalise', 'finalised', 'done', 'final']);
const isFinalize = (text) => FINALIZE_TOKENS.has(text.toLowerCase().replace(/[.!\s]+$/, ''));

// phone -> { cardId, versions: [Version], status: 'open'|'closed', lastActivity }
// A Version is { url, mimeType, prompt } — a Supabase URL, never bytes. See storage.fetchCard.
const sessions = new Map();
// outbound image message SID -> { phone, cardId, version }
const sidToCard = new Map();
// cardIds the user has finalized.
const closedCards = new Set();

function newSession(phone, seedVersions = []) {
  const session = {
    cardId: crypto.randomUUID(),
    versions: [...seedVersions],
    status: 'open',
    lastActivity: Date.now(),
  };
  sessions.set(phone, session);
  return session;
}

function liveSession(phone) {
  const session = sessions.get(phone);
  if (!session || session.status !== 'open') return null;
  if (Date.now() - session.lastActivity > EDIT_WINDOW_MS) return null;
  return session;
}

/**
 * What is this inbound message pointing at?
 *
 * @returns {{ ref: object|null, base: object|null, refIsFinal: boolean }}
 *   base === null means "brand new image"; anything else means "edit this version".
 */
function resolveTarget(phone, repliedSid) {
  const sent = repliedSid ? sidToCard.get(repliedSid) ?? null : null;

  // Only the person we sent an image to may edit it. sidToCard is global and keyed by a SID alone,
  // so without this a sender who names someone else's SID edits THEIR image and gets it back —
  // one WhatsApp user's private design handed to another. Reaching it means guessing a 34-char SID
  // you never received, which is why the full product never tripped over it (it records `phone`
  // here and then never reads it, lib/server.js:355). Free to close, so close it.
  const ref = sent && sent.phone === phone ? sent : null;

  const session = liveSession(phone);

  // A finalized image is done. Replying to one starts fresh instead of editing it — the bot tells
  // users to reply to images, so without this their finished design silently becomes the base for
  // their next, unrelated prompt.
  const refIsFinal = Boolean(ref && closedCards.has(ref.cardId));

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
 */
function resolveSession(phone, ref, base) {
  const session = liveSession(phone);
  if (ref && (!session || session.cardId !== ref.cardId)) {
    console.log(`↪️  Branching new image from ${ref.cardId.slice(0, 8)}`);
    return newSession(phone, [base]);
  }
  return session ?? newSession(phone, base ? [base] : []);
}

/** Record that `version` went out as message `sid`, so a reply to it can be resolved. */
function recordSent(sid, phone, cardId, version) {
  sidToCard.set(sid, { phone, cardId, version });
}

/** Close the image the user pointed at. Returns false if there was nothing to close. */
function closeCard(phone, ref, base) {
  if (!base) return false;

  // Match on version identity rather than cardId: a branched session carries a fresh cardId but
  // shares its seed version with the image it grew from, so a cardId compare misses it and the
  // image can never be closed. Replying "finalize" to an image from some other lineage still must
  // not close whatever is open now.
  const session = sessions.get(phone);
  if (session && session.versions.includes(base)) {
    session.status = 'closed';
    closedCards.add(session.cardId);
  }
  // The image the user pointed at is done too, even if a later session branched off it —
  // otherwise replying to it keeps reviving the same design.
  if (ref) closedCards.add(ref.cardId);
  return true;
}

/** Test seam. */
function reset() {
  sessions.clear();
  sidToCard.clear();
  closedCards.clear();
}

module.exports = {
  EDIT_WINDOW_MS,
  isFinalize,
  newSession,
  liveSession,
  resolveTarget,
  resolveSession,
  recordSent,
  closeCard,
  reset,
  _state: { sessions, sidToCard, closedCards },
};
