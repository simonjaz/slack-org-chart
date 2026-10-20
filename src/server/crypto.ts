import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// AES-256-GCM. Output is "v1.<iv>.<tag>.<ciphertext>", each part base64url.
export function encrypt(plaintext: string, keyB64: string): string {
  const key = Buffer.from(keyB64, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv, tag, data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decrypt(payload: string, keyB64: string): string {
  const [version, iv, tag, data] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unrecognised ciphertext');
  const key = Buffer.from(keyB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
