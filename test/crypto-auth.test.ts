import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/server/crypto.js';
import { parseSessionCookie, safeNext } from '../src/server/auth.js';

describe('token encryption', () => {
  const key = randomBytes(32).toString('base64');

  it('round-trips and never stores plain text', () => {
    const sealed = encrypt('xoxb-secret', key);
    expect(sealed).not.toContain('xoxb');
    expect(decrypt(sealed, key)).toBe('xoxb-secret');
  });

  it('rejects tampered data and the wrong key', () => {
    const sealed = encrypt('xoxb-secret', key);
    const parts = sealed.split('.');
    parts[3] = Buffer.from('xoxb-forged').toString('base64url');
    expect(() => decrypt(parts.join('.'), key)).toThrow();
    expect(() => decrypt(sealed, randomBytes(32).toString('base64'))).toThrow();
  });
});

describe('auth helpers', () => {
  it('only redirects to same-site paths after sign in', () => {
    expect(safeNext('/chart?user=U1')).toBe('/chart?user=U1');
    expect(safeNext('https://evil.example')).toBe('/chart');
    expect(safeNext('//evil.example')).toBe('/chart');
    expect(safeNext('/\\evil.example')).toBe('/chart');
    expect(safeNext(undefined)).toBe('/chart');
  });

  it('parses session cookies', () => {
    const secret = 'a'.repeat(43);
    expect(parseSessionCookie(`T123.${secret}`)).toEqual({ tenant: 'T123', secret });
    expect(parseSessionCookie(`E9.${secret}`)).toEqual({ tenant: 'E9', secret });
    expect(parseSessionCookie(`T123.short`)).toBeNull();
    expect(parseSessionCookie(`'; DROP.${secret}`)).toBeNull();
    expect(parseSessionCookie(undefined)).toBeNull();
  });
});
