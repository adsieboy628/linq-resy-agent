// AES-256-GCM via Web Crypto (Deno-native).

import { env } from './env.ts';

function hexToBytes(hex: string): Uint8Array {
  if (hex.length !== 64) throw new Error('SNIPER_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToB64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function getKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', hexToBytes(env.credentialEncryptionKey), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(plaintext: string): Promise<{ ciphertext: string; iv: string; tag: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await getKey();
  const enc = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)));
  // Web Crypto appends the 16-byte tag to ciphertext. Split for compat with Node format.
  const tag = enc.slice(enc.length - 16);
  const ct = enc.slice(0, enc.length - 16);
  return { ciphertext: bytesToB64(ct), iv: bytesToB64(iv), tag: bytesToB64(tag) };
}

export async function decrypt(ciphertext: string, iv: string, tag: string): Promise<string> {
  const key = await getKey();
  const ct = b64ToBytes(ciphertext);
  const tagBytes = b64ToBytes(tag);
  const combined = new Uint8Array(ct.length + tagBytes.length);
  combined.set(ct, 0);
  combined.set(tagBytes, ct.length);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(iv) }, key, combined);
  return new TextDecoder().decode(plain);
}
