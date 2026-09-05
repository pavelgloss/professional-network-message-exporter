export type CanonicalUrlView = {
  url: URL;
  pathname: string;
  search: string;
  query: Array<{ name: string; value: string }>;
};

const encodedOctet = /%[0-9a-f]{2}/i;
const malformedEscape = /%(?![0-9a-f]{2})/i;
const controlCharacter = /[\u0000-\u001f\u007f]/;

export function repeatedlyDecodeAndNormalize(value: string, maxPasses = 8): string | undefined {
  let current: string;
  try { current = value.normalize('NFKC'); } catch { return undefined; }
  if (controlCharacter.test(current)) return undefined;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    if (malformedEscape.test(current)) return undefined;
    if (!encodedOctet.test(current)) return current;
    try {
      const decoded = decodeURIComponent(current).normalize('NFKC');
      if (controlCharacter.test(decoded)) return undefined;
      if (decoded === current) return current;
      current = decoded;
    } catch { return undefined; }
  }
  // More encoding layers are intentionally treated as ambiguous input.
  return encodedOctet.test(current) || malformedEscape.test(current) ? undefined : current;
}

export function canonicalUrlView(rawUrl: string, base?: string | URL): CanonicalUrlView | undefined {
  let url: URL;
  try { url = new URL(rawUrl, base); } catch { return undefined; }
  const pathname = repeatedlyDecodeAndNormalize(url.pathname);
  const search = repeatedlyDecodeAndNormalize(url.search);
  if (pathname === undefined || search === undefined) return undefined;
  const query: Array<{ name: string; value: string }> = [];
  for (const [rawName, rawValue] of url.searchParams) {
    const name = repeatedlyDecodeAndNormalize(rawName);
    const value = repeatedlyDecodeAndNormalize(rawValue);
    if (name === undefined || value === undefined) return undefined;
    query.push({ name, value });
  }
  return { url, pathname, search, query };
}
