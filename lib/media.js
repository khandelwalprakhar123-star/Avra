// Reference-image intake — download the images a user attached to their WhatsApp message.
//
// This is the one piece of v1.1 that did NOT exist in the full product: it discarded MediaUrl0..N
// entirely (ARCHITECTURE.md §7, "Reference images: MediaUrl0…N discarded"). v1.1's whole point is
// that a user can attach photos and have them steer the generation, so this is where they come in.
//
// Twilio media sits behind an authenticated URL on api.twilio.com. It is fetched with HTTP Basic
// auth (Account SID : Auth Token). Twilio then 307-redirects to a pre-signed CDN URL that needs no
// auth — and the fetch() spec strips the Authorization header on that cross-origin redirect, which
// is exactly right: the credentials reach Twilio and never leak to the CDN.

require('dotenv').config();

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;

// A single WhatsApp message can only carry a handful of images; this is a sanity ceiling, not a
// product limit. More than this and something is wrong with the request.
const MAX_REFERENCES = Number(process.env.MAX_REFERENCES || 6);

// Only images go to the image model. WhatsApp can also deliver audio, vCards and PDFs as media;
// those are silently skipped rather than shipped to the image model as a "reference".
const IS_IMAGE = /^image\//;

/**
 * Download every image attached to an inbound Twilio webhook.
 *
 * @param {object} body   the parsed req.body from the /whatsapp webhook (NumMedia, MediaUrl0…, MediaContentType0…)
 * @returns {Promise<Array<{ data: Buffer, mimeType: string }>>}
 */
async function downloadReferences(body) {
  const count = Math.min(Number(body.NumMedia || 0), MAX_REFERENCES);
  const auth = 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

  const refs = [];
  for (let i = 0; i < count; i++) {
    const url = body[`MediaUrl${i}`];
    const declaredType = body[`MediaContentType${i}`] || '';
    if (!url || !IS_IMAGE.test(declaredType)) continue;

    try {
      const res = await fetch(url, { headers: { Authorization: auth } });

      // 401/403 is not a per-image hiccup, it is the Twilio credentials being wrong — which means
      // EVERY reference will fail, for every user, until .env is fixed. Skipping it quietly is the
      // worst outcome: the generation proceeds text-only and the user is handed a card that ignored
      // the photo they attached, with nothing anywhere saying why. Fail loudly instead; server.js
      // catches this and tells the user the request failed rather than silently downgrading it.
      if (res.status === 401 || res.status === 403) {
        throw Object.assign(
          new Error(
            `Twilio rejected the media fetch with HTTP ${res.status}. TWILIO_ACCOUNT_SID / ` +
              'TWILIO_AUTH_TOKEN are wrong or expired, so no reference image can be downloaded.'
          ),
          { status: res.status, isConfigError: true }
        );
      }

      if (!res.ok) {
        console.warn(`⚠️  Could not fetch reference image ${i}: HTTP ${res.status}`);
        continue;
      }
      const mimeType = res.headers.get('content-type') || declaredType;
      const data = Buffer.from(await res.arrayBuffer());
      refs.push({ data, mimeType });
    } catch (err) {
      // A credentials failure must not be absorbed by the same catch that shrugs off a flaky
      // download, or the loud error above becomes another silent skip.
      if (err.isConfigError) throw err;
      console.warn(`⚠️  Error fetching reference image ${i}:`, err.message);
    }
  }

  if (refs.length) console.log(`📎 Downloaded ${refs.length} reference image(s)`);
  return refs;
}

module.exports = { downloadReferences, MAX_REFERENCES };
