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
      if (!res.ok) {
        console.warn(`⚠️  Could not fetch reference image ${i}: HTTP ${res.status}`);
        continue;
      }
      const mimeType = res.headers.get('content-type') || declaredType;
      const data = Buffer.from(await res.arrayBuffer());
      refs.push({ data, mimeType });
    } catch (err) {
      console.warn(`⚠️  Error fetching reference image ${i}:`, err.message);
    }
  }

  if (refs.length) console.log(`📎 Downloaded ${refs.length} reference image(s)`);
  return refs;
}

module.exports = { downloadReferences, MAX_REFERENCES };
