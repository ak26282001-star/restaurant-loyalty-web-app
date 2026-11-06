const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; // no 0/O/1/l/I

/** Tag codes appear in the tap URL /t/{code}: 6-8 base62 characters. */
export function isValidTagCode(code: string): boolean {
  return /^[A-Za-z0-9]{6,8}$/.test(code);
}

/** Random, unguessable tag code without look-alike characters. */
export function generateTagCode(length = 7, random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(length);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}
