import fs from 'node:fs';
import net from 'node:net';
import type { Config } from './config.js';
import type { ScannerPort } from './context.js';
import type { Logger } from './logger.js';

const MAX_SCAN_BYTES = 2 * 1024 * 1024 * 1024;

function scanStream(
  host: string,
  port: number,
  stream: NodeJS.ReadableStream,
  timeoutMs = 30_000,
): Promise<{ clean: boolean; signature?: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let response = '';
    let settled = false;
    const finish = (result: { clean: boolean; signature?: string } | Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('ClamAV timeout')), timeoutMs);
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish(new Error('ClamAV timeout')));
    socket.on('error', (error) => {
      clearTimeout(timer);
      finish(error);
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (response.includes('\0')) {
        clearTimeout(timer);
        const message = response.split('\0')[0] ?? '';
        if (/\bOK$/.test(message.trim())) finish({ clean: true });
        else {
          const match = /: (.+) FOUND$/.exec(message.trim());
          finish({ clean: false, signature: match?.[1] ?? 'unknown' });
        }
      }
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (!settled) {
        if (response.trim().endsWith('OK')) finish({ clean: true });
        else finish(new Error('ClamAV connection closed before a verdict'));
      }
    });
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      let sent = 0;
      stream.on('data', (chunk: Buffer) => {
        if (settled) return;
        sent += chunk.length;
        if (sent > MAX_SCAN_BYTES) {
          finish(new Error('ClamAV stream too large'));
          return;
        }
        const length = Buffer.alloc(4);
        length.writeUInt32BE(chunk.length, 0);
        socket.write(length);
        socket.write(chunk);
      });
      stream.on('end', () => {
        if (!settled) socket.write(Buffer.alloc(4));
      });
      stream.on('error', (error) => finish(error));
    });
  });
}

export class ClamAvScanner implements ScannerPort {
  readonly enabled: boolean;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.enabled = Boolean(config.clamavHost);
  }

  async scanBuffer(buffer: Buffer, label: string): Promise<{ clean: boolean; signature?: string }> {
    if (!this.enabled) return { clean: true };
    const { Readable } = await import('node:stream');
    const result = await scanStream(this.config.clamavHost as string, this.config.clamavPort, Readable.from(buffer));
    this.logResult(label, result);
    return result;
  }

  async scanFile(path: string): Promise<{ clean: boolean; signature?: string }> {
    if (!this.enabled) return { clean: true };
    const result = await scanStream(
      this.config.clamavHost as string,
      this.config.clamavPort,
      fs.createReadStream(path),
    );
    this.logResult(path.split('/').pop() ?? 'file', result);
    return result;
  }

  private logResult(label: string, result: { clean: boolean; signature?: string }): void {
    if (!result.clean) this.logger.warn('ClamAV detected malware', { label, signature: result.signature ?? 'unknown' });
  }
}
