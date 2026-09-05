import { describe, expect, it } from 'vitest';
import { canonicalUrlView, repeatedlyDecodeAndNormalize } from '../../src/domain/url-safety.js';

describe('URL Unicode safety', () => {
  it.each([
    ['C1 NEL', '\u0085'],
    ['zero-width space', '\u200B'],
    ['soft hyphen', '\u00AD'],
    ['bidi override', '\u202E'],
  ])('rejects raw, encoded, and double-encoded Unicode Other %s', (_label, character) => {
    const encoded = encodeURIComponent(character);
    const doubleEncoded = encodeURIComponent(encoded);
    for (const value of [`muta${character}tion`, `muta${encoded}tion`, `muta${doubleEncoded}tion`]) {
      expect(repeatedlyDecodeAndNormalize(value)).toBeUndefined();
    }
    expect(canonicalUrlView(`https://www.linkedin.com/voyager/api/muta${encoded}tion`)).toBeUndefined();
    expect(canonicalUrlView(`https://www.linkedin.com/voyager/api/graphql?na${encoded}me=value`)).toBeUndefined();
    expect(canonicalUrlView(`https://www.linkedin.com/voyager/api/graphql?name=val${doubleEncoded}ue`)).toBeUndefined();
  });
});
