import { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import type { Config } from '../config.js';
import { decryptRange, parseRange, unwrapKey } from '../crypto.js';
import { contentSecurityHeaders } from '../http/security.js';
import type { Secrets } from '../secrets.js';
import { isInlineMime } from '../sniff.js';
import { contentDisposition } from '../util.js';

export interface ContentSource {
  id: string;
  name: string;
  size: number;
  mime: string;
  version: number;
  wrapped_key: string | null;
  storage_path: string | null;
  scan_status: string;
}

export interface ContentConfig {
  config: Config;
  secrets: Secrets;
}

function contentTypeFor(source: ContentSource, inline: boolean): string {
  if (!inline) return 'application/octet-stream';
  if (source.mime === 'application/json') return 'text/plain; charset=utf-8';
  if (source.mime.startsWith('text/')) return 'text/plain; charset=utf-8';
  return source.mime;
}

/**
 * Streams decrypted file content with user-content hardening. Only whitelisted
 * MIME types are ever served inline; HTML/SVG/XML are always attachments.
 */
export async function sendContent(
  reply: FastifyReply,
  deps: ContentConfig,
  source: ContentSource,
  options: { inline: boolean; rangeHeader?: string | undefined },
): Promise<FastifyReply> {
  if (source.scan_status === 'infected') {
    return reply.code(410).send({ error: 'file_quarantined' });
  }
  if (source.scan_status === 'error') {
    return reply.code(423).send({ error: 'file_unavailable' });
  }
  if (!source.wrapped_key || !source.storage_path) {
    return reply.code(404).send({ error: 'not_found' });
  }
  const inline = options.inline && isInlineMime(source.mime);
  const range = parseRange(options.rangeHeader, source.size);
  if (options.rangeHeader && !range) {
    reply.code(416).header('Content-Range', `bytes */${source.size}`);
    return reply.send();
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : Math.max(0, source.size - 1);
  const length = source.size === 0 ? 0 : end - start + 1;

  for (const [key, value] of Object.entries(contentSecurityHeaders())) reply.header(key, value);
  reply.header('Content-Type', contentTypeFor(source, inline));
  reply.header('Content-Disposition', contentDisposition(source.name, inline));
  reply.header('Content-Length', String(length));
  reply.header('Accept-Ranges', 'bytes');
  if (range) reply.header('Content-Range', `bytes ${start}-${end}/${source.size}`);
  reply.code(range ? 206 : 200);

  if (source.size === 0) return reply.send();

  const key = unwrapKey(deps.secrets.masterKey, source.wrapped_key, `file:${source.id}:${source.version}`);
  const generator = decryptRange({
    path: source.storage_path,
    fileKey: key,
    fileId: source.id,
    version: source.version,
    start,
    end,
  });
  return reply.send(Readable.from(generator));
}

export function isInlineRequested(value: unknown): boolean {
  return value !== '1' && value !== 'true';
}
