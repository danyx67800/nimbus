import type { AppConfig, ChatMessage, Contact, Room, User } from './store.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let csrfToken = '';

export function setCsrf(token: string): void {
  csrfToken = token;
}

export function getCsrf(): string {
  return csrfToken;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  csrf?: boolean;
  signal?: AbortSignal;
}

function emitUnauthorized(): void {
  window.dispatchEvent(new CustomEvent('nimbus:unauthorized'));
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { Accept: 'application/json', ...(options.headers ?? {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD' && (options.csrf ?? true) && csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
    redirect: 'error',
  });
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const record = (data ?? {}) as { error?: string; message?: string };
    if (response.status === 401 && !path.startsWith('/api/auth/login')) emitUnauthorized();
    throw new ApiError(
      response.status,
      record.error ?? `http_${response.status}`,
      record.message ?? 'Errore del server',
    );
  }
  return data as T;
}

export function downloadUrl(fileId: string, options: { inline?: boolean } = {}): string {
  return `/api/files/${encodeURIComponent(fileId)}/content${options.inline === false ? '?download=1' : ''}`;
}

export async function fetchTextPreview(fileId: string): Promise<{ text: string; truncated: boolean }> {
  const response = await fetch(downloadUrl(fileId), {
    credentials: 'same-origin',
    headers: { Range: 'bytes=0-262143', Accept: 'text/plain' },
  });
  if (!response.ok) throw new ApiError(response.status, 'preview_failed', 'Anteprima non disponibile');
  const text = await response.text();
  return { text, truncated: response.status === 206 };
}

export async function getConfig(): Promise<AppConfig> {
  return api<AppConfig>('/api/config', { csrf: false });
}

export interface SessionResponse {
  user: User;
  csrfToken: string;
  expiresAt: number;
}

export async function login(
  username: string,
  password: string,
): Promise<SessionResponse | { twoFactorRequired: true; challengeId: string; methods: string[] }> {
  return api('/api/auth/login', { method: 'POST', body: { username, password }, csrf: false });
}

export async function verifyTwoFactor(
  challengeId: string,
  code: string,
  method: 'totp' | 'recovery',
): Promise<SessionResponse> {
  return api('/api/auth/2fa', { method: 'POST', body: { challengeId, code, method }, csrf: false });
}

export async function getMe(): Promise<SessionResponse> {
  return api<SessionResponse>('/api/auth/me');
}

export async function logout(): Promise<void> {
  await api('/api/auth/logout', { method: 'POST' });
}

export async function listContacts(): Promise<Contact[]> {
  const response = await api<{ users: Contact[] }>('/api/users');
  return response.users;
}

export async function listRooms(): Promise<Room[]> {
  const response = await api<{ rooms: Room[] }>('/api/chat/rooms');
  return response.rooms;
}

export async function getMessages(
  roomId: string,
  options: { before?: number; q?: string } = {},
): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (options.before) params.set('before', String(options.before));
  if (options.q) params.set('q', options.q);
  return api(`/api/chat/rooms/${encodeURIComponent(roomId)}/messages?${params.toString()}`);
}

export async function markRead(roomId: string, messageId?: string): Promise<void> {
  await api(`/api/chat/rooms/${encodeURIComponent(roomId)}/read`, {
    method: 'POST',
    body: messageId ? { messageId } : {},
  });
}

export interface UploadHandle {
  uploadId: string;
  chunkSize: number;
  targetFileId: string;
  nextIndex: number;
}

export async function createUpload(
  name: string,
  size: number,
  parentId: string | null,
  sha256: string,
): Promise<UploadHandle> {
  return api<UploadHandle>('/api/uploads', {
    method: 'POST',
    body: { name, parentId, size, sha256 },
  });
}

export async function putChunk(uploadId: string, index: number, data: Blob): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(`/api/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers,
    body: data,
  });
  if (!response.ok) {
    let message = 'Caricamento non riuscito';
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // ignore
    }
    throw new ApiError(response.status, 'upload_chunk_failed', message);
  }
}

export async function completeUpload(
  uploadId: string,
  sha256: string,
): Promise<{ item: { id: string; name: string; size: number; parentId: string | null } }> {
  return api(`/api/uploads/${encodeURIComponent(uploadId)}/complete`, {
    method: 'POST',
    body: { sha256 },
  });
}

export async function uploadStatus(
  uploadId: string,
): Promise<{ nextIndex: number; receivedBytes: number; size: number; chunkSize: number }> {
  return api(`/api/uploads/${encodeURIComponent(uploadId)}`);
}

export async function createVersionUpload(fileId: string, size: number): Promise<UploadHandle> {
  return api<UploadHandle>(`/api/files/${encodeURIComponent(fileId)}/versions/upload`, {
    method: 'POST',
    body: { size },
  });
}

async function pushChunks(
  handle: UploadHandle,
  file: File,
  sha256: string,
  onProgress: (fraction: number) => void,
): Promise<{ id: string; name: string; size: number; parentId: string | null }> {
  let index = handle.nextIndex;
  let offset = index * handle.chunkSize;
  let failures = 0;
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(offset + handle.chunkSize, file.size));
    try {
      await putChunk(handle.uploadId, index, chunk);
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures > 5) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 400 * failures));
      try {
        const status = await uploadStatus(handle.uploadId);
        if (status.nextIndex > index) {
          index = status.nextIndex;
          offset = index * status.chunkSize;
          failures = 0;
          onProgress(file.size === 0 ? 1 : Math.min(1, offset / file.size));
          continue;
        }
      } catch {
        // keep retrying the same chunk
      }
      continue;
    }
    offset += chunk.size;
    index += 1;
    onProgress(file.size === 0 ? 1 : Math.min(1, offset / file.size));
  }
  const result = await completeUpload(handle.uploadId, sha256);
  onProgress(1);
  return result.item;
}

export async function uploadFile(
  file: File,
  parentId: string | null,
  sha256: string,
  onProgress: (fraction: number) => void,
): Promise<{ id: string; name: string; size: number; parentId: string | null }> {
  const handle = await createUpload(file.name, file.size, parentId, sha256);
  return pushChunks(handle, file, sha256, onProgress);
}

export async function uploadFileVersion(
  fileId: string,
  file: File,
  sha256: string,
  onProgress: (fraction: number) => void,
): Promise<{ id: string; name: string; size: number; parentId: string | null }> {
  const handle = await createVersionUpload(fileId, file.size);
  return pushChunks(handle, file, sha256, onProgress);
}

export async function fetchIceServers(): Promise<{ iceServers: RTCIceServer[]; configured: boolean }> {
  return api('/api/calls/ice');
}

export async function blockUser(userId: string, blocked: boolean): Promise<void> {
  await api(`/api/users/${encodeURIComponent(userId)}/block`, {
    method: blocked ? 'POST' : 'DELETE',
    body: blocked ? {} : undefined,
  });
}

export async function pushSubscription(): Promise<{ publicKey: string }> {
  return api('/api/push/public-key', { csrf: false });
}

export async function savePushSubscription(subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON();
  await api('/api/push/subscribe', {
    method: 'POST',
    body: { endpoint: json.endpoint, keys: json.keys },
  });
}
