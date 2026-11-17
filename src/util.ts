import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { badRequest } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function newId(): string {
  return randomUUID();
}

export function nowMs(): number {
  return Date.now();
}

export function assertUuid(value: unknown, field = 'id'): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw badRequest(`Identificatore non valido: ${field}`);
  return value;
}

export function optionalUuid(value: unknown, field = 'id'): string | null {
  if (value === undefined || value === null || value === '') return null;
  return assertUuid(value, field);
}

/**
 * Sanitize a user-supplied display name. It is never used to build a filesystem path.
 */
export function sanitizeFileName(input: unknown): string {
  if (typeof input !== 'string') return 'file';
  let name = input.normalize('NFKC');
  // Strip control characters, bidi overrides and path separators.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate control-character filtering
  name = name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
  name = name.replace(/[/\\]/g, '_');
  name = name.replace(/\.{2,}/g, '_');
  name = name
    .replace(/^\.+/, '')
    .replace(/[. ]+$/g, '')
    .trim();
  name = name.slice(0, 180);
  if (!name) return 'file';
  return name;
}

export function sanitizePlainText(input: unknown, maxLength: number): string {
  if (typeof input !== 'string') throw badRequest('Testo non valido');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately stripping NUL bytes
  const cleaned = input.replace(/\r\n/g, '\n').replace(/\u0000/g, '');
  const trimmed = cleaned.trim();
  if (trimmed.length > maxLength) throw badRequest('Testo troppo lungo', 'text_too_long');
  return trimmed;
}

export function sanitizeHeaderFilename(name: string): string {
  return (
    name
      .replace(/[\r\n"]/g, '_')
      .replace(/[^\x20-\x7e]/g, '_')
      .slice(0, 150) || 'file'
  );
}

export function contentDisposition(name: string, inline: boolean): string {
  const ascii = sanitizeHeaderFilename(name);
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function parseInteger(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) return Number(value);
  return fallback;
}

export function clearCookieOptions(secure: boolean): string {
  return `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
