// Spend cap. The Twilio sandbox number is shared and public — anyone who joins with the sandbox
// code can message this bot, and every one of their messages is a genuine, correctly-signed Twilio
// request. Signature validation proves a request came from Twilio; it does NOT prove who sent it.
// Without this ceiling the only thing bounding the OpenAI bill is OpenAI's own spend cap.
//
// One window, enforced globally: ₹200 / day across all senders. There is deliberately no per-sender
// cap — a single sender may spend the whole day's budget. The ₹/day ceiling is what bounds the bill;
// how that spend is distributed between senders is not something this module has an opinion on.
//
// The ledger stores the REAL cost of each generation. We can't know that cost until gpt-image-2
// returns its token usage (~40s later), so this is reserve-then-settle:
//   • check()  reserves EST_PER_GEN_INR against the cap up front and gates on it, so a burst of
//              concurrent requests can't all slip under the ceiling before any has been billed.
//   • settle() replaces that reservation with the actual token-based cost once the call returns
//              (or refunds it to ₹0 if the call failed before OpenAI billed anything).
//
// DURABLE, in Supabase (spend_ledger in db/schema.sql). This used to be an array in memory, which
// meant the day's total reset to ₹0 on every restart — every deploy, every crash, every
// `node --watch` reload. A cap that any redeploy silently lifts is not a cap, and once this runs on
// a host that restarts the process on its own schedule, that stops being a local-dev quirk.
//
// The compare-and-reserve happens inside the reserve_spend SQL function rather than here, because
// in memory "sum the day, compare, append" was one uninterruptible step and across a network it is
// three. See the advisory-lock note in db/schema.sql.
//
// Same Supabase project and SERVICE ROLE key as image hosting and the edit loop.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. See .env.example');
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }, // a server, not a browser
});

// What we hold against the cap while a generation is in flight, before the real cost is known.
// gpt-image-2 medium/portrait runs ~₹4 for a fresh generation and more for an edit (which sends the
// base image in); 4.5 leaves a little headroom so the reservation rarely under-holds. The real cost
// settles in right after, so this value only affects the brief in-flight window.
const EST_PER_GEN_INR = Number(process.env.EST_PER_GEN_INR || 4.5);
const MAX_GLOBAL_INR_PER_DAY = Number(process.env.MAX_GLOBAL_INR_PER_DAY || 200);

const BUDGET_SPENT = 'The bot has hit its daily budget. Please try again tomorrow 🙏';

// ₹ is a rounding-error minefield (4.5 * 3 === 13.5, but token math produces long tails). Round to
// paise on the way in so what we store matches what SQL compared against the cap.
const inr = (n) => Math.round(n * 100) / 100;

const noop = { refusal: null, settle: async () => {} };

/**
 * Ask permission to generate.
 *
 * @param {string} phone
 * @returns {Promise<{ refusal: string|null, settle: (actualInr?: number) => Promise<void> }>}
 *   refusal — a user-facing string when the day's budget is spent, else null.
 *   settle  — await once generation finishes with the REAL ₹ cost (from the token usage). Pass 0
 *             (or nothing) to refund the reservation when the call failed before OpenAI billed.
 */
async function check(phone) {
  const { data, error } = await db.rpc('reserve_spend', {
    p_phone: phone,
    p_reserve: EST_PER_GEN_INR,
    p_cap: MAX_GLOBAL_INR_PER_DAY,
  });

  // Fail CLOSED. If the ledger is unreachable we cannot know what has been spent today, and this
  // check is the only thing standing between a public sandbox number and an unbounded OpenAI bill.
  // Refusing costs a user one message; guessing costs money with no ceiling.
  if (error) {
    console.error(`❌ Spend ledger unreachable, refusing ${phone}: ${error.message}`);
    return { refusal: 'The bot is having trouble right now. Please try again in a minute 🙏', settle: noop.settle };
  }

  const row = data?.[0];
  const spent = Number(row?.spent ?? 0);

  if (!row?.allowed) {
    console.warn(`🚫 Global daily budget hit (₹${spent}/₹${MAX_GLOBAL_INR_PER_DAY}) — refusing ${phone}`);
    return { refusal: BUDGET_SPENT, settle: noop.settle };
  }

  const entryId = row.entry_id;
  console.log(`⚖️  ${phone}: ~₹${spent}/₹${MAX_GLOBAL_INR_PER_DAY} today (reserved; settles after generation)`);

  // Idempotent: the first settle wins. The success path settles with the real cost right after
  // generation; a failure in a *later* step (upload/session/send) must not settle a second time
  // and refund a charge OpenAI already made.
  let settled = false;
  return {
    refusal: null,
    async settle(actualInr) {
      if (settled) return;
      settled = true;

      const amount = typeof actualInr === 'number' && isFinite(actualInr) ? inr(actualInr) : 0;

      // Never throw. settle() is called on the success path mid-`try`, and a ledger write that
      // rejected there would be caught by the generation's own error handler — telling the user
      // their finished image failed, and sending it nowhere. A stuck reservation is the cheaper
      // wrong answer: it over-counts by a few rupees for 24h and expires on its own.
      const { error: updErr } = await db
        .from('spend_ledger')
        .update({ inr: amount, spent_at: new Date().toISOString() })
        .eq('id', entryId);

      if (updErr) {
        console.error(
          `⚠️  Could not settle ₹${amount} for ${phone} (${updErr.message}) — ` +
            `the ₹${EST_PER_GEN_INR} reservation stands against today's cap instead.`
        );
        return;
      }
      console.log(`⚖️  ${phone}: settled ₹${amount} (cap ₹${MAX_GLOBAL_INR_PER_DAY}/day)`);
    },
  };
}

/** ₹ spent in the last 24h. Read-only — for the health check and for tests. */
async function spentToday() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db.from('spend_ledger').select('inr').gt('spent_at', since);
  if (error) throw error;
  return inr(data.reduce((s, r) => s + Number(r.inr), 0));
}

/**
 * Fail loudly on boot if the ledger is missing, rather than on the first user's message — matching
 * session.assertSchema. A deploy that ran an older db/schema.sql would otherwise look healthy and
 * then refuse every single generation, because check() fails closed.
 *
 * p_cap = -1 makes the reservation impossible to grant, so this exercises the real function —
 * proving it exists, is callable by this key, and can read the table — without writing a row.
 */
async function assertSchema() {
  const { error } = await db.rpc('reserve_spend', { p_phone: 'boot-probe', p_reserve: 0, p_cap: -1 });
  if (error) {
    throw new Error(
      `Supabase spend ledger is not reachable (${error.message}). ` +
        'Re-run db/schema.sql in the Supabase SQL editor for the SUPABASE_URL project — ' +
        'it now also creates the spend_ledger table and the reserve_spend function.'
    );
  }
}

/** Test seam. */
async function reset() {
  await db.from('spend_ledger').delete().gt('spent_at', '1970-01-01');
}

module.exports = { check, spentToday, assertSchema, reset, EST_PER_GEN_INR, MAX_GLOBAL_INR_PER_DAY };
