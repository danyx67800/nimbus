import { argon2id, argon2Verify } from 'hash-wasm';

const MEMORY_KIB = 65536;
const ITERATIONS = 3;
const PARALLELISM = 1;
const HASH_LENGTH = 32;

export async function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: crypto.getRandomValues(new Uint8Array(16)),
    parallelism: PARALLELISM,
    iterations: ITERATIONS,
    memorySize: MEMORY_KIB,
    hashLength: HASH_LENGTH,
    outputType: 'encoded',
  });
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash: encoded });
  } catch {
    return false;
  }
}

const COMMON_PASSWORDS = new Set([
  'password',
  'password123',
  '123456789012',
  'qwertyuiop12',
  'amministratore',
  'administrator',
  'ciaociao1234',
  'letmein12345',
  'nimbusnimbus',
]);

export function validatePassword(password: unknown, username: string): string | null {
  if (typeof password !== 'string') return 'La password deve essere una stringa.';
  if (password.length < 12) return 'La password deve avere almeno 12 caratteri.';
  if (password.length > 256) return 'La password è troppo lunga.';
  if (password.trim() !== password) return 'La password non può iniziare o finire con spazi.';
  if (password.toLowerCase().includes(username.toLowerCase())) return 'La password non può contenere il nome utente.';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'Questa password è troppo comune.';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 2) return 'Usa almeno due categorie tra minuscole, maiuscole, numeri e simboli.';
  return null;
}

let dummyHashPromise: Promise<string> | null = null;

/** Equalises login timing when the username does not exist. */
export async function verifyAgainstDummy(password: string): Promise<void> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(`dummy-${Math.random().toString(36)}-timing-equalizer`);
  }
  await verifyPassword(password, await dummyHashPromise);
}
