// Spend caps. The Twilio sandbox number is shared and public — anyone who joins with the sandbox
// code can message this bot, and every one of their messages is a genuine, correctly-signed Twilio
// request. Signature validation proves a request came from Twilio; it does NOT prove who sent it.
// Without these ceilings the only thing bounding the Gemini bill is Gemini's own spend cap.
//
// Two windows, both enforced:
//   • per sender  — 50 generations / hour  (a single person cannot run away with it)
//   • global      — ₹200 / day             (N senders each under their own limit still cannot
//                                            combine into a runaway bill)
//
// KNOWN LIMITATION (v1.1): these counters live in memory. `npm run dev` is `node --watch`, so
// every file save resets the day's count to zero, and a second server process would keep its own
// tally. The full product moved the ledger to Postgres for exactly this reason (lib/store.js). v1.1
// keeps it in memory by design — the roadmap item that restores a durable ledger is the same one
// that adds the reply-to-edit loop.

// The ₹/day ceiling can only be enforced by counting generations and multiplying, since nothing
// here can see the real Gemini bill. So this figure is an ESTIMATE, and the cap is only as honest
// as it is. Measured for Nano Banana Lite at THINKING_LEVEL=high:
//   image             ~$0.0336            ≈ ₹3.00
//   thinking          ~970 tok @ $1.50/M  ≈ ₹0.15   (billed at the text-output rate)
//                                           ─────
//                                           ≈ ₹3.15  → 3.2 with a little headroom
// At 3.2 the ₹200/day ceiling allows ~62 generations. Drop to 3.0 if THINKING_LEVEL=minimal.
const COST_PER_GEN_INR = Number(process.env.COST_PER_GEN_INR || 3.2);
const MAX_PER_SENDER_PER_HOUR = Number(process.env.MAX_PER_SENDER_PER_HOUR || 50);
const MAX_GLOBAL_INR_PER_DAY = Number(process.env.MAX_GLOBAL_INR_PER_DAY || 200);

const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const DAY_MS = 24 * 60 * 60 * 1000;

// phone -> [timestamps of generations]
const senderHits = new Map();
// timestamps of every generation, all senders
let globalHits = [];

// ₹ is a rounding-error minefield (3.2 * 3 === 9.600000000000001), and the cap is compared with
// a strict >. Round to paise so a boundary case cannot flip on float noise.
const inr = (n) => Math.round(n * 100) / 100;

/**
 * Ask permission to generate. Returns null when the request may proceed, or a user-facing refusal
 * string when it may not. Records the hit on success — an attempt that reaches generation is what
 * costs money, so it is counted whether or not Gemini ultimately returns an image.
 */
function check(phone) {
  const now = Date.now();

  globalHits = globalHits.filter((t) => now - t < DAY_MS);
  const spentInr = inr(globalHits.length * COST_PER_GEN_INR);
  if (inr(spentInr + COST_PER_GEN_INR) > MAX_GLOBAL_INR_PER_DAY) {
    console.warn(`🚫 Global daily budget hit (₹${spentInr}/₹${MAX_GLOBAL_INR_PER_DAY}) — refusing ${phone}`);
    return 'The bot has hit its daily budget. Please try again tomorrow 🙏';
  }

  const hits = (senderHits.get(phone) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= MAX_PER_SENDER_PER_HOUR) {
    const waitMin = Math.ceil((RATE_WINDOW_MS - (now - hits[0])) / 60000);
    console.warn(`🚫 Rate limit hit by ${phone} (${hits.length}/${MAX_PER_SENDER_PER_HOUR})`);
    return `You've made ${MAX_PER_SENDER_PER_HOUR} images in the last hour — that's the limit. Try again in about ${waitMin} minute${waitMin === 1 ? '' : 's'} ⏳`;
  }

  hits.push(now);
  senderHits.set(phone, hits);
  globalHits.push(now);
  const spent = inr(globalHits.length * COST_PER_GEN_INR);
  console.log(`⚖️  ${phone}: ${hits.length}/${MAX_PER_SENDER_PER_HOUR} this hour · ₹${spent}/₹${MAX_GLOBAL_INR_PER_DAY} today`);
  return null;
}

module.exports = { check, COST_PER_GEN_INR, MAX_PER_SENDER_PER_HOUR, MAX_GLOBAL_INR_PER_DAY };
