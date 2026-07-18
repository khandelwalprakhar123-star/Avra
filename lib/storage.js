// Image hosting via Supabase Storage.
//
// Twilio does not accept image bytes — it takes a public HTTPS URL and pulls the file itself.
// The full product ran images off local disk behind ngrok; v1.1 uploads each generated image to
// a public Supabase Storage bucket instead, so the URL survives a server restart and does not
// depend on the ngrok tunnel staying up.
//
// This module uses Supabase only for Storage — a bucket of image files addressed by a random
// UUID. The edit-loop state lives in tables in the same project (lib/session.js, db/schema.sql).
//
// Uses the SERVICE ROLE key. It bypasses everything; server-side only, never ship it to a browser.

require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. See .env.example');
}

const BUCKET = process.env.SUPABASE_BUCKET || 'cards';

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }, // a server, not a browser
});

// The bucket MUST be public — Twilio fetches the URL with no credentials. Created on first use
// and cached, so the getBucket round-trip happens once per process, not once per card.
let ensured = false;
async function ensureBucket() {
  if (ensured) return;

  const { data } = await db.storage.getBucket(BUCKET);
  if (!data) {
    const { error } = await db.storage.createBucket(BUCKET, { public: true });
    // A race between two boots can have both try to create it; "already exists" is success.
    if (error && !/already exists|resource already exists/i.test(error.message)) throw error;
    console.log(`🪣  Created public storage bucket "${BUCKET}"`);
  }
  ensured = true;
}

/**
 * Upload one generated image and return its public URL.
 *
 * @param {Buffer} bytes
 * @param {string} mimeType   'image/png' | 'image/jpeg' — set as the object's Content-Type so
 *                            Twilio's payload/type check (error 63019) passes.
 * @returns {Promise<string>} public HTTPS URL Twilio can fetch
 */
async function uploadCard(bytes, mimeType) {
  await ensureBucket();

  const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
  const objectPath = `${crypto.randomUUID()}.${ext}`;

  const { error } = await db.storage
    .from(BUCKET)
    .upload(objectPath, bytes, { contentType: mimeType, upsert: false });
  if (error) throw error;

  const { data } = db.storage.from(BUCKET).getPublicUrl(objectPath);
  return data.publicUrl;
}

/**
 * Fetch a previously-uploaded image back, to feed it to the model as the base for an edit.
 *
 * The full product read its base image off local disk (fs.readFileSync(version.filePath)); v1.1's
 * disk IS this bucket, so this is the direct equivalent. Sessions therefore hold a URL rather than
 * ~1MB of Buffer per version — every image ever sent stays reachable via sidToCard, so holding
 * bytes instead would mean never freeing any of them.
 *
 * The bucket is public, so no auth header is needed here.
 *
 * @param {string} url  a public URL previously returned by uploadCard()
 * @returns {Promise<{ data: Buffer, mimeType: string }>}
 */
async function fetchCard(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch base image for edit (HTTP ${res.status}): ${url}`);

  const data = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get('content-type') || 'image/png';
  return { data, mimeType };
}

module.exports = { uploadCard, fetchCard, BUCKET };
