// The image generator — the one place bytes come back from Gemini (Nano Banana).
//
// v1.1 is deliberately thin. There is no retrieval, no style guide, no JSON brief. The user's
// text (and any reference images they attached) goes straight to the image model, and an image
// comes back. Everything clever the full product does — Tool B's catalogue search, the art
// director's style guide, the canonical-slot brief — is stripped out here on purpose.
//
// What is kept, because it is load-bearing regardless of how thin the pipeline is:
//   • withRetry()      — Gemini's image endpoint 500s intermittently on well-formed requests.
//   • the < MIN_CARD_BYTES guard — Gemini can return a "successful" degenerate 1x1 PNG (~70
//     bytes) that is billed like a real image. Throwing keeps it from ever being delivered.

require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const MODEL = process.env.IMAGE_MODEL || 'gemini-3.1-flash-lite-image'; // Nano Banana Lite

// Floor for "this is a real image". Genuine outputs run ~950KB-1.1MB; the degenerate 1x1 PNGs
// Gemini returned were 70-86 bytes. 10KB sits in the vast empty gap between the two, so it
// rejects blanks without any risk of discarding a real image.
const MIN_CARD_BYTES = 10_000;

// Only retry what is worth retrying. A 400 means the request is wrong and will be wrong again;
// a safety block will block again. Retrying those burns the user's time and can bill per attempt.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(call) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (!RETRYABLE.has(err.status) || attempt === MAX_RETRIES) throw err;
      const wait = 1500 * 2 ** attempt + Math.floor(Math.random() * 500);
      console.warn(`⚠️  Image model ${err.status} — retrying in ${(wait / 1000).toFixed(1)}s (${attempt + 1}/${MAX_RETRIES})`);
      await sleep(wait);
    }
  }
}

// The whole prompt layer in v1.1. No slots, no guide — just the user's words, lightly framed,
// with an instruction about the reference images when there are any.
function buildPrompt(promptText, hasReferences) {
  const text = promptText || 'the attached reference image(s)';
  const base = `Create a beautiful, high-resolution image for this request: "${text}".`;

  if (hasReferences) {
    return (
      base +
      ' Use the attached image(s) as visual reference for style, composition, subject and palette. ' +
      'Produce a new, original image inspired by them — do not reproduce any attachment verbatim.'
    );
  }
  return base + ' Make it visually rich, with tasteful composition and print-quality detail.';
}

/**
 * Generate one image.
 *
 * @param {object}   req
 * @param {string}   req.prompt        the user's text (may be empty if they sent only images)
 * @param {Array}    req.references    [{ data: Buffer, mimeType: string }] — attached reference images
 * @returns {Promise<{ bytes: Buffer, mimeType: string }>} the generated image bytes (NOT written to disk)
 */
async function generate({ prompt, references = [] }) {
  const parts = references.map((ref) => ({
    inlineData: { mimeType: ref.mimeType, data: ref.data.toString('base64') },
  }));
  parts.push({ text: buildPrompt(prompt, references.length > 0) });

  console.log(`🖼️  Generating${references.length ? ` from ${references.length} reference image(s)` : ' (text only)'}`);

  return runImageModel(parts);
}

// The single path back from the model, so the degenerate-image guard below can never be bypassed.
async function runImageModel(parts) {
  const response = await withRetry(() =>
    ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts }],
      config: { responseModalities: ['Image'] },
    })
  );

  const returned = response.candidates?.[0]?.content?.parts || [];
  const imagePart = returned.find((p) => p.inlineData);
  if (!imagePart) {
    throw new Error('Gemini did not return an image (check prompt/safety filters/quota).');
  }

  const bytes = Buffer.from(imagePart.inlineData.data, 'base64');

  if (bytes.length < MIN_CARD_BYTES) {
    throw new Error(
      `Gemini returned a degenerate ${bytes.length}-byte image (expected >${MIN_CARD_BYTES}). ` +
        'Discarded rather than delivered.'
    );
  }

  // Gemini may return JPEG or PNG. The declared type must match the real bytes: Twilio rejects
  // media whose payload disagrees with its Content-Type (error 63019), and storage.js sets the
  // Content-Type on the uploaded object from exactly this value.
  const mimeType = imagePart.inlineData.mimeType || 'image/png';

  return { bytes, mimeType };
}

module.exports = { MODEL, MIN_CARD_BYTES, buildPrompt, generate, runImageModel };
