// The image generator — the one place bytes come back from the image model.
//
// Generation runs on OpenAI's gpt-image-2. This replaced Gemini (Nano Banana); that path is gone
// and its SDK is no longer a dependency, but the previous version of this file is in git history if
// it is ever wanted back. The rest of the harness never knew the difference — rate limits and spend
// caps still live in server.js / lib/ratelimit.js, and generate() still returns { bytes, mimeType }.
//
// v1.1 is deliberately thin. There is no retrieval, no style guide, no JSON brief. The user's
// text (and any reference images they attached) goes straight to the image model, and an image
// comes back. Everything clever the full product does — Tool B's catalogue search, the art
// director's style guide, the canonical-slot brief — is stripped out here on purpose.
//
// What is kept, because it is load-bearing regardless of how thin the pipeline is:
//   • withRetry()      — the image endpoint 500s / 429s intermittently on well-formed requests.
//   • the < MIN_CARD_BYTES guard — a "successful" response can still be a degenerate tiny image
//     that is billed like a real one. Throwing keeps it from ever being delivered.

require('dotenv').config();
const OpenAI = require('openai');
const { toFile } = require('openai');
const { costFromUsage } = require('./pricing');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = process.env.IMAGE_MODEL || 'gpt-image-2';

// gpt-image-2's `quality` knob: 'low' | 'medium' | 'high' | 'auto'. This is RENDERING quality
// (output polish/detail), NOT a reasoning/"thinking" level — gpt-image-2 has no separate thinking
// pass. 'medium' is the cost/latency vs. detail middle ground.
const IMAGE_QUALITY = process.env.IMAGE_QUALITY || 'medium';

// Portrait ratio. 1024x1536 is 2:3 — both edges divisible by 16, ~1.57MP, well inside gpt-image-2's
// size constraints. Override with IMAGE_SIZE (e.g. 1024x1024 square, 1536x1024 landscape).
const IMAGE_SIZE = process.env.IMAGE_SIZE || '1024x1536';

// Floor for "this is a real image". Genuine gpt-image-2 outputs at this size/quality run into the
// hundreds of KB to low MB; a degenerate/blank response is far smaller. 10KB sits in the empty gap
// between the two, so it rejects blanks without any risk of discarding a real image.
const MIN_CARD_BYTES = 10_000;

// Only retry what is worth retrying. A 400 means the request is wrong and will be wrong again;
// a content-policy block will block again. Retrying those burns the user's time and can bill per
// attempt. 429/5xx are transient and worth a couple of backed-off retries.
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
  const isEdit = Boolean(base);
  const hasReferences = references.length > 0;
  const promptText = buildPrompt(prompt, { hasReferences, isEdit });

  const what = isEdit ? '✏️  Editing' : '🖼️  Generating';
  console.log(`${what}${hasReferences ? ` with ${references.length} reference image(s)` : isEdit ? '' : ' (text only)'}`);

  // Any input image (a base to edit, or references to draw on) means we go through the edits
  // endpoint, which is the only one that accepts image inputs. Order matters and is load-bearing:
  // the base goes FIRST, because buildPrompt refers to it by position ("the FIRST image provided")
  // whenever references ride along with an edit. gpt-image-2 applies any mask to the first image
  // only; we pass no mask, so the whole first image is editable.
  if (isEdit || hasReferences) {
    const inputs = [];
    if (base) inputs.push(await toImageFile(base, 'base'));
    for (let i = 0; i < references.length; i++) inputs.push(await toImageFile(references[i], `ref${i}`));
    return runImageModel({ prompt: promptText, image: inputs });
  }

  return runImageModel({ prompt: promptText });
}

// Turn our { data: Buffer, mimeType } shape into an uploadable file for the OpenAI SDK.
async function toImageFile({ data, mimeType }, name) {
  const ext = (mimeType && mimeType.split('/')[1]) || 'png';
  return toFile(data, `${name}.${ext}`, { type: mimeType || 'image/png' });
}

// The single path back from the model, so the degenerate-image guard below can never be bypassed.
// `image` present → edits endpoint (input images); absent → generate endpoint (text only).
async function runImageModel({ prompt, image = null }) {
  const response = await withRetry(() => {
    const params = { model: MODEL, prompt, size: IMAGE_SIZE, quality: IMAGE_QUALITY };
    return image ? openai.images.edit({ ...params, image }) : openai.images.generate(params);
  });

  // The real cost of THIS call, read off the token meters gpt-image-2 billed. Computed before the
  // guards below so a billed-but-discarded image is still charged accurately: the cost is attached
  // to the thrown error and the caller settles the ledger with it (see server.js).
  const usage = response.usage || null;
  const cost = usage ? costFromUsage(usage) : null;
  if (cost) {
    const { textInput, imageInput, imageOutput } = cost.tokens;
    console.log(
      `💰 ${MODEL}: ${textInput}t text-in + ${imageInput}t img-in + ${imageOutput}t img-out ` +
        `→ $${cost.usd.toFixed(4)} ≈ ₹${cost.inr}`
    );
  }

  // gpt-image-2 always returns base64 image data (no hosted URL), regardless of response_format.
  const b64 = response.data?.[0]?.b64_json;
  if (!b64) {
    throw Object.assign(new Error('OpenAI did not return an image (check prompt/content policy/quota).'), { cost });
  }

  const bytes = Buffer.from(b64, 'base64');

  if (bytes.length < MIN_CARD_BYTES) {
    throw Object.assign(
      new Error(
        `OpenAI returned a degenerate ${bytes.length}-byte image (expected >${MIN_CARD_BYTES}). ` +
          'Discarded rather than delivered.'
      ),
      { cost }
    );
  }

  // gpt-image-2 returns PNG by default. The declared type must match the real bytes: Twilio rejects
  // media whose payload disagrees with its Content-Type (error 63019), and storage.js sets the
  // Content-Type on the uploaded object from exactly this value.
  const mimeType = mimeFromBytes(bytes);

  return { bytes, mimeType, usage, cost };
}

// Sniff the real container from magic bytes so the declared Content-Type can never disagree with
// the payload. gpt-image-2 defaults to PNG; we still check in case output_format ever changes.
function mimeFromBytes(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'; // ‰PNG
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'; // JPEG SOI
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'image/png';
}

module.exports = { MODEL, IMAGE_QUALITY, IMAGE_SIZE, MIN_CARD_BYTES, buildPrompt, generate, runImageModel };
