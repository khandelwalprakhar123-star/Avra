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

// 'high' | 'minimal'. The model defaults to no thinking at all (identical to 'minimal'), so this
// must be set explicitly to get a reasoning pass. Note the image-generation docs claim Flash Lite
// does not support this; that is wrong — the model card is right and the API accepts it.
const THINKING_LEVEL = process.env.THINKING_LEVEL || 'high';

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
//
// Two shapes: a fresh generation, and an edit of an image the user replied to. An edit must say
// "keep everything except what I asked to change", or the model quietly redraws the whole thing
// and the user's fifth tweak throws away the four before it.
function buildPrompt(promptText, { hasReferences = false, isEdit = false } = {}) {
  if (isEdit) {
    // When extra references ride along with an edit there are 2+ images in the request, so
    // "the image provided" stops being unambiguous — the base has to be named by position.
    const which = hasReferences ? 'the FIRST image provided' : 'the image provided';
    const instruction = promptText || 'restyle it using the additional reference image(s) provided';

    let prompt =
      `Apply this edit to ${which}: "${instruction}". ` +
      'Preserve its existing composition, palette, and typography except where the edit requires ' +
      'otherwise. Return the complete edited image at the same high resolution.';

    if (hasReferences) {
      prompt +=
        ' The remaining attached image(s) are visual reference for the edit only — draw on them for ' +
        'style, subject or palette, but do not reproduce any of them verbatim and do not return them.';
    }
    return prompt;
  }

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
 * Generate one image — fresh, or as an edit of an existing one.
 *
 * @param {object}   req
 * @param {string}   req.prompt        the user's text (may be empty if they sent only images)
 * @param {Array}    req.references    [{ data: Buffer, mimeType: string }] — attached reference images
 * @param {object?}  req.base          { data: Buffer, mimeType: string } — the image being edited.
 *                                     Present means edit; absent means fresh generation.
 * @returns {Promise<{ bytes: Buffer, mimeType: string }>} the generated image bytes (NOT written to disk)
 */
async function generate({ prompt, references = [], base = null }) {
  // Order matters and is load-bearing: the base goes FIRST, because buildPrompt refers to it by
  // position ("the FIRST image provided") whenever references ride along with an edit.
  const parts = [];
  if (base) parts.push({ inlineData: { mimeType: base.mimeType, data: base.data.toString('base64') } });
  for (const ref of references) {
    parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.data.toString('base64') } });
  }
  parts.push({ text: buildPrompt(prompt, { hasReferences: references.length > 0, isEdit: Boolean(base) }) });

  const what = base ? '✏️  Editing' : '🖼️  Generating';
  console.log(`${what}${references.length ? ` with ${references.length} reference image(s)` : base ? '' : ' (text only)'}`);

  return runImageModel(parts);
}

// The single path back from the model, so the degenerate-image guard below can never be bypassed.
async function runImageModel(parts) {
  const response = await withRetry(() =>
    ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts }],
      config: {
        responseModalities: ['Image'],
        // Roughly doubles latency (~3.6s → ~7.3s measured) and adds ~970 billed output tokens.
        // Only 'minimal' and 'high' are valid for this model; anything else is a hard 400.
        thinkingConfig: { thinkingLevel: THINKING_LEVEL },
      },
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

module.exports = { MODEL, THINKING_LEVEL, MIN_CARD_BYTES, buildPrompt, generate, runImageModel };
