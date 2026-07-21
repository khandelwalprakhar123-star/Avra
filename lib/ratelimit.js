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
// KNOWN LIMITATION (v1.1): this counter lives in memory. `npm run dev` is `node --watch`, so
// every file save resets the day's count to zero, and a second server process would keep its own
// tally. The full product moved the ledger to Postgres for exactly this reason (lib/store.js). v1.1
// keeps it in memory by design — the roadmap item that restores a durable ledger is the same one
// that adds the reply-to-edit loop.

// What we hold against the cap while a generation is in flight, before the real cost is known.
// gpt-image-2 medium/portrait runs ~₹4 for a fresh generation and more for an edit (which sends the
// base image in); 4.5 leaves a little headroom so the reservation rarely under-holds. The real cost
// settles in right after, so this value only affects the brief in-flight window.
const EST_PER_GEN_INR = Number(process.env.EST_PER_GEN_INR || 4.5);
const MAX_GLOBAL_INR_PER_DAY = Number(process.env.MAX_GLOBAL_INR_PER_DAY || 200);

const DAY_MS = 24 * 60 * 60 * 1000;

// One entry per generation, all senders: { t: timestamp, inr: cost (reserved, then settled) }.
let ledger = [];

// ₹ is a rounding-error minefield (4.5 * 3 === 13.5, but token math produces long tails), and the
// cap is compared with a strict >. Round to paise so a boundary case cannot flip on float noise.
const inr = (n) => Math.round(n * 100) / 100;

function totalToday(now) {
  ledger = ledger.filter((e) => now - e.t < DAY_MS);
  return inr(ledger.reduce((s, e) => s + e.inr, 0));
}

/**
 * Ask permission to generate.
 *
 * @param {string} phone
 * @returns {{ refusal: string|null, settle: (actualInr?: number) => void }}
 *   refusal — a user-facing string when the day's budget is spent, else null.
 *   settle  — call once generation finishes with the REAL ₹ cost (from the token usage). Pass 0
 *             (or nothing) to refund the reservation when the call failed before OpenAI billed.
 */
function check(phone) {
  const now = Date.now();
  const spent = totalToday(now);

  if (inr(spent + EST_PER_GEN_INR) > MAX_GLOBAL_INR_PER_DAY) {
    console.warn(`🚫 Global daily budget hit (₹${spent}/₹${MAX_GLOBAL_INR_PER_DAY}) — refusing ${phone}`);
    return { refusal: 'The bot has hit its daily budget. Please try again tomorrow 🙏', settle() {} };
  }

  const entry = { t: now, inr: EST_PER_GEN_INR };
  ledger.push(entry);
  console.log(`⚖️  ${phone}: ~₹${inr(spent + EST_PER_GEN_INR)}/₹${MAX_GLOBAL_INR_PER_DAY} today (reserved; settles after generation)`);

  // Idempotent: the first settle wins. The success path settles with the real cost right after
  // generation; a failure in a *later* step (upload/session/send) must not settle a second time
  // and refund a charge OpenAI already made.
  let settled = false;
  return {
    refusal: null,
    settle(actualInr) {
      if (settled) return;
      settled = true;
      entry.inr = typeof actualInr === 'number' && isFinite(actualInr) ? inr(actualInr) : 0;
      entry.t = Date.now(); // stamp at settle so the 24h window tracks when the spend actually landed
      console.log(`⚖️  ${phone}: ₹${totalToday(Date.now())}/₹${MAX_GLOBAL_INR_PER_DAY} today`);
    },
  };
}

module.exports = { check, EST_PER_GEN_INR, MAX_GLOBAL_INR_PER_DAY };
