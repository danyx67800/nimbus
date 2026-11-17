import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { type NimbusRuntime, startNimbus } from '../src/bootstrap.js';

export interface TestRuntime {
  runtime: NimbusRuntime;
  base: string;
  dir: string;
  close: () => Promise<void>;
}

export async function createRuntime(): Promise<TestRuntime> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-test-'));
  const runtime = await startNimbus({
    ...process.env,
    NODE_ENV: 'test',
    NIMBUS_TEST: '1',
    LOG_LEVEL: 'silent',
    DATA_DIR: dir,
    PORT: '0',
    TRUST_PROXY: 'false',
    SETUP_WINDOW_MINUTES: '10',
    SESSION_TTL_DAYS: '1',
  });
  return {
    runtime,
    base: runtime.url,
    dir,
    close: async () => {
      await runtime.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

export class Client {
  cookies = new Map<string, string>();
  csrf = '';

  constructor(readonly base: string) {}

  cookieHeader(): string {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
  }

  private storeCookies(headers: Headers): void {
    const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    for (const raw of values) {
      const [pair] = raw.split(';');
      if (!pair) continue;
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const key = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '') this.cookies.delete(key);
      else this.cookies.set(key, value);
    }
  }

  async request<T = Record<string, unknown>>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      raw?: Buffer;
      csrf?: boolean;
      origin?: string | null;
      headers?: Record<string, string>;
    } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (this.cookies.size > 0) headers.Cookie = this.cookieHeader();
    const method = options.method ?? (options.body !== undefined || options.raw ? 'POST' : 'GET');
    if (method !== 'GET' && method !== 'HEAD') {
      if (options.origin !== null) headers.Origin = options.origin ?? this.base;
    }
    if (options.csrf && this.csrf) headers['X-CSRF-Token'] = this.csrf;
    let body: BodyInit | undefined;
    if (options.raw) {
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/octet-stream';
      body = options.raw;
    } else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const response = await fetch(`${this.base}${path}`, { method, headers, body, redirect: 'manual' });
    this.storeCookies(response.headers);
    const contentType = response.headers.get('content-type') ?? '';
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = buffer.toString('utf8');
    let parsed: unknown = null;
    if (contentType.includes('json')) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    return { status: response.status, headers: response.headers, body: (parsed ?? {}) as T, text };
  }

  async login(
    username: string,
    password: string,
  ): Promise<ApiResponse<{ csrfToken?: string; twoFactorRequired?: boolean }>> {
    const response = await this.request<{ csrfToken?: string; twoFactorRequired?: boolean }>('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    if (response.body.csrfToken) this.csrf = response.body.csrfToken;
    return response;
  }

  async setup(username: string, password: string, displayName = 'Admin'): Promise<ApiResponse<{ csrfToken?: string }>> {
    const response = await this.request<{ csrfToken?: string }>('/api/setup', {
      method: 'POST',
      body: { username, displayName, password },
    });
    if (response.body.csrfToken) this.csrf = response.body.csrfToken;
    return response;
  }

  async upload(
    name: string,
    content: Buffer,
    parentId: string | null = null,
  ): Promise<ApiResponse<{ item?: { id: string; name: string; size: number } }>> {
    const checksum = crypto.createHash('sha256').update(content).digest('hex');
    const created = await this.request<{ uploadId: string; chunkSize: number }>('/api/uploads', {
      method: 'POST',
      body: { name, parentId, size: content.length, sha256: checksum },
      csrf: true,
    });
    if (created.status !== 200) return created as ApiResponse<{ item?: { id: string; name: string; size: number } }>;
    const uploadId = created.body.uploadId;
    let index = 0;
    for (let offset = 0; offset < content.length; offset += created.body.chunkSize) {
      const chunk = content.subarray(offset, Math.min(offset + created.body.chunkSize, content.length));
      const pushed = await this.request(`/api/uploads/${uploadId}/chunks/${index}`, {
        method: 'PUT',
        raw: chunk,
        csrf: true,
      });
      if (pushed.status !== 200) return pushed as ApiResponse<{ item?: { id: string; name: string; size: number } }>;
      index += 1;
    }
    return this.request('/api/uploads/' + uploadId + '/complete', {
      method: 'POST',
      body: { sha256: checksum },
      csrf: true,
    });
  }

  async download(fileId: string, query = ''): Promise<{ status: number; data: Buffer; headers: Headers }> {
    const headers: Record<string, string> = {};
    if (this.cookies.size > 0) headers.Cookie = this.cookieHeader();
    const response = await fetch(`${this.base}/api/files/${fileId}/content${query}`, { headers });
    return { status: response.status, data: Buffer.from(await response.arrayBuffer()), headers: response.headers };
  }

  async connectWs(): Promise<WebSocket> {
    const wsUrl = `${this.base.replace(/^http/, 'ws')}/ws`;
    const socket = new WebSocket(wsUrl, { headers: { Cookie: this.cookieHeader(), Origin: this.base } });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off('message', onMessage);
        reject(new Error('timeout waiting for realtime ready'));
      }, 5000);
      const onMessage = (raw: WebSocket.RawData): void => {
        try {
          const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (parsed.type === 'ready') {
            clearTimeout(timer);
            socket.off('message', onMessage);
            resolve();
          }
        } catch {
          // ignore
        }
      };
      socket.on('message', onMessage);
      socket.once('close', (code) => {
        clearTimeout(timer);
        socket.off('message', onMessage);
        reject(new Error(`closed ${code}`));
      });
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    await ready;
    return socket;
  }
}

export async function waitForMessage(
  socket: WebSocket,
  type: string,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`timeout waiting for ${type}`));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData): void => {
      try {
        const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (parsed.type === type) {
          clearTimeout(timer);
          socket.off('message', onMessage);
          resolve(parsed);
        }
      } catch {
        // ignore non-JSON frames
      }
    };
    socket.on('message', onMessage);
    socket.once('close', () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      reject(new Error('closed while waiting'));
    });
  });
}

export async function waitForClose(socket: WebSocket, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for close')), timeoutMs);
    socket.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

export async function makeAdmin(base: string): Promise<Client> {
  const admin = new Client(base);
  const setup = await admin.setup('admin', 'CorrectHorseBattery42!', 'Admin');
  if (setup.status !== 200) throw new Error(`setup failed: ${setup.status} ${setup.text}`);
  return admin;
}

export async function createUser(
  admin: Client,
  username: string,
  password: string,
  quotaBytes?: number,
): Promise<Client> {
  const created = await admin.request('/api/admin/users', {
    method: 'POST',
    csrf: true,
    body: {
      username,
      displayName: username,
      password,
      role: 'user',
      ...(quotaBytes !== undefined ? { quotaBytes } : {}),
    },
  });
  if (created.status !== 200) throw new Error(`create user failed: ${created.status} ${created.text}`);
  const client = new Client(admin.base);
  const login = await client.login(username, password);
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${login.text}`);
  return client;
}
