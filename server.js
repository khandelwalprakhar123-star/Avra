// wcgen v1.1 — the whole harness.
//
// A WhatsApp message (text, and/or attached reference images) comes in via Twilio; it goes to
// OpenAI's image model (gpt-image-2); the generated image is uploaded to Supabase Storage and
// sent back. Replying to an image edits it, so refinement is a back-and-forth rather than a reroll.
//
//   Twilio ──POST /whatsapp──► [ rate-limit ] ──► [ download refs ] ──► OpenAI ──► Supabase ──► Twilio
//                                   │
//                                   └─ replying to an image? ─► fetch it from Supabase ─► edit it
//
// What v1.1 deliberately does NOT do (all present in the full product, all stripped here):
//   • no catalogue search / embeddings (Tool B)
//   • no clarifying questions / conversation state machine (Tool A)
//   • no art-direction style guide
//   • no catalogue database — Supabase now holds the edit-loop state (db/schema.sql) so replies
//     survive a restart, but there are still no product tables (catalogue, users, spend ledger).
//     The spend ledger is still in memory (lib/ratelimit.js) — the same roadmap item as Postgres.

require('dotenv').config();

const express = require('express');
const twilio = require('twilio');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  PUBLIC_BASE_URL,
  PORT = 3000,
} = process.env;

// Fail loudly on boot, not on the first user's message.
//
// This runs BEFORE the ./lib requires below, and that order is load-bearing: each of those modules
// builds its client at module load (lib/generate.js constructs the OpenAI client, lib/storage.js and
// lib/session.js construct Supabase clients). Required after them, a missing OPENAI_API_KEY surfaces
// as a raw "Missing credentials" stack trace from inside the SDK instead of the message below.
for (const [name, value] of Object.entries({
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  PUBLIC_BASE_URL,
})) {
  if (!value) throw new Error(`Missing required env var: ${name}. See .env.example`);
}

const { generate } = require('./lib/generate');
const { uploadCard, fetchCard } = require('./lib/storage');
const { downloadReferences } = require('./lib/media');
const ratelimit = require('./lib/ratelimit');
const session = require('./lib/session');

const app = express();
app.use(express.urlencoded({ extended: false }));

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// The edit loop's state and its rules live in lib/session.js, so they can be exercised without a
// phone. This file stays what it always was: the glue between Twilio, OpenAI, and Supabase.

// Twilio signs every webhook with the auth token. Without this check the endpoint is a public,
// unauthenticated image generator: anyone who finds the URL can spend your OpenAI credits in a
// loop. Twilio computes the signature over the exact URL it called, so it must be built from
// PUBLIC_BASE_URL — behind ngrok, req.protocol/req.host are the local tunnel and the hash won't
// match. VALIDATE_TWILIO_SIGNATURE=false is the escape hatch for local curl testing only.
const VALIDATE_SIGNATURE = process.env.VALIDATE_TWILIO_SIGNATURE !== 'false';

const requireTwilioSignature = twilio.webhook(TWILIO_AUTH_TOKEN, {
  url: `${PUBLIC_BASE_URL}/whatsapp`,
  validate: VALIDATE_SIGNATURE,
});

