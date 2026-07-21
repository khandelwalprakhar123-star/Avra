// Real per-generation cost, computed from the token `usage` gpt-image-2 returns on every call —
// not a flat estimate. The image API bills three separate meters, each at its own rate:
//
//   input_tokens_details.text_tokens    the prompt                    $5 / 1M tokens
//   input_tokens_details.image_tokens   base + reference images       $8 / 1M tokens   (edits only)
//   output_tokens_details.image_tokens  the generated image           $30 / 1M tokens
//
// So an edit (which sends the base image in) genuinely costs more than a fresh generation, and a
// bigger/higher-quality output costs more than a small one — this reads all of that off `usage`
// instead of pretending every generation costs the same.
//
// Rates are OpenAI list price for gpt-image-2, overridable via env if they change. USD→INR is a
// fixed rate (the bot has no live FX feed); override USD_INR when it drifts.

require('dotenv').config();

const USD_PER_1M = {
  textInput: Number(process.env.PRICE_TEXT_INPUT_USD_PER_1M || 5),
  imageInput: Number(process.env.PRICE_IMAGE_INPUT_USD_PER_1M || 8),
  imageOutput: Number(process.env.PRICE_IMAGE_OUTPUT_USD_PER_1M || 30),
};

const USD_INR = Number(process.env.USD_INR || 98);

const paise = (n) => Math.round(n * 100) / 100;

/**
 * Turn an OpenAI images `usage` object into a real cost.
 * @param {object} usage  the `usage` field from an images.generate / images.edit response
 * @returns {{ usd: number, inr: number, tokens: {textInput:number, imageInput:number, imageOutput:number} }}
 */
function costFromUsage(usage) {
  // Read the detailed breakdown; fall back to the coarse totals if a field is ever absent.
  const textInput = usage?.input_tokens_details?.text_tokens ?? usage?.input_tokens ?? 0;
  const imageInput = usage?.input_tokens_details?.image_tokens ?? 0;
  const imageOutput = usage?.output_tokens_details?.image_tokens ?? usage?.output_tokens ?? 0;

  const usd =
    (textInput * USD_PER_1M.textInput +
      imageInput * USD_PER_1M.imageInput +
      imageOutput * USD_PER_1M.imageOutput) /
    1_000_000;

  return { usd, inr: paise(usd * USD_INR), tokens: { textInput, imageInput, imageOutput } };
}

module.exports = { costFromUsage, USD_PER_1M, USD_INR };
