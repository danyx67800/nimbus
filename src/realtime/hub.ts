import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { audit } from '../audit.js';
import type { SessionRow, UserRow } from '../auth/sessions.js';
import { resolveSession } from '../auth/sessions.js';
import { getMembership, isBlockedBetween, roomMemberIds } from '../chat/service.js';
import type { AppContext, RealtimePort } from '../context.js';
import { isAllowedOrigin } from '../http/security.js';
import { nowMs, parseCookies, sanitizeFileName } from '../util.js';

type HubDeps = Omit<AppContext, 'hub'>;

interface Connection {
  id: string;
  socket: WebSocket;
  user: UserRow;
  session: SessionRow;
  ip: string;
  userAgent: string;
  alive: boolean;
  windowStart: number;
  messages: number;
  typing: Map<string, number>;
}

interface ActiveCall {
  id: string;
  initiator: string;
  kind: 'audio' | 'video';
  participants: Set<string>;
  accepted: Set<string>;
  rejected: Set<string>;
  timer: NodeJS.Timeout;
  startedAt: number;
}

interface TransferRow {
  id: string;
  from_user: string;
  to_user: string;
  file_name: string;
  size: number;
  mime: string;
  sha256: string;
  status: string;
  message_id: string | null;
  created_at: number;
  updated_at: number;
}

const WS_MAX_MESSAGE = 96 * 1024;
const MAX_MESSAGES_PER_MINUTE = 600;
const OFFER_TIMEOUT_MS = 60_000;
const RING_TIMEOUT_MS = 45_000;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

