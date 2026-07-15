// Tiro v1.1 — the whole harness.
//
// One job: a WhatsApp message (text, and/or attached reference images) comes in via Twilio; the
// text and images go straight to Gemini's image model (Nano Banana Lite); the generated image is
// uploaded to Supabase Storage and sent back. That is the entire pipeline.
//
//   Twilio ──POST /whatsapp──► [ rate-limit ] ──► [ download refs ] ──► Gemini ──► Supabase Storage ──► Twilio
//
// What v1.1 deliberately does NOT do (all present in the full product, all stripped here):
//   • no catalogue search / embeddings (Tool B)
//   • no clarifying questions / conversation state machine (Tool A)
//   • no art-direction style guide
//   • no database — Supabase is used for image hosting only, no tables
//   • no edit loop — every message is a fresh, one-shot generation (edit loop is the next release)

require('dotenv').config();

const express = require('express');
const twilio = require('twilio');

const { generate } = require('./lib/generate');
const { uploadCard } = require('./lib/storage');
const { downloadReferences } = require('./lib/media');
const ratelimit = require('./lib/ratelimit');

const app = express();
app.use(express.urlencoded({ extended: false }));

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  GEMINI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  PUBLIC_BASE_URL,
  PORT = 3000,
} = process.env;

// Fail loudly on boot, not on the first user's message.
for (const [name, value] of Object.entries({
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  GEMINI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  PUBLIC_BASE_URL,
})) {
  if (!value) throw new Error(`Missing required env var: ${name}. See .env.example`);
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Twilio signs every webhook with the auth token. Without this check the endpoint is a public,
// unauthenticated image generator: anyone who finds the URL can spend your Gemini credits in a
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

  console.log(`Message from ${from}: ${promptText || '(no text)'}${numMedia ? ` [+${numMedia} media]` : ''}`);

  // Nothing to work with — no text and no attachments.
  if (!promptText && !numMedia) {
    return sayTwiml(res, "Send me a description of the image you'd like 🪔 You can attach reference photos too.");
  }

  const refusal = ratelimit.check(from);
  if (refusal) return sayTwiml(res, refusal);

  // Ack IMMEDIATELY, then work asynchronously. Twilio's webhook read timeout is 15s and it does
  // not retry a timeout by default — it just fails with error 11200 and the user gets nothing.
  // Downloading references + generating + uploading is ~15-20s, so the final image always goes
  // out via the REST API below, never in the webhook response.
  sayTwiml(res, '✨ Working on your image, give me ~15-20 seconds...');

  try {
    const references = numMedia ? await downloadReferences(req.body) : [];
    const { bytes, mimeType } = await generate({ prompt: promptText, references });
    const url = await uploadCard(bytes, mimeType);

    await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_FROM,
      to: from,
      mediaUrl: [url],
      body: 'Here you go! 🪔 Send another prompt any time.',
    });
    console.log(`📤 Sent image to ${from}: ${url}`);
  } catch (err) {
    console.error(`❌ Generation failed [status=${err.status ?? 'n/a'}]:`, err.message);
    await notify(from, 'Sorry, something went wrong generating that. Try again?');
  }
});

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

app.listen(PORT, () => {
  console.log(`Tiro v1.1 listening on port ${PORT}`);
  if (!VALIDATE_SIGNATURE) {
    console.warn(
      '⚠️  TWILIO SIGNATURE VALIDATION IS OFF (VALIDATE_TWILIO_SIGNATURE=false).\n' +
        '   /whatsapp will accept any POST and generate images against your Gemini key.\n' +
        '   Never run this way with a public URL.'
    );
  }
});