app.post('/whatsapp', requireTwilioSignature, async (req, res) => {
  const from = req.body.From;
  const promptText = (req.body.Body || '').trim();
  const numMedia = Number(req.body.NumMedia || 0);

  // The SID of the image the user swiped-to-reply on, if any. This is the same SID Twilio handed
  // back when we sent that image, which is what makes the reply resolvable.
  const repliedSid = req.body.OriginalRepliedMessageSid;
  const { ref, base, refIsFinal } = await session.resolveTarget(from, repliedSid);

  console.log(
    `Message from ${from}: ${promptText || '(no text)'}` +
      `${numMedia ? ` [+${numMedia} media]` : ''}${ref ? ' [reply]' : ''}`
  );

  if (session.isFinalize(promptText)) return await finalize(res, from, ref, base, refIsFinal);

  // Nothing to work with.
  if (!promptText && !numMedia) {
    return sayTwiml(
      res,
      base
        ? 'Tell me what to change ✏️ e.g. "make the background a deeper blue"'
        : "Send me a description of the image you'd like 🪔 You can attach reference photos too."
    );
  }

  const gate = ratelimit.check(from);
  if (gate.refusal) return sayTwiml(res, gate.refusal);

  // Ack IMMEDIATELY, then work asynchronously. Twilio's webhook read timeout is 15s and it does
  // not retry a timeout by default — it just fails with error 11200 and the user gets nothing.
  // Fetching the base + generating + uploading is ~10-20s, so the image always goes out via the
  // REST API below, never in the webhook response.
  const editing = Boolean(base);
  sayTwiml(
    res,
    editing
      ? '✏️ Got it, editing your image. Give me ~15-20 seconds...'
      : '✨ Working on your image, give me ~15-20 seconds...'
  );

  try {
    const references = numMedia ? await downloadReferences(req.body) : [];
    const baseImage = editing ? await fetchCard(base.url) : null;

    const { bytes, mimeType, cost } = await generate({ prompt: promptText, references, base: baseImage });
    gate.settle(cost?.inr); // charge the real token-based cost against the day's budget
    const url = await uploadCard(bytes, mimeType);
    const version = { url, mimeType, prompt: promptText };

    // Only reached on success. A failed generation must not push a version, or the next edit would
    // build on an image that was never sent — and a degenerate response would poison the session
    // (see the MIN_CARD_BYTES guard in lib/generate.js).
    const target = editing
      ? await session.resolveSession(from, refIsFinal ? null : ref, base)
      : await session.newSession(from);
    await session.appendVersion(from, target, version);

    await sendCard(from, target, version);
  } catch (err) {
    // Settle the reservation with whatever OpenAI actually billed: a degenerate-but-charged image
    // carries its real cost on err.cost; a call that failed before billing refunds to ₹0.
    gate.settle(err.cost?.inr ?? 0);
    console.error(`❌ ${editing ? 'Edit' : 'Generation'} failed [status=${err.status ?? 'n/a'}]:`, err.message);
    await notify(from, 'Sorry, something went wrong generating that. Try again?');
  }
});

async function finalize(res, from, ref, base, refIsFinal) {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    if (refIsFinal) {
      twiml.message('That one is already finalized ✅ Send a new prompt any time to start fresh.');
    } else if (!(await session.closeCard(from, ref, base))) {
      twiml.message("Nothing to finalize yet — send me a prompt and I'll make you an image.");
    } else {
      console.log(`✅ Finalized image for ${from}`);
      twiml.message('✅ Finalized! Send a new prompt any time to start fresh.');
    }
  } catch (err) {
    console.error(`❌ Finalize failed [status=${err.status ?? 'n/a'}]:`, err.message);
    twiml.message('Sorry, something went wrong. Try again?');
  }

  res.type('text/xml').send(twiml.toString());
}

async function sendCard(from, target, version) {
  const n = target.versions.length;

  const message = await twilioClient.messages.create({
    from: TWILIO_WHATSAPP_FROM,
    to: from,
    mediaUrl: [version.url],
    body:
      n > 1
        ? `Version ${n}. Reply to this image to edit it, or reply "finalize" when you're happy.`
        : 'Here you go! 🪔 Reply to this image to edit it, or reply "finalize" when you\'re happy.',
  });

  // The SID Twilio returns here is the same one that comes back as OriginalRepliedMessageSid when
  // the user replies to this image. This is the whole hinge of the edit loop.
  await session.recordSent(message.sid, from, target.cardId, version);
  console.log(`📤 Sent v${n} (${message.sid}) to ${from}: ${version.url}`);
}

const sayTwiml = (res, text) => {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(text);
  return res.type('text/xml').send(twiml.toString());
};

async function notify(from, body) {
  try {
    await twilioClient.messages.create({ from: TWILIO_WHATSAPP_FROM, to: from, body });
  } catch (err) {
    console.error(`❌ Could not send notice [status=${err.status ?? 'n/a'}]:`, err.message);
  }
}

// Fail loudly on boot if the edit-loop tables are missing — a deploy that skipped db/schema.sql
// would otherwise look healthy and silently drop every reply back to brand-new generation.
session
  .assertSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`wcgen v1.1 listening on port ${PORT}`);
      if (!VALIDATE_SIGNATURE) {
        console.warn(
          '⚠️  TWILIO SIGNATURE VALIDATION IS OFF (VALIDATE_TWILIO_SIGNATURE=false).\n' +
            '   /whatsapp will accept any POST and generate images against your OpenAI key.\n' +
            '   Never run this way with a public URL.'
        );
      }
    });
  })
  .catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