export class RealtimeHub implements RealtimePort {
  private readonly connections = new Map<string, Set<Connection>>();
  private readonly byIp = new Map<string, number>();
  private readonly calls = new Map<string, ActiveCall>();
  private readonly transferTimers = new Map<string, NodeJS.Timeout>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly deps: HubDeps) {}

  attach(app: FastifyInstance): void {
    app.get('/ws', { websocket: true }, (socket, req) => {
      this.handleConnection(socket, req);
    });
    this.heartbeat = setInterval(() => this.checkHeartbeats(), 30_000);
    this.heartbeat.unref();
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const timer of this.transferTimers.values()) clearTimeout(timer);
    this.transferTimers.clear();
    for (const connections of this.connections.values()) {
      for (const connection of connections) {
        try {
          connection.socket.close(1001, 'server shutdown');
        } catch {
          // ignore
        }
      }
    }
    this.connections.clear();
  }

  isOnline(userId: string): boolean {
    return (this.connections.get(userId)?.size ?? 0) > 0;
  }

  onlineUserIds(): string[] {
    return [...this.connections.entries()].filter(([, sockets]) => sockets.size > 0).map(([userId]) => userId);
  }

  presenceFor(userId: string): string {
    if (!this.isOnline(userId)) return 'offline';
    const row = this.deps.db.prepare('SELECT presence FROM users WHERE id = ?').get(userId) as
      | { presence: string }
      | undefined;
    if (!row) return 'offline';
    if (row.presence === 'hidden') return 'offline';
    return row.presence;
  }

  sendToUser(userId: string, payload: Record<string, unknown>): void {
    const sockets = this.connections.get(userId);
    if (!sockets) return;
    const data = JSON.stringify(payload);
    for (const connection of sockets) {
      if (connection.socket.readyState === 1) connection.socket.send(data);
    }
  }

  broadcast(payload: Record<string, unknown>): void {
    const data = JSON.stringify(payload);
    for (const sockets of this.connections.values()) {
      for (const connection of sockets) {
        if (connection.socket.readyState === 1) connection.socket.send(data);
      }
    }
  }

  private handleConnection(socket: WebSocket, req: FastifyRequest): void {
    const origin = req.headers.origin;
    if (!origin || !isAllowedOrigin(req, origin, this.deps.config)) {
      socket.close(4403, 'origin not allowed');
      return;
    }
    const cookies = parseCookies(req.headers.cookie);
    const auth = req.auth ?? resolveSession(this.deps.db, cookies[this.deps.config.cookieName]);
    if (!auth) {
      socket.close(4401, 'unauthorized');
      return;
    }
    const ip = req.ip || 'unknown';
    if ((this.byIp.get(ip) ?? 0) >= 25) {
      socket.close(4429, 'too many connections');
      return;
    }
    let sockets = this.connections.get(auth.user.id);
    if (!sockets) {
      sockets = new Set();
      this.connections.set(auth.user.id, sockets);
    }
    if (sockets.size >= 5) {
      socket.close(4429, 'too many connections');
      return;
    }
    const connection: Connection = {
      id: crypto.randomUUID(),
      socket,
      user: auth.user,
      session: auth.session,
      ip,
      userAgent: String(req.headers['user-agent'] ?? ''),
      alive: true,
      windowStart: Date.now(),
      messages: 0,
      typing: new Map(),
    };
    sockets.add(connection);
    this.byIp.set(ip, (this.byIp.get(ip) ?? 0) + 1);

    socket.on('pong', () => {
      connection.alive = true;
    });
    socket.on('message', (raw) => {
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      if (buffer.length > WS_MAX_MESSAGE) {
        socket.close(4409, 'message too large');
        return;
      }
      this.onMessage(connection, buffer.toString('utf8'));
    });
    socket.on('error', () => {
      // close handler performs cleanup
    });
    socket.on('close', () => this.removeConnection(connection));

    this.emit(connection, {
      type: 'ready',
      user: { id: auth.user.id, displayName: auth.user.display_name, presence: auth.user.presence },
      online: this.onlineUserIds(),
    });
    this.broadcastPresence(auth.user.id);
  }

  private removeConnection(connection: Connection): void {
    const sockets = this.connections.get(connection.user.id);
    if (!sockets || !sockets.delete(connection)) return;
    this.byIp.set(connection.ip, Math.max(0, (this.byIp.get(connection.ip) ?? 1) - 1));
    if (sockets.size === 0) {
      this.connections.delete(connection.user.id);
      this.broadcastPresence(connection.user.id);
      this.abortTransfersOnDisconnect(connection.user.id);
      this.handleCallDisconnect(connection.user.id);
    }
  }

  private broadcastPresence(userId: string): void {
    const row = this.deps.db.prepare('SELECT display_name, presence FROM users WHERE id = ?').get(userId) as
      | { display_name: string; presence: string }
      | undefined;
    if (!row) return;
    this.broadcast({
      type: 'presence:update',
      user: { id: userId, displayName: row.display_name, status: this.presenceFor(userId) },
    });
  }

  private emit(connection: Connection, payload: Record<string, unknown>): void {
    if (connection.socket.readyState === 1) connection.socket.send(JSON.stringify(payload));
  }

  private error(connection: Connection, message: string, code = 'bad_request'): void {
    this.emit(connection, { type: 'error', code, message });
  }

  private checkHeartbeats(): void {
    for (const sockets of this.connections.values()) {
      for (const connection of sockets) {
        if (!connection.alive) {
          connection.socket.terminate();
          continue;
        }
        const active = this.deps.db
          .prepare(
            `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.disabled = 0`,
          )
          .get(connection.session.id, Date.now());
        if (!active) {
          connection.socket.close(4401, 'session expired');
          continue;
        }
        connection.alive = false;
        try {
          connection.socket.ping();
        } catch {
          connection.socket.terminate();
        }
      }
    }
  }

  private onMessage(connection: Connection, raw: string): void {
    const now = Date.now();
    if (now - connection.windowStart > 60_000) {
      connection.windowStart = now;
      connection.messages = 0;
    }
    connection.messages += 1;
    if (connection.messages > MAX_MESSAGES_PER_MINUTE) {
      this.error(connection, 'Troppi messaggi sul canale realtime.', 'rate_limited');
      connection.socket.close(4429, 'rate limited');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.error(connection, 'Payload non valido');
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      this.error(connection, 'Messaggio non valido');
      return;
    }
    try {
      switch (parsed.type) {
        case 'ping':
          this.emit(connection, { type: 'pong', time: now });
          break;
        case 'presence:ping':
          this.emit(connection, {
            type: 'presence:update',
            user: {
              id: connection.user.id,
              displayName: connection.user.display_name,
              status: this.presenceFor(connection.user.id),
            },
          });
          break;
        case 'typing':
          this.handleTyping(connection, parsed);
          break;
        case 'call:invite':
          this.handleCallInvite(connection, parsed);
          break;
        case 'call:accept':
          this.handleCallAccept(connection, parsed);
          break;
        case 'call:reject':
          this.handleCallReject(connection, parsed);
          break;
        case 'call:signal':
          this.handleCallSignal(connection, parsed);
          break;
        case 'call:end':
          this.handleCallEnd(connection, parsed);
          break;
        case 'qs:offer':
          this.handleQuickShareOffer(connection, parsed);
          break;
        case 'qs:accept':
          this.handleQuickShareAccept(connection, parsed);
          break;
        case 'qs:decline':
          this.handleQuickShareDecline(connection, parsed);
          break;
        case 'qs:cancel':
          this.handleQuickShareCancel(connection, parsed);
          break;
        case 'qs:signal':
          this.handleQuickShareSignal(connection, parsed);
          break;
        case 'qs:complete':
          this.handleQuickShareComplete(connection, parsed);
          break;
        case 'qs:fail':
          this.handleQuickShareFail(connection, parsed);
          break;
        default:
          this.error(connection, 'Tipo di messaggio non supportato');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Operazione non consentita';
      this.error(connection, message);
    }
  }

  private handleTyping(connection: Connection, message: Record<string, unknown>): void {
    const roomId = uuid(message.roomId);
    if (!roomId || typeof message.typing !== 'boolean') throw new Error('Richiesta di digitazione non valida');
    if (!getMembership(this.deps.db, roomId, connection.user.id)) throw new Error('Conversazione non trovata');
    const last = connection.typing.get(roomId) ?? 0;
    if (message.typing && Date.now() - last < 1500) return;
    connection.typing.set(roomId, Date.now());
    for (const memberId of roomMemberIds(this.deps.db, roomId)) {
      if (memberId === connection.user.id) continue;
      this.sendToUser(memberId, {
        type: 'typing',
        roomId,
        userId: connection.user.id,
        displayName: connection.user.display_name,
        typing: message.typing,
      });
    }
  }

  private activeCallFor(userId: string): ActiveCall | null {
    for (const call of this.calls.values()) if (call.participants.has(userId)) return call;
    return null;
  }

  private userBasic(userId: string): { id: string; displayName: string; username: string } | null {
    const row = this.deps.db.prepare('SELECT id, display_name, username FROM users WHERE id = ?').get(userId) as
      | { id: string; display_name: string; username: string }
      | undefined;
    return row ? { id: row.id, displayName: row.display_name, username: row.username } : null;
  }

  private handleCallInvite(connection: Connection, message: Record<string, unknown>): void {
    const callId = uuid(message.callId);
    const kind = message.kind === 'video' ? 'video' : 'audio';
    const targetsRaw = Array.isArray(message.to) ? message.to : [];
    const targets = [
      ...new Set(targetsRaw.filter((value): value is string => typeof value === 'string' && UUID_RE.test(value))),
    ];
    if (!callId || targets.length === 0 || targets.length > 3) throw new Error('Chiamata non valida');
    if (targets.includes(connection.user.id)) throw new Error('Destinatario non valido');
    if (this.calls.has(callId)) throw new Error('Chiamata già in corso');
    if (this.activeCallFor(connection.user.id)) {
      this.emit(connection, { type: 'call:busy', callId, reason: 'already_in_call' });
      return;
    }
    const unavailable: string[] = [];
    for (const target of targets) {
      const row = this.deps.db.prepare('SELECT id, disabled FROM users WHERE id = ?').get(target) as
        | { id: string; disabled: number }
        | undefined;
      if (!row || row.disabled) unavailable.push(target);
      else if (!this.isOnline(target) || this.presenceFor(target) === 'offline') unavailable.push(target);
      else if (isBlockedBetween(this.deps.db, connection.user.id, target)) unavailable.push(target);
      else if (this.activeCallFor(target)) {
        this.sendToUser(connection.user.id, { type: 'call:busy', callId, userId: target, reason: 'busy' });
        unavailable.push(target);
      }
    }
    if (unavailable.length > 0) {
      this.emit(connection, { type: 'call:unavailable', callId, userIds: unavailable });
      return;
    }
    const call: ActiveCall = {
      id: callId,
      initiator: connection.user.id,
      kind,
      participants: new Set([connection.user.id, ...targets]),
      accepted: new Set([connection.user.id]),
      rejected: new Set(),
      startedAt: Date.now(),
      timer: setTimeout(() => this.ringTimeout(callId), RING_TIMEOUT_MS),
    };
    call.timer.unref();
    this.calls.set(callId, call);
    const from = this.userBasic(connection.user.id);
    const members = [...call.participants]
      .map((id) => this.userBasic(id))
      .filter((entry): entry is { id: string; displayName: string; username: string } => Boolean(entry));
    for (const target of targets) {
      this.sendToUser(target, { type: 'call:incoming', callId, kind, from, members });
    }
    this.emit(connection, { type: 'call:ringing', callId, invited: targets });
  }

  private handleCallAccept(connection: Connection, message: Record<string, unknown>): void {
    const callId = uuid(message.callId);
    const call = callId ? this.calls.get(callId) : undefined;
    if (!call || !call.participants.has(connection.user.id)) throw new Error('Chiamata non trovata');
    if (call.initiator === connection.user.id) throw new Error('Sei già nella chiamata');
    call.accepted.add(connection.user.id);
    clearTimeout(call.timer);
    for (const participant of call.accepted) {
      if (participant === connection.user.id) continue;
      this.sendToUser(participant, {
        type: participant === call.initiator ? 'call:accepted' : 'call:peer-joined',
        callId,
        userId: connection.user.id,
        user: this.userBasic(connection.user.id),
      });
    }
  }

  private handleCallReject(connection: Connection, message: Record<string, unknown>): void {
    const callId = uuid(message.callId);
    const call = callId ? this.calls.get(callId) : undefined;
    if (!call || !call.participants.has(connection.user.id)) return;
    call.rejected.add(connection.user.id);
    const busy = message.reason === 'busy';
    this.sendToUser(call.initiator, {
      type: 'call:rejected',
      callId,
      userId: connection.user.id,
      busy,
    });
    const pending = [...call.participants].filter(
      (participant) =>
        participant !== call.initiator && !call.accepted.has(participant) && !call.rejected.has(participant),
    );
    if (call.accepted.size <= 1 && pending.length === 0) this.cleanupCall(call, false);
  }

  private handleCallSignal(connection: Connection, message: Record<string, unknown>): void {
    const callId = uuid(message.callId);
    const to = uuid(message.to);
    const call = callId ? this.calls.get(callId) : undefined;
    if (!call || !to || !call.participants.has(connection.user.id) || !call.participants.has(to)) {
      throw new Error('Segnale non valido');
    }
    if (!call.accepted.has(connection.user.id) || connection.user.id === to) throw new Error('Segnale non valido');
    const data = message.data;
    if (!isRecord(data)) throw new Error('Segnale non valido');
    const serialized = JSON.stringify(data);
    if (serialized.length > 60_000) throw new Error('Segnale troppo grande');
    this.sendToUser(to, { type: 'call:signal', callId, from: connection.user.id, data });
  }

  private handleCallEnd(connection: Connection, message: Record<string, unknown>): void {
    const callId = uuid(message.callId);
    const call = callId ? this.calls.get(callId) : undefined;
    if (!call || !call.participants.has(connection.user.id)) return;
    this.endCall(call, connection.user.id);
  }

  private ringTimeout(callId: string): void {
    const call = this.calls.get(callId);
    if (!call) return;
    if (call.accepted.size <= 1) {
      for (const participant of call.participants) {
        this.sendToUser(participant, { type: 'call:timeout', callId });
      }
      this.cleanupCall(call, false);
    }
  }

  private endCall(call: ActiveCall, fromUserId: string): void {
    for (const participant of call.participants) {
      this.sendToUser(participant, { type: 'call:ended', callId: call.id, from: fromUserId });
    }
    this.cleanupCall(call, false);
  }

  private cleanupCall(call: ActiveCall, notify: boolean): void {
    if (notify) {
      for (const participant of call.participants)
        this.sendToUser(participant, { type: 'call:ended', callId: call.id });
    }
    clearTimeout(call.timer);
    if (this.calls.get(call.id) === call) this.calls.delete(call.id);
  }

  private handleCallDisconnect(userId: string): void {
    const call = this.activeCallFor(userId);
    if (!call) return;
    call.accepted.delete(userId);
    call.participants.delete(userId);
    call.rejected.delete(userId);
    for (const participant of call.participants) {
      this.sendToUser(participant, { type: 'call:peer-left', callId: call.id, userId });
    }
    if (call.accepted.size < 2) this.endCall(call, userId);
  }

  private transfer(id: string): TransferRow | null {
    const row = this.deps.db.prepare('SELECT * FROM transfers WHERE id = ?').get(id) as TransferRow | undefined;
    return row ?? null;
  }

  private handleQuickShareOffer(connection: Connection, message: Record<string, unknown>): void {
    const transferId = uuid(message.transferId);
    const to = uuid(message.to);
    const fileName = text(message.fileName, 200);
    const size = message.size;
    const mime = text(message.mime, 120) ?? 'application/octet-stream';
    const sha256 = text(message.sha256, 64);
    if (
      !transferId ||
      !to ||
      !fileName ||
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !sha256
    ) {
      throw new Error('Richiesta di condivisione non valida');
    }
    if (size > this.deps.config.maxQuickShareBytes) throw new Error('File troppo grande per la condivisione rapida');
    if (!SHA256_RE.test(sha256)) throw new Error('Checksum non valido');
    if (to === connection.user.id) throw new Error('Destinatario non valido');
    if (this.transfer(transferId)) throw new Error('Trasferimento già esistente');
    const limit = this.deps.limiter.hit(`qs-offer:${connection.user.id}`, 15, 60_000);
    if (!limit.allowed) throw new Error('Troppe richieste di condivisione, attendi.');
    const pending = this.deps.db
      .prepare("SELECT COUNT(*) AS n FROM transfers WHERE from_user = ? AND status IN ('pending', 'accepted')")
      .get(connection.user.id) as { n: number };
    if (Number(pending.n) >= 3) throw new Error('Hai già troppi trasferimenti in corso');

    const recipient = this.deps.db
      .prepare('SELECT id, display_name, quick_share, presence, disabled FROM users WHERE id = ?')
      .get(to) as
      | { id: string; display_name: string; quick_share: number; presence: string; disabled: number }
      | undefined;
    if (!recipient || recipient.disabled) throw new Error('Destinatario non trovato');
    if (!recipient.quick_share) {
      this.emit(connection, { type: 'qs:unavailable', transferId, reason: 'disabled' });
      return;
    }
    if (!this.isOnline(to) || this.presenceFor(to) === 'offline') {
      this.emit(connection, { type: 'qs:unavailable', transferId, reason: 'offline' });
      return;
    }
    if (isBlockedBetween(this.deps.db, connection.user.id, to)) throw new Error('Trasferimento non consentito');

    const now = nowMs();
    this.deps.db
      .prepare(
        `INSERT INTO transfers (id, from_user, to_user, file_name, size, mime, sha256, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(transferId, connection.user.id, to, sanitizeFileName(fileName), size, mime, sha256.toLowerCase(), now, now);
    const timer = setTimeout(() => this.quickShareTimeout(transferId), OFFER_TIMEOUT_MS);
    timer.unref();
    this.transferTimers.set(transferId, timer);
    const from = this.userBasic(connection.user.id);
    const safeName = sanitizeFileName(fileName);
    this.sendToUser(to, {
      type: 'qs:offer',
      transferId,
      from,
      fileName: safeName,
      size,
      mime,
      sha256: sha256.toLowerCase(),
      expiresAt: now + OFFER_TIMEOUT_MS,
    });
    this.emit(connection, {
      type: 'qs:ringing',
      transferId,
      to,
      fileName: safeName,
      size,
      mime,
      sha256: sha256.toLowerCase(),
    });
    audit(this.deps.db, {
      actorId: connection.user.id,
      action: 'quick_share.offer',
      targetType: 'transfer',
      targetId: transferId,
      ip: connection.ip,
      userAgent: connection.userAgent,
      meta: { to, size, sha256: sha256.toLowerCase() },
    });
  }

  private quickShareTimeout(transferId: string): void {
    this.transferTimers.delete(transferId);
    const transfer = this.transfer(transferId);
    if (!transfer || transfer.status !== 'pending') return;
    this.deps.db
      .prepare("UPDATE transfers SET status = 'timeout', updated_at = ? WHERE id = ?")
      .run(nowMs(), transferId);
    this.sendToUser(transfer.to_user, { type: 'qs:timeout', transferId });
    this.sendToUser(transfer.from_user, { type: 'qs:timeout', transferId });
  }

  private quickShareParticipant(connection: Connection, message: Record<string, unknown>): TransferRow {
    const transferId = uuid(message.transferId);
    const transfer = transferId ? this.transfer(transferId) : null;
    if (!transfer) throw new Error('Trasferimento non trovato');
    if (transfer.from_user !== connection.user.id && transfer.to_user !== connection.user.id) {
      throw new Error('Trasferimento non trovato');
    }
    return transfer;
  }

  private handleQuickShareAccept(connection: Connection, message: Record<string, unknown>): void {
    const transfer = this.quickShareParticipant(connection, message);
    if (transfer.to_user !== connection.user.id || transfer.status !== 'pending')
      throw new Error('Accettazione non valida');
    this.deps.db
      .prepare("UPDATE transfers SET status = 'accepted', updated_at = ? WHERE id = ?")
      .run(nowMs(), transfer.id);
    const timer = this.transferTimers.get(transfer.id);
    if (timer) {
      clearTimeout(timer);
      this.transferTimers.delete(transfer.id);
    }
    this.sendToUser(transfer.from_user, { type: 'qs:accepted', transferId: transfer.id });
    audit(this.deps.db, {
      actorId: connection.user.id,
      action: 'quick_share.accepted',
      targetType: 'transfer',
      targetId: transfer.id,
      ip: connection.ip,
      userAgent: connection.userAgent,
      meta: { from: transfer.from_user },
    });
  }

  private handleQuickShareDecline(connection: Connection, message: Record<string, unknown>): void {
    const transfer = this.quickShareParticipant(connection, message);
    if (transfer.to_user !== connection.user.id || transfer.status !== 'pending') throw new Error('Rifiuto non valido');
    this.deps.db
      .prepare("UPDATE transfers SET status = 'declined', updated_at = ? WHERE id = ?")
      .run(nowMs(), transfer.id);
    const timer = this.transferTimers.get(transfer.id);
    if (timer) clearTimeout(timer);
    this.transferTimers.delete(transfer.id);
    this.sendToUser(transfer.from_user, { type: 'qs:declined', transferId: transfer.id });
    audit(this.deps.db, {
      actorId: connection.user.id,
      action: 'quick_share.declined',
      targetType: 'transfer',
      targetId: transfer.id,
      ip: connection.ip,
      userAgent: connection.userAgent,
      meta: { from: transfer.from_user },
    });
  }

  private handleQuickShareCancel(connection: Connection, message: Record<string, unknown>): void {
    const transfer = this.quickShareParticipant(connection, message);
    if (!['pending', 'accepted', 'offline'].includes(transfer.status)) return;
    this.deps.db
      .prepare("UPDATE transfers SET status = 'cancelled', updated_at = ? WHERE id = ?")
      .run(nowMs(), transfer.id);
    const timer = this.transferTimers.get(transfer.id);
    if (timer) clearTimeout(timer);
    this.transferTimers.delete(transfer.id);
    const other = connection.user.id === transfer.from_user ? transfer.to_user : transfer.from_user;
    this.sendToUser(other, { type: 'qs:cancelled', transferId: transfer.id, by: connection.user.id });
  }

  private handleQuickShareSignal(connection: Connection, message: Record<string, unknown>): void {
    const transfer = this.quickShareParticipant(connection, message);
    if (transfer.status !== 'accepted') throw new Error('Trasferimento non attivo');
    const other = connection.user.id === transfer.from_user ? transfer.to_user : transfer.from_user;
    const data = message.data;
    if (!isRecord(data)) throw new Error('Segnale non valido');
    if (JSON.stringify(data).length > 80_000) throw new Error('Segnale troppo grande');
    this.sendToUser(other, { type: 'qs:signal', transferId: transfer.id, from: connection.user.id, data });
  }

  private handleQuickShareComplete(connection: Connection, message: Record<string, unknown>): void {
    const transfer = this.quickShareParticipant(connection, message);
    if (transfer.to_user !== connection.user.id) throw new Error('Completamento non valido');
    if (transfer.status !== 'accepted') throw new Error('Trasferimento non attivo');
    const ok = message.ok === true;
    const errorText = typeof message.error === 'string' ? message.error.slice(0, 200) : null;
    this.deps.db
      .prepare('UPDATE transfers SET status = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(ok ? 'delivered' : 'failed', errorText, nowMs(), transfer.id);
    this.sendToUser(transfer.from_user, {
      type: ok ? 'qs:delivered' : 'qs:failed',
      transferId: transfer.id,
      error: errorText,
    });
    if (ok) {
      audit(this.deps.db, {
        actorId: connection.user.id,
        action: 'quick_share.delivered',
        targetType: 'transfer',
        targetId: transfer.id,
        ip: connection.ip,
        userAgent: connection.userAgent,
        meta: { from: transfer.from_user, size: transfer.size },
      });
    }
  }

  private handleQuickShareFail(connection: Connection, message: Record<string, unknown>): void {
    const transfer = this.quickShareParticipant(connection, message);
    if (transfer.from_user !== connection.user.id) throw new Error('Operazione non consentita');
    if (!['accepted', 'pending'].includes(transfer.status)) return;
    this.deps.db
      .prepare("UPDATE transfers SET status = 'failed', updated_at = ? WHERE id = ?")
      .run(nowMs(), transfer.id);
    this.sendToUser(transfer.to_user, { type: 'qs:failed', transferId: transfer.id });
  }

  private abortTransfersOnDisconnect(userId: string): void {
    const rows = this.deps.db
      .prepare("SELECT * FROM transfers WHERE (from_user = ? OR to_user = ?) AND status IN ('pending', 'accepted')")
      .all(userId, userId) as unknown as TransferRow[];
    for (const transfer of rows) {
      if (transfer.status === 'pending' && transfer.to_user === userId) continue; // let the 60s timeout run
      this.deps.db
        .prepare("UPDATE transfers SET status = 'failed', updated_at = ? WHERE id = ?")
        .run(nowMs(), transfer.id);
      const timer = this.transferTimers.get(transfer.id);
      if (timer) clearTimeout(timer);
      this.transferTimers.delete(transfer.id);
      const other = transfer.from_user === userId ? transfer.to_user : transfer.from_user;
      this.sendToUser(other, { type: 'qs:failed', transferId: transfer.id, error: 'peer_disconnected' });
    }
  }
}
