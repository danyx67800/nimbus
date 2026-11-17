import { emit, events } from './bus.js';

type WsHandler = (payload: Record<string, unknown>) => void;

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private handlers = new Map<string, Set<WsHandler>>();
  private retry = 0;
  private retryTimer = 0;
  private pingTimer = 0;
  private stopped = false;
  private connecting = false;

  connect(): void {
    if (this.stopped || this.connecting) return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING))
      return;
    this.connecting = true;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.connecting = false;
      this.retry = 0;
      this.pingTimer = window.setInterval(() => this.send({ type: 'ping' }), 25_000);
      emit('nimbus:ws-state', { connected: true });
    });

    socket.addEventListener('message', (event) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof parsed.type !== 'string') return;
      if (parsed.type === 'error') {
        emit('nimbus:ws-error', parsed);
      }
      const handlers = this.handlers.get(parsed.type);
      if (handlers) for (const handler of [...handlers]) handler(parsed);
      const all = this.handlers.get('*');
      if (all) for (const handler of [...all]) handler(parsed);
    });

    socket.addEventListener('close', (event) => {
      this.connecting = false;
      window.clearInterval(this.pingTimer);
      emit('nimbus:ws-state', { connected: false });
      this.socket = null;
      if (event.code === 4401) {
        this.stopped = true;
        emit(events.unauthorized);
        return;
      }
      if (this.stopped) return;
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // close handles reconnection
    });
  }

  private scheduleReconnect(): void {
    window.clearTimeout(this.retryTimer);
    const delay = Math.min(15_000, 750 * 2 ** Math.min(this.retry, 5));
    this.retry += 1;
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  on(type: string, handler: WsHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
      if (set && set.size === 0) this.handlers.delete(type);
    };
  }

  send(payload: Record<string, unknown>): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.stopped = true;
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.pingTimer);
    this.socket?.close();
    this.socket = null;
  }
}

export const realtime = new RealtimeClient();
