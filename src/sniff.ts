export type ContentKind = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'archive' | 'binary';

export interface SniffResult {
  mime: string;
  kind: ContentKind;
  /** Only these categories may be served inline; everything else is an attachment. */
  inline: boolean;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const GIF = Buffer.from('GIF8', 'ascii');
const PDF = Buffer.from('%PDF-', 'ascii');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const GZIP = Buffer.from([0x1f, 0x8b]);
const RAR = Buffer.from('RAR!', 'ascii');
const SEVEN_ZIP = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const OGG = Buffer.from('OggS', 'ascii');
const FLAC = Buffer.from('fLaC', 'ascii');
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

function startsWith(buffer: Buffer, prefix: Buffer): boolean {
  return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix);
}

function looksLikeText(buffer: Buffer): { text: boolean; mime: string; kind: ContentKind } {
  if (buffer.includes(0x00)) return { text: false, mime: '', kind: 'binary' };
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return { text: false, mime: '', kind: 'binary' };
  }
  let control = 0;
  for (const char of decoded) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 && char !== '\n' && char !== '\r' && char !== '\t') control += 1;
  }
  if (decoded.length > 0 && control / decoded.length > 0.01) return { text: false, mime: '', kind: 'binary' };
  const head = decoded.trimStart().slice(0, 400).toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
    return { text: true, mime: 'text/html', kind: 'text' };
  }
  if (/<svg[\s>]/i.test(head)) return { text: true, mime: 'image/svg+xml', kind: 'image' };
  if (head.startsWith('<?xml')) return { text: true, mime: 'application/xml', kind: 'text' };
  if (head.startsWith('{') || head.startsWith('[')) {
    return { text: true, mime: 'application/json', kind: 'text' };
  }
  return { text: true, mime: 'text/plain', kind: 'text' };
}

/**
 * Detect the real type from content (never from the extension). The returned
 * `inline` flag is the only thing allowed to drive Content-Disposition.
 */
export function sniffContent(buffer: Buffer): SniffResult {
  if (startsWith(buffer, PNG)) return { mime: 'image/png', kind: 'image', inline: true };
  if (startsWith(buffer, JPEG)) return { mime: 'image/jpeg', kind: 'image', inline: true };
  if (startsWith(buffer, GIF)) return { mime: 'image/gif', kind: 'image', inline: true };
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF') {
    const subtype = buffer.subarray(8, 12).toString('ascii');
    if (subtype === 'WEBP') return { mime: 'image/webp', kind: 'image', inline: true };
    if (subtype === 'WAVE') return { mime: 'audio/wav', kind: 'audio', inline: true };
    if (subtype === 'AVI ') return { mime: 'video/x-msvideo', kind: 'video', inline: false };
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    return { mime: 'video/mp4', kind: 'video', inline: true };
  }
  if (startsWith(buffer, PDF)) return { mime: 'application/pdf', kind: 'pdf', inline: true };
  if (startsWith(buffer, OGG)) {
    const head = buffer.subarray(0, 64).toString('ascii');
    if (head.includes('vorbis') || head.includes('Opus')) return { mime: 'audio/ogg', kind: 'audio', inline: true };
    return { mime: 'video/ogg', kind: 'video', inline: false };
  }
  if (startsWith(buffer, FLAC)) return { mime: 'audio/flac', kind: 'audio', inline: true };
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return { mime: 'video/webm', kind: 'video', inline: true };
  }
  if (startsWith(buffer, Buffer.from('ID3', 'ascii')) || (buffer[0] === 0xff && (buffer[1] ?? 0) >= 0xe0)) {
    return { mime: 'audio/mpeg', kind: 'audio', inline: true };
  }
  if (startsWith(buffer, ZIP)) {
    return { mime: 'application/zip', kind: 'archive', inline: false };
  }
  if (startsWith(buffer, GZIP)) return { mime: 'application/gzip', kind: 'archive', inline: false };
  if (startsWith(buffer, RAR)) return { mime: 'application/vnd.rar', kind: 'archive', inline: false };
  if (startsWith(buffer, SEVEN_ZIP)) return { mime: 'application/x-7z-compressed', kind: 'archive', inline: false };
  if (startsWith(buffer, ELF)) return { mime: 'application/x-elf', kind: 'binary', inline: false };
  if (startsWith(buffer, Buffer.from('MZ', 'ascii')))
    return { mime: 'application/x-msdownload', kind: 'binary', inline: false };
  if (startsWith(buffer, WASM)) return { mime: 'application/wasm', kind: 'binary', inline: false };

  const text = looksLikeText(buffer);
  if (text.text) {
    const safeInline = text.mime === 'text/plain' || text.mime === 'application/json';
    return { mime: text.mime, kind: text.kind, inline: safeInline };
  }
  return { mime: 'application/octet-stream', kind: 'binary', inline: false };
}

export function isPreviewable(sniff: SniffResult): boolean {
  return sniff.inline && ['image', 'pdf', 'video', 'audio', 'text'].includes(sniff.kind);
}

const INLINE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/flac',
  'text/plain',
  'application/json',
]);

/** Only these types may use an inline Content-Disposition. SVG and HTML never qualify. */
export function isInlineMime(mime: string): boolean {
  return INLINE_MIME.has(mime.toLowerCase());
}
