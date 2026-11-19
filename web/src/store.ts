import type { Lang } from './i18n.js';

export type PresenceState = 'online' | 'away' | 'dnd' | 'hidden' | 'offline';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'user';
  quotaBytes: number;
  usedBytes: number;
  totpEnabled: boolean;
  presence: PresenceState;
  readReceipts: boolean;
  quickShare: boolean;
  locale: string;
  theme: string;
  createdAt: number;
}

export interface Contact {
  id: string;
  username: string;
  displayName: string;
  status: 'online' | 'away' | 'dnd' | 'offline';
  blocked: boolean;
  quickShare: boolean;
}

export interface AppConfig {
  appName: string;
  version: string;
  tagline: string;
  defaultLocale: string;
  needsSetup: boolean;
  setupWindowOpen: boolean;
  maxUploadBytes: number;
  maxQuickShareBytes: number;
  turnConfigured: boolean;
  vapidPublicKey: string;
  features: Record<string, boolean>;
}

export interface ChatAttachment {
  fileId: string;
  name: string;
  size: number;
  mime: string;
  kind: string;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  sender: { id: string; username: string; displayName: string };
  body: string;
  replyToId: string | null;
  createdAt: number;
  attachments: ChatAttachment[];
  reactions: Array<{ emoji: string; count: number; mine: boolean }>;
  replyTo?: { body: string; senderName: string } | null;
  readBy?: number;
}

export interface Room {
  id: string;
  kind: 'dm' | 'group' | 'channel';
  name: string | null;
  title: string;
  updatedAt: number;
  unread: number;
  readReceipts: boolean;
  muted: boolean;
  members: Array<{ id: string; username: string; displayName: string; status: string }>;
  lastMessage: { id: string; senderId: string; preview: string; createdAt: number } | null;
}

interface State {
  user: User | null;
  config: AppConfig | null;
  contacts: Contact[];
  rooms: Room[];
  lang: Lang;
  theme: 'system' | 'light' | 'dark' | 'black';
  unread: number;
  online: Set<string>;
}

export const state: State = {
  user: null,
  config: null,
  contacts: [],
  rooms: [],
  lang: 'it',
  theme: 'system',
  unread: 0,
  online: new Set(),
};

export function setUser(user: User | null): void {
  state.user = user;
}

export function setConfig(config: AppConfig): void {
  state.config = config;
}

export function setContacts(contacts: Contact[]): void {
  state.contacts = contacts;
  state.online = new Set(contacts.filter((contact) => contact.status !== 'offline').map((contact) => contact.id));
}

export function contactById(id: string): Contact | undefined {
  return state.contacts.find((contact) => contact.id === id);
}

export function contactName(id: string): string {
  if (state.user?.id === id) return state.user.displayName;
  return contactById(id)?.displayName ?? 'Utente';
}

export function applyPresence(
  userId: string,
  status: 'online' | 'away' | 'dnd' | 'offline',
  displayName?: string,
): void {
  const contact = state.contacts.find((entry) => entry.id === userId);
  if (contact) {
    contact.status = status;
    if (displayName) contact.displayName = displayName;
  }
  // Chat rooms and the board keep their own member snapshots loaded through
  // the REST API. Refresh them here so avatars and DM subtitles change live
  // instead of only after a page reload.
  for (const room of state.rooms) {
    for (const member of room.members) {
      if (member.id !== userId) continue;
      member.status = status;
      if (displayName) member.displayName = displayName;
    }
  }
  if (status === 'offline') state.online.delete(userId);
  else state.online.add(userId);
}

export function recomputeUnread(): void {
  state.unread = state.rooms.reduce((total, room) => total + room.unread, 0);
}

export function storageUsed(): { used: number; quota: number; percent: number } {
  const used = state.user?.usedBytes ?? 0;
  const quota = state.user?.quotaBytes ?? 1;
  return { used, quota, percent: quota > 0 ? Math.min(100, (used / quota) * 100) : 0 };
}
