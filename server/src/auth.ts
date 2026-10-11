import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const calc = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return calc.length === expected.length && timingSafeEqual(calc, expected);
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export const SESSION_COOKIE = 'wb_session';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14일
