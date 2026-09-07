export type Envelope = {
  version: 1;
  algorithm: 'AES-256-GCM';
  kdf: 'PBKDF2-SHA256';
  iterations: 600000;
  compression: 'gzip';
  salt: string;
  iv: string;
  ciphertext: string;
};
export type VaultSession = { key: CryptoKey; salt: string };
const encoder = new TextEncoder();
function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
function bytes(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0)
    throw new Error('Invalid encrypted library.');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
export function validateEnvelope(value: unknown): Envelope {
  const e = value as Envelope;
  if (
    !e ||
    e.version !== 1 ||
    e.algorithm !== 'AES-256-GCM' ||
    e.kdf !== 'PBKDF2-SHA256' ||
    e.iterations !== 600000 ||
    e.compression !== 'gzip' ||
    typeof e.salt !== 'string' ||
    typeof e.iv !== 'string' ||
    typeof e.ciphertext !== 'string' ||
    e.ciphertext.length > 80_000_000 ||
    bytes(e.salt).length !== 16 ||
    bytes(e.iv).length !== 12 ||
    bytes(e.ciphertext).length < 16
  )
    throw new Error('Invalid or unsupported encrypted library.');
  return e;
}
async function derive(password: string, salt: string): Promise<VaultSession> {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: bytes(salt), iterations: 600000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { key, salt };
}
export async function createSession(password: string): Promise<VaultSession> {
  if (password.length < 16)
    throw new Error('Use a password of at least 16 characters.');
  return derive(password, base64(crypto.getRandomValues(new Uint8Array(16))));
}
async function transform(
  data: Uint8Array<ArrayBuffer>,
  mode: 'compress' | 'decompress',
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data])
    .stream()
    .pipeThrough(
      mode === 'compress'
        ? new CompressionStream('gzip')
        : new DecompressionStream('gzip'),
    );
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > 80_000_000) {
      await reader.cancel();
      throw new Error('Library is too large.');
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
export async function seal(
  value: unknown,
  session: VaultSession,
): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const compressed = await transform(
    encoder.encode(JSON.stringify(value)),
    'compress',
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    session.key,
    compressed,
  );
  return {
    version: 1,
    algorithm: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: 600000,
    compression: 'gzip',
    salt: session.salt,
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(encrypted)),
  };
}
export async function openWithSession(
  value: unknown,
  session: VaultSession,
): Promise<unknown> {
  const e = validateEnvelope(value);
  if (e.salt !== session.salt)
    throw new Error('This backup uses a different library password.');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes(e.iv), tagLength: 128 },
    session.key,
    bytes(e.ciphertext),
  );
  return JSON.parse(
    new TextDecoder().decode(
      await transform(new Uint8Array(plain), 'decompress'),
    ),
  );
}
export async function unlock(
  value: unknown,
  password: string,
): Promise<{ value: unknown; session: VaultSession }> {
  const e = validateEnvelope(value);
  const session = await derive(password, e.salt);
  return { value: await openWithSession(e, session), session };
}
export async function fingerprint(e: Envelope): Promise<string> {
  const b = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode([e.salt, e.iv, e.ciphertext].join(':')),
  );
  return [...new Uint8Array(b)]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
