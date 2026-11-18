/** Token estimation used by L5 output normalization. @module */

const ASCII_LIMIT = 0x80;
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

/**
 * Estimates tokens as `ceil(asciiChars / 4 + nonAsciiChars)`.
 *
 * Characters are counted as Unicode code points, so an astral symbol (an emoji, for example) is
 * one non-ASCII character rather than two UTF-16 code units.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < ASCII_LIMIT) {
      ascii += 1;
      continue;
    }

    nonAscii += 1;
    // Count a surrogate pair once: skip its low half, which is not a separate character.
    if (code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= LOW_SURROGATE_MIN && next <= LOW_SURROGATE_MAX) i += 1;
    }
  }

  return Math.ceil(ascii / 4 + nonAscii);
}
