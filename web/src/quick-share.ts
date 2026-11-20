import { ApiError, api, fetchIceServers, listContacts } from './api.js';
import { events, on } from './bus.js';
import { t } from './i18n.js';
import { realtime } from './realtime.js';
import { navigate } from './router.js';
import { hashFile, Sha256 } from './sha256.js';
import { type Contact, setContacts, state } from './store.js';
import { avatarEl, formatBytes, h, icon, toast } from './ui.js';
import { uploadAndWait } from './uploads.js';

const CHUNK_SIZE = 64 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const ACK_STEP = 1024 * 1024;

interface Outgoing {
  transferId: string | null;
  file: File;
  contact: Contact;
  sha256: string;
  status: string;
  progress: number;
  canceled: boolean;
  fallbackStarted: boolean;
  delivered: boolean;
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  p2pTimer: number;
  responseTimer: number;
  pendingCandidates: RTCIceCandidateInit[];
  roomId?: string;
  element: HTMLElement;
  statusEl: HTMLElement;
  bar: HTMLElement;
  cancelButton: HTMLButtonElement;
}

interface IncomingOffer {
  transferId: string;
  from: { id: string; displayName: string; username?: string };
  fileName: string;
  size: number;
  mime: string;
  sha256: string;
  expiresAt: number;
}

interface Receiver {
  offer: IncomingOffer;
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  pendingCandidates: RTCIceCandidateInit[];
  hasRemote: boolean;
  hasher: Sha256;
  chunks: BlobPart[];
  received: number;
  lastAck: number;
  timer: number;
  element: HTMLElement;
  statusEl: HTMLElement;
  bar: HTMLElement;
  cancelButton: HTMLButtonElement;
  finished: boolean;
}

let initialized = false;
let overlay: HTMLElement | null = null;
let pendingFiles: File[] = [];
let dragDepth = 0;
let dropHandled = false;
let currentOffer: IncomingOffer | null = null;
let offerElement: HTMLElement | null = null;
let offerTimer = 0;
let receiver: Receiver | null = null;
let iceCache: RTCIceServer[] | null = null;
const offers: IncomingOffer[] = [];
const outgoing = new Map<string, Outgoing>();

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

function chime(): void {
  try {
    const ctx = new AudioContext();
    void ctx.resume();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.setValueAtTime(1180, now + 0.15);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.1, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.5);
    window.setTimeout(() => void ctx.close(), 900);
  } catch {
    // audio may need a gesture
  }
}

async function iceServers(): Promise<RTCIceServer[]> {
  if (iceCache) return iceCache;
  try {
    const response = await fetchIceServers();
    iceCache = response.iceServers;
  } catch {
    iceCache = [];
  }
  return iceCache;
}

function secure(): boolean {
  if (window.isSecureContext) return true;
  toast(t('qs.insecure'), 'error');
  return false;
}

function transferStatusLabel(out: Outgoing): string {
  switch (out.status) {
    case 'hashing':
      return 'Preparazione…';
    case 'ringing':
      return t('qs.waiting');
    case 'accepted':
      return t('calls.connecting');
    case 'transferring':
      return t('qs.transferring');
    case 'fallback':
      return t('qs.fallback');
    case 'delivered':
      return t('qs.delivered');
    case 'delivered_chat':
      return t('qs.deliveredChat');
    case 'declined':
      return t('qs.declined');
    case 'timeout':
      return t('qs.timeout');
    case 'cancelled':
      return t('qs.cancelled');
    default:
      return t('qs.failed');
  }
}

function updateOutgoing(out: Outgoing): void {
  out.statusEl.textContent = transferStatusLabel(out);
  out.bar.style.width = `${Math.round(out.progress * 100)}%`;
  out.cancelButton.hidden =
    out.status === 'delivered' ||
    out.status === 'delivered_chat' ||
    out.status === 'cancelled' ||
    out.status === 'failed';
}

function trayRow(out: Outgoing): void {
  const bar = h('span', { style: { width: '0%' } });
  const statusEl = h('div', { class: 'qs-status', text: transferStatusLabel(out) });
  const cancelButton = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn',
      'aria-label': t('qs.cancel'),
      title: t('qs.cancel'),
      style: { color: 'inherit' },
      onclick: () => cancelOutgoing(out),
    },
    icon('close', 14),
  );
  const element = h(
    'div',
    { class: 'qs-transfer', role: 'status' },
    h('span', { class: 'file-icon' }, icon('file', 16)),
    h(
      'div',
      { class: 'grow' },
      h('div', { class: 'qs-name', text: `${out.file.name} → ${out.contact.displayName}` }),
      statusEl,
      h('div', { class: 'progress' }, bar),
    ),
    cancelButton,
  );
  out.element = element;
  out.statusEl = statusEl;
  out.bar = bar;
  out.cancelButton = cancelButton;
  let tray = document.querySelector('.qs-transfers');
  if (!tray) {
    tray = h('div', { class: 'qs-transfers', role: 'region', 'aria-label': t('qs.title') });
    document.body.append(tray);
  }
  tray.append(element);
}

function cleanupTray(): void {
  const tray = document.querySelector('.qs-transfers');
  if (!tray) return;
  if (tray.children.length === 0) tray.remove();
}

function removeOutgoingLater(out: Outgoing, delay = 5000): void {
  window.setTimeout(() => {
    out.element.remove();
    cleanupTray();
  }, delay);
}

function closeP2P(out: Outgoing): void {
  window.clearTimeout(out.p2pTimer);
  window.clearTimeout(out.responseTimer);
  try {
    out.dc?.close();
  } catch {
    // ignore
  }
  try {
    out.pc?.close();
  } catch {
    // ignore
  }
  out.dc = null;
  out.pc = null;
}

async function waitForDrain(dc: RTCDataChannel): Promise<void> {
  if (dc.bufferedAmount < HIGH_WATER) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      dc.removeEventListener('bufferedamountlow', onLow);
      reject(new Error('timeout'));
    }, 30_000);
    const onLow = (): void => {
      window.clearTimeout(timeout);
      dc.removeEventListener('bufferedamountlow', onLow);
      resolve();
    };
    dc.addEventListener('bufferedamountlow', onLow);
  });
}

async function sendBytes(out: Outgoing): Promise<void> {
  const dc = out.dc;
  if (!dc) throw new Error(t('qs.failed'));
  let offset = 0;
  while (offset < out.file.size) {
    if (out.canceled || dc.readyState !== 'open') throw new Error('cancelled');
    const slice = out.file.slice(offset, Math.min(offset + CHUNK_SIZE, out.file.size));
    const buffer = await slice.arrayBuffer();
    if (dc.bufferedAmount >= HIGH_WATER) await waitForDrain(dc);
    dc.send(buffer);
    offset += buffer.byteLength;
    out.progress = Math.max(out.progress, (offset / Math.max(1, out.file.size)) * 0.94);
    updateOutgoing(out);
  }
  dc.send(JSON.stringify({ kind: 'done' }));
}

async function startP2P(out: Outgoing): Promise<void> {
  if (out.canceled || !out.transferId) return;
  window.clearTimeout(out.responseTimer);
  window.clearTimeout(out.p2pTimer);
  out.status = 'accepted';
  updateOutgoing(out);
  const servers = await iceServers();
  const pc = new RTCPeerConnection({ iceServers: servers, bundlePolicy: 'max-bundle' });
  out.pc = pc;
  const dc = pc.createDataChannel('nimbus-file', { ordered: true });
  out.dc = dc;
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = 1024 * 1024;
  pc.onicecandidate = (event) => {
    if (event.candidate && out.transferId) {
      realtime.send({ type: 'qs:signal', transferId: out.transferId, data: { candidate: event.candidate.toJSON() } });
    }
  };
  dc.onopen = () => {
    window.clearTimeout(out.p2pTimer);
    out.status = 'transferring';
    updateOutgoing(out);
    void sendBytes(out).catch(() => {
      if (!out.canceled && !out.delivered) void fallback(out, t('qs.failed'));
    });
  };
  dc.onmessage = (event) => {
    if (typeof event.data !== 'string') return;
    try {
      const parsed = JSON.parse(event.data) as { kind?: string; received?: number; ok?: boolean };
      if (parsed.kind === 'ack' && typeof parsed.received === 'number') {
        out.progress = Math.min(1, parsed.received / Math.max(1, out.file.size));
        updateOutgoing(out);
      } else if (parsed.kind === 'verified') {
        if (parsed.ok) {
          out.delivered = true;
          out.status = 'delivered';
          out.progress = 1;
          updateOutgoing(out);
          closeP2P(out);
          removeOutgoingLater(out);
        } else {
          void fallback(out, t('qs.hashMismatch'));
        }
      }
    } catch {
      // ignore malformed control frames
    }
  };
  dc.onclose = () => {
    if (!out.delivered && !out.canceled && out.status !== 'delivered_chat') void fallback(out, t('qs.failed'));
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' && !out.delivered && !out.canceled) void fallback(out, t('qs.failed'));
  };
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    realtime.send({
      type: 'qs:signal',
      transferId: out.transferId,
      data: { kind: 'offer', sdp: pc.localDescription?.toJSON() },
    });
    out.p2pTimer = window.setTimeout(() => {
      if (out.status !== 'transferring' && !out.delivered && !out.canceled) void fallback(out, 'timeout');
    }, 20_000);
  } catch (error) {
    await fallback(out, error instanceof Error ? error.message : t('qs.failed'));
  }
}

async function createOfflineTransfer(out: Outgoing): Promise<string> {
  const response = await api<{ transferId: string }>('/api/quick-share/offline', {
    method: 'POST',
    body: {
      toUserId: out.contact.id,
      fileName: out.file.name,
      size: out.file.size,
      mime: out.file.type || 'application/octet-stream',
      sha256: out.sha256,
    },
  });
  return response.transferId;
}

async function fallback(out: Outgoing, reason: string): Promise<void> {
  if (out.fallbackStarted || out.canceled || out.delivered || out.status === 'delivered_chat') return;
  out.fallbackStarted = true;
  closeP2P(out);
  out.status = 'fallback';
  out.statusEl.textContent = t('qs.fallback');
  updateOutgoing(out);
  try {
    if (!out.transferId) out.transferId = await createOfflineTransfer(out);
    const uploaded = await uploadAndWait(out.file, null, out.sha256);
    const result = await api<{ status: string; roomId: string; message: { id: string } }>(
      `/api/quick-share/${encodeURIComponent(out.transferId)}/fallback`,
      { method: 'POST', body: { fileId: uploaded.id } },
    );
    out.status = 'delivered_chat';
    out.progress = 1;
    out.roomId = result.roomId;
    updateOutgoing(out);
    out.statusEl.append(
      ' ',
      h(
        'button',
        {
          type: 'button',
          class: 'btn small',
          style: { marginTop: '4px' },
          onclick: () => {
            overlay?.remove();
            overlay = null;
            navigate(`/chat/${encodeURIComponent(result.roomId)}`);
          },
        },
        t('qs.openChat'),
      ),
    );
    toast(`${out.file.name}: ${t('qs.deliveredChat')}`, 'success');
    removeOutgoingLater(out, 12_000);
  } catch (error) {
    out.status = 'failed';
    out.progress = 0;
    updateOutgoing(out);
    toast(`${out.file.name}: ${reason} — ${error instanceof ApiError ? error.message : t('qs.failed')}`, 'error');
  }
}

function cancelOutgoing(out: Outgoing): void {
  if (out.status === 'delivered' || out.status === 'delivered_chat') return;
  out.canceled = true;
  out.status = 'cancelled';
  closeP2P(out);
  updateOutgoing(out);
  if (out.transferId) realtime.send({ type: 'qs:cancel', transferId: out.transferId });
  removeOutgoingLater(out);
}

async function sendOne(file: File, contact: Contact): Promise<void> {
  const max = state.config?.maxQuickShareBytes ?? 0;
  if (max > 0 && file.size > max) {
    toast(`${file.name}: ${t('qs.tooLarge')} (${formatBytes(max)})`, 'error');
    return;
  }
  const out: Outgoing = {
    transferId: null,
    file,
    contact,
    sha256: '',
    status: 'hashing',
    progress: 0,
    canceled: false,
    fallbackStarted: false,
    delivered: false,
    pc: null,
    dc: null,
    p2pTimer: 0,
    responseTimer: 0,
    pendingCandidates: [],
    element: h('div'),
    statusEl: h('div'),
    bar: h('span'),
    cancelButton: h('button'),
  };
  trayRow(out);
  try {
    out.sha256 = await hashFile(file, (fraction) => {
      out.progress = fraction * 0.18;
      updateOutgoing(out);
    });
  } catch {
    out.status = 'failed';
    updateOutgoing(out);
    return;
  }
  if (contact.status === 'offline' || !realtime.isOpen()) {
    try {
      out.transferId = await createOfflineTransfer(out);
    } catch (error) {
      out.status = 'failed';
      updateOutgoing(out);
      toast(error instanceof ApiError ? error.message : t('qs.failed'), 'error');
      return;
    }
    const key = out.transferId;
    outgoing.set(key, out);
    await fallback(out, 'offline');
    return;
  }
  out.transferId = crypto.randomUUID();
  outgoing.set(out.transferId, out);
  out.status = 'ringing';
  updateOutgoing(out);
  out.responseTimer = window.setTimeout(() => {
    if (out.status === 'ringing' && !out.canceled) void fallback(out, 'timeout');
  }, 65_000);
  const sent = realtime.send({
    type: 'qs:offer',
    transferId: out.transferId,
    to: contact.id,
    fileName: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    sha256: out.sha256,
  });
  if (!sent) {
    out.transferId = null;
    try {
      out.transferId = await createOfflineTransfer(out);
      outgoing.set(out.transferId, out);
      await fallback(out, 'offline');
    } catch (error) {
      out.status = 'failed';
      updateOutgoing(out);
      toast(error instanceof ApiError ? error.message : t('qs.failed'), 'error');
    }
  }
}

function renderOverlay(): void {
  if (!overlay) return;
  const filesChips = overlay.querySelector('.qs-files');
  if (filesChips) {
    filesChips.replaceChildren();
    for (const file of pendingFiles) {
      filesChips.append(
        h(
          'span',
          { class: 'qs-file-chip' },
          fileIconFor(file),
          h('span', { text: file.name }),
          h('span', { class: 'muted', text: formatBytes(file.size) }),
        ),
      );
    }
  }
  const hint = overlay.querySelector('.qs-drop-hint');
  if (hint) hint.textContent = pendingFiles.length > 0 ? t('qs.dropped') : t('qs.subtitle');
}

function fileIconFor(file: File): HTMLElement {
  const name = file.type.startsWith('image/')
    ? 'image'
    : file.type.startsWith('video/')
      ? 'video'
      : file.type === 'application/pdf'
        ? 'pdf'
        : 'file';
  return h(
    'span',
    {
      class: 'file-icon',
      style: { width: '26px', height: '26px', background: 'rgba(255,255,255,0.1)', color: '#fff' },
    },
    icon(name, 14),
  );
}

function makeContactButton(contact: Contact, offline: boolean, position?: { left: string; top: string }): HTMLElement {
  const button = h(
    'button',
    {
      type: 'button',
      class: offline ? 'qs-offline-chip' : 'radar-contact',
      style: position ? { left: position.left, top: position.top } : undefined,
      'aria-label': t('qs.sendTo', { name: contact.displayName }),
      title: t('qs.sendTo', { name: contact.displayName }),
      onclick: () => void pickAndSend(contact),
      ondragover: (event: DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        button.classList.add('droptarget');
      },
      ondragleave: () => button.classList.remove('droptarget'),
      ondrop: (event: DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        button.classList.remove('droptarget');
        dropHandled = true;
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length > 0) {
          pendingFiles = files;
          renderOverlay();
          void sendFilesTo(contact, files);
        }
      },
    },
    avatarEl(contact, { size: offline ? 'sm' : undefined }),
    h('span', { class: offline ? '' : 'rc-name', text: contact.displayName }),
    offline ? h('span', { class: 'muted', text: t('common.offline') }) : null,
  );
  return button;
}

function buildOverlay(files: File[]): HTMLElement {
  pendingFiles = files;
  const online = state.contacts.filter(
    (contact) => contact.status !== 'offline' && contact.quickShare && !contact.blocked,
  );
  const offline = state.contacts.filter(
    (contact) => contact.status === 'offline' && contact.quickShare && !contact.blocked,
  );
  const radar = h(
    'div',
    { class: 'radar' },
    h('div', { class: 'radar-ring r1' }),
    h('div', { class: 'radar-ring r2' }),
    h('div', { class: 'radar-ring r3' }),
    h('div', { class: 'radar-sweep' }),
    h(
      'div',
      { class: 'radar-center' },
      avatarEl(
        { id: state.user?.id ?? 'me', displayName: state.user?.displayName ?? 'Tu', status: 'online' },
        { size: 'lg', showStatus: false },
      ),
    ),
  );
  const count = online.length;
  online.forEach((contact, index) => {
    const angle = (-90 + (360 / Math.max(1, count)) * index) * (Math.PI / 180);
    const radius = count > 6 && index % 2 === 1 ? 26 : 33;
    radar.append(
      makeContactButton(contact, false, {
        left: `${50 + Math.cos(angle) * radius}%`,
        top: `${50 + Math.sin(angle) * radius}%`,
      }),
    );
  });
  const offlineRow = h('div', { class: 'qs-offline-row' });
  for (const contact of offline) offlineRow.append(makeContactButton(contact, true));
  const fileInput = h('input', {
    type: 'file',
    multiple: true,
    hidden: true,
    onchange: () => {
      const files = Array.from(fileInput.files ?? []);
      fileInput.value = '';
      if (files.length > 0) {
        pendingFiles = files;
        renderOverlay();
      }
    },
  });
  const element = h(
    'div',
    { class: 'qs-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('qs.title') },
    h(
      'div',
      { class: 'qs-head' },
      h(
        'div',
        { class: 'grow' },
        h('h2', { text: t('qs.title') }),
        h('p', { class: 'qs-drop-hint', text: files.length > 0 ? t('qs.dropped') : t('qs.subtitle') }),
        h('div', { class: 'qs-files' }),
        h(
          'div',
          { class: 'row', style: { marginTop: '12px' } },
          h(
            'button',
            {
              type: 'button',
              class: 'btn',
              style: { background: 'rgba(255,255,255,0.12)', color: '#fff', borderColor: 'rgba(255,255,255,0.16)' },
              onclick: () => fileInput.click(),
            },
            icon('plus', 15),
            t('qs.browse'),
          ),
          fileInput,
          h('span', {
            class: 'hint',
            style: { color: 'rgba(255,255,255,0.55)' },
            text: t('qs.secureNote', { size: formatBytes(state.config?.maxQuickShareBytes ?? 0) }),
          }),
        ),
      ),
      h(
        'button',
        { type: 'button', class: 'icon-btn', 'aria-label': t('common.close'), onclick: () => closeOverlay() },
        icon('close', 20),
      ),
    ),
    radar,
    h(
      'div',
      { class: 'qs-offline' },
      h('h3', { text: t('qs.offline') }),
      offlineRow.children.length > 0
        ? offlineRow
        : h('p', { class: 'hint', style: { color: 'rgba(255,255,255,0.55)' }, text: t('qs.noContacts') }),
    ),
  );
  if (!window.isSecureContext) {
    element.prepend(h('div', { class: 'notice danger', text: t('qs.insecure') }));
  }
  renderOverlay();
  return element;
}

let overlayRevision = 0;

function closeOverlay(): void {
  overlayRevision += 1;
  overlay?.remove();
  overlay = null;
  pendingFiles = [];
}

function drawOverlay(files: File[]): void {
  if (overlay) overlay.remove();
  overlay = buildOverlay(files);
  document.body.append(overlay);
  renderOverlay();
}

function showOverlay(files: File[]): void {
  if (!secure()) return;
  if (overlay) {
    pendingFiles = files;
    renderOverlay();
    return;
  }
  const revision = ++overlayRevision;
  drawOverlay(files);
  // The overlay can open before the socket's first presence frame. Fetch the
  // authoritative contact list once and redraw, without blocking the drop UI.
  void listContacts()
    .then((contacts) => {
      if (revision !== overlayRevision || !overlay) return;
      setContacts(contacts);
      drawOverlay(pendingFiles);
    })
    .catch(() => undefined);
}

function pickAndSend(contact: Contact): void {
  if (pendingFiles.length > 0) {
    // The files were already chosen before the radar opened (or dropped on
    // it): send those instead of asking the user to pick them again.
    const files = [...pendingFiles];
    void sendFilesTo(contact, files);
    return;
  }
  const input = h('input', { type: 'file', multiple: true, hidden: true });
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    if (files.length > 0) {
      pendingFiles = files;
      renderOverlay();
      void sendFilesTo(contact, files);
    }
    input.remove();
  };
  document.body.append(input);
  input.click();
}

async function sendFilesTo(contact: Contact, files: File[]): Promise<void> {
  if (!secure()) return;
  closeOverlay();
  for (const file of files) await sendOne(file, contact);
}

export function openQuickSharePicker(): void {
  if (!secure()) return;
  const input = h('input', { type: 'file', multiple: true, hidden: true });
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    if (files.length > 0) showOverlay(files);
    input.remove();
  };
  document.body.append(input);
  input.click();
}

function offerCountdown(offer: IncomingOffer, countdown: HTMLElement): void {
  const render = (): void => {
    const seconds = Math.max(0, Math.ceil((offer.expiresAt - Date.now()) / 1000));
    countdown.textContent = t('qs.acceptsIn', { n: seconds });
    if (seconds <= 0) closeOffer(true);
  };
  render();
  offerTimer = window.setInterval(render, 1000);
}

function closeOffer(decline: boolean): void {
  window.clearInterval(offerTimer);
  if (decline && currentOffer) realtime.send({ type: 'qs:decline', transferId: currentOffer.transferId });
  offerElement?.remove();
  offerElement = null;
  currentOffer = null;
  showNextOffer();
}

function showNextOffer(): void {
  if (receiver || currentOffer) return;
  const next = offers.shift();
  if (!next) return;
  currentOffer = next;
  const countdown = h('div', { class: 'countdown' });
  const card = h(
    'div',
    { class: 'qs-receive-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('qs.incomingTitle') },
    h(
      'div',
      { class: 'ring-avatar' },
      avatarEl(
        { id: next.from.id, displayName: next.from.displayName, status: 'online' },
        { size: 'xl', showStatus: false },
      ),
    ),
    h('h2', { text: t('qs.incomingTitle') }),
    h('p', { class: 'soft', text: t('qs.from', { name: next.from.displayName }) }),
    h(
      'div',
      { class: 'file-meta-box' },
      h('div', {}, h('strong', { text: next.fileName })),
      h('div', { text: `${formatBytes(next.size)} · ${next.mime || t('files.file')}` }),
      h('div', { class: 'mono', style: { fontSize: '10px', overflowWrap: 'anywhere' }, text: next.sha256 }),
    ),
    countdown,
    h(
      'div',
      { class: 'row', style: { justifyContent: 'center', marginTop: '6px' } },
      h('button', { type: 'button', class: 'btn', onclick: () => closeOffer(true) }, t('qs.reject')),
      h(
        'button',
        { type: 'button', class: 'btn primary', onclick: () => void acceptOffer(next) },
        icon('check', 15),
        t('qs.accept'),
      ),
    ),
  );
  offerElement = h('div', { class: 'qs-receive' }, card);
  document.body.append(offerElement);
  offerCountdown(next, countdown);
  chime();
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(t('qs.incomingTitle'), {
        body: `${next.from.displayName} · ${next.fileName}`,
        icon: '/icon.svg',
        tag: `qs-${next.transferId}`,
      });
    } catch {
      // ignore
    }
  }
}

function receiveOverlay(offer: IncomingOffer): Receiver {
  const bar = h('span', { style: { width: '0%' } });
  const statusEl = h('div', { class: 'countdown', text: t('qs.waiting') });
  const cancelButton = h(
    'button',
    { type: 'button', class: 'btn small danger', onclick: () => cancelReceiver() },
    t('common.cancel'),
  );
  const card = h(
    'div',
    { class: 'qs-receive-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('qs.transferring') },
    h(
      'div',
      { class: 'ring-avatar' },
      avatarEl(
        { id: offer.from.id, displayName: offer.from.displayName, status: 'online' },
        { size: 'xl', showStatus: false },
      ),
    ),
    h('h2', { text: offer.fileName }),
    h('p', { class: 'soft', text: t('qs.from', { name: offer.from.displayName }) }),
    statusEl,
    h('div', { class: 'progress', style: { width: '100%' } }, bar),
    h(
      'div',
      { class: 'row', style: { gap: '6px' } },
      icon('shield', 14),
      h('span', { class: 'hint', text: t('qs.secureNote', { size: formatBytes(offer.size) }) }),
    ),
    cancelButton,
  );
  const element = h('div', { class: 'qs-receive' }, card);
  document.body.append(element);
  return {
    offer,
    pc: null,
    dc: null,
    pendingCandidates: [],
    hasRemote: false,
    hasher: new Sha256(),
    chunks: [],
    received: 0,
    lastAck: 0,
    timer: 0,
    element,
    statusEl,
    bar,
    cancelButton,
    finished: false,
  };
}

async function acceptOffer(offer: IncomingOffer): Promise<void> {
  if (receiver) return;
  window.clearInterval(offerTimer);
  offerElement?.remove();
  offerElement = null;
  currentOffer = null;
  receiver = receiveOverlay(offer);
  const current = receiver;
  current.timer = window.setTimeout(() => {
    if (current && !current.finished) {
      realtime.send({ type: 'qs:complete', transferId: offer.transferId, ok: false, error: 'timeout' });
      failReceiver(t('qs.timeout'));
    }
  }, 20_000);
  realtime.send({ type: 'qs:accept', transferId: offer.transferId });
  showNextOffer();
}

function failReceiver(message: string): void {
  if (!receiver) return;
  receiver.finished = true;
  window.clearTimeout(receiver.timer);
  receiver.statusEl.textContent = message;
  receiver.cancelButton.hidden = true;
  window.setTimeout(() => {
    receiver?.element.remove();
    receiver = null;
    showNextOffer();
  }, 2400);
}

function cancelReceiver(): void {
  if (!receiver) return;
  receiver.finished = true;
  window.clearTimeout(receiver.timer);
  try {
    receiver.dc?.close();
  } catch {
    // ignore
  }
  receiver.pc?.close();
  realtime.send({ type: 'qs:complete', transferId: receiver.offer.transferId, ok: false, error: 'cancelled' });
  receiver.element.remove();
  receiver = null;
  showNextOffer();
}

async function handleReceiverSignal(data: Record<string, unknown>): Promise<void> {
  const current = receiver;
  if (!current) return;
  if (data.kind === 'offer' && data.sdp && !current.pc) {
    const servers = await iceServers();
    const pc = new RTCPeerConnection({ iceServers: servers, bundlePolicy: 'max-bundle' });
    current.pc = pc;
    pc.onicecandidate = (event) => {
      if (event.candidate)
        realtime.send({
          type: 'qs:signal',
          transferId: current.offer.transferId,
          data: { candidate: event.candidate.toJSON() },
        });
    };
    pc.ondatachannel = (event) => {
      const dc = event.channel;
      current.dc = dc;
      dc.binaryType = 'arraybuffer';
      dc.onmessage = (message) => handleReceiverMessage(current, message);
      dc.onclose = () => {
        if (!current.finished) failReceiver(t('qs.failed'));
      };
    };
    try {
      await pc.setRemoteDescription(data.sdp as RTCSessionDescriptionInit);
      current.hasRemote = true;
      for (const candidate of current.pendingCandidates.splice(0)) await pc.addIceCandidate(candidate);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      realtime.send({
        type: 'qs:signal',
        transferId: current.offer.transferId,
        data: { kind: 'answer', sdp: pc.localDescription?.toJSON() },
      });
    } catch {
      failReceiver(t('qs.failed'));
    }
  } else if (data.candidate) {
    const candidate = data.candidate as RTCIceCandidateInit;
    if (current.pc && current.hasRemote) await current.pc.addIceCandidate(candidate);
    else current.pendingCandidates.push(candidate);
  }
}

function handleReceiverMessage(current: Receiver, event: MessageEvent): void {
  if (current.finished) return;
  if (event.data instanceof ArrayBuffer) {
    current.chunks.push(event.data);
    current.hasher.update(new Uint8Array(event.data));
    current.received += event.data.byteLength;
    current.bar.style.width = `${Math.round((current.received / Math.max(1, current.offer.size)) * 100)}%`;
    current.statusEl.textContent = `${t('qs.transferring')} ${Math.round((current.received / Math.max(1, current.offer.size)) * 100)}%`;
    if (current.dc && current.received - current.lastAck >= ACK_STEP) {
      current.lastAck = current.received;
      try {
        current.dc.send(JSON.stringify({ kind: 'ack', received: current.received }));
      } catch {
        // ignore
      }
    }
    return;
  }
  if (typeof event.data !== 'string') return;
  let parsed: { kind?: string };
  try {
    parsed = JSON.parse(event.data) as { kind?: string };
  } catch {
    return;
  }
  if (parsed.kind !== 'done') return;
  window.clearTimeout(current.timer);
  current.finished = true;
  const verified = current.received === current.offer.size && current.hasher.hex() === current.offer.sha256;
  if (!verified) {
    try {
      current.dc?.send(JSON.stringify({ kind: 'verified', ok: false }));
    } catch {
      // ignore
    }
    realtime.send({ type: 'qs:complete', transferId: current.offer.transferId, ok: false, error: 'checksum_mismatch' });
    failReceiver(t('qs.hashMismatch'));
    return;
  }
  try {
    current.dc?.send(JSON.stringify({ kind: 'verified', ok: true }));
  } catch {
    // ignore
  }
  realtime.send({ type: 'qs:complete', transferId: current.offer.transferId, ok: true });
  const blob = new Blob(current.chunks, { type: current.offer.mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const save = h(
    'a',
    { class: 'btn primary block', href: url, download: current.offer.fileName },
    icon('download', 16),
    t('qs.saveFile'),
  );
  const close = h(
    'button',
    {
      type: 'button',
      class: 'btn block',
      onclick: () => {
        URL.revokeObjectURL(url);
        current.element.remove();
        receiver = null;
        showNextOffer();
      },
    },
    t('common.close'),
  );
  const card = h(
    'div',
    { class: 'qs-receive-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('qs.delivered') },
    h(
      'div',
      { class: 'ring-avatar' },
      avatarEl(
        { id: current.offer.from.id, displayName: current.offer.from.displayName, status: 'online' },
        { size: 'xl', showStatus: false },
      ),
    ),
    h('h2', { text: t('qs.delivered') }),
    h('p', { class: 'soft', text: current.offer.fileName }),
    h(
      'div',
      { class: 'file-meta-box' },
      h('div', { text: formatBytes(current.offer.size) }),
      h('div', { class: 'mono', style: { fontSize: '10px' }, text: current.offer.sha256 }),
    ),
    save,
    close,
  );
  current.element.replaceChildren(card);
  chime();
}

function handleSignal(payload: Record<string, unknown>): void {
  const transferId = String(payload.transferId ?? '');
  const from = String(payload.from ?? '');
  if (!transferId || !payload.data) return;
  const out = outgoing.get(transferId);
  if (out) {
    const data = payload.data as Record<string, unknown>;
    if (data.kind === 'answer' && data.sdp && out.pc) {
      void out.pc
        .setRemoteDescription(data.sdp as RTCSessionDescriptionInit)
        .then(async () => {
          for (const candidate of out.pendingCandidates.splice(0))
            await out.pc?.addIceCandidate(candidate).catch(() => undefined);
        })
        .catch(() => undefined);
    } else if (data.candidate) {
      if (out.pc?.remoteDescription)
        void out.pc.addIceCandidate(data.candidate as RTCIceCandidateInit).catch(() => undefined);
      else out.pendingCandidates.push(data.candidate as RTCIceCandidateInit);
    }
    return;
  }
  if (receiver && receiver.offer.transferId === transferId)
    void handleReceiverSignal(payload.data as Record<string, unknown>);
  void from;
}

function handleIncomingOffer(offer: IncomingOffer): void {
  if (!offer.transferId || !offer.from) return;
  if (receiver || currentOffer) {
    offers.push(offer);
    return;
  }
  offers.unshift(offer);
  showNextOffer();
}

function attachGlobalListeners(): void {
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    if (!overlay) showOverlay(pendingFiles);
  });
  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (!overlay) showOverlay(pendingFiles);
  });
  window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && !event.relatedTarget) closeOverlay();
  });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dropHandled = false;
    const files = Array.from(event.dataTransfer?.files ?? []);
    dragDepth = 0;
    if (dropHandled) {
      dropHandled = false;
      return;
    }
    if (files.length > 0) {
      pendingFiles = files;
      if (!overlay) showOverlay(files);
      else renderOverlay();
    }
    dropHandled = false;
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (overlay) closeOverlay();
      if (offerElement) closeOffer(true);
    }
  });
}

export function initQuickShare(): void {
  if (initialized) return;
  initialized = true;
  attachGlobalListeners();
  on(events.contactsUpdated, () => {
    if (overlay) drawOverlay(pendingFiles);
  });
  realtime.on('qs:offer', (payload) => {
    handleIncomingOffer({
      transferId: String(payload.transferId ?? ''),
      from: payload.from as IncomingOffer['from'],
      fileName: String(payload.fileName ?? ''),
      size: Number(payload.size ?? 0),
      mime: String(payload.mime ?? 'application/octet-stream'),
      sha256: String(payload.sha256 ?? ''),
      expiresAt: Number(payload.expiresAt ?? Date.now() + 60_000),
    });
  });
  realtime.on('qs:ringing', (payload) => {
    const out = outgoing.get(String(payload.transferId ?? ''));
    if (out) {
      out.status = 'ringing';
      updateOutgoing(out);
    }
  });
  realtime.on('qs:accepted', (payload) => {
    const out = outgoing.get(String(payload.transferId ?? ''));
    if (out) void startP2P(out);
  });
  realtime.on('qs:delivered', (payload) => {
    const out = outgoing.get(String(payload.transferId ?? ''));
    if (out) {
      out.delivered = true;
      out.status = 'delivered';
      out.progress = 1;
      updateOutgoing(out);
      closeP2P(out);
      removeOutgoingLater(out);
    }
  });
  realtime.on('qs:declined', (payload) => {
    const out = outgoing.get(String(payload.transferId ?? ''));
    if (out) {
      out.status = 'declined';
      updateOutgoing(out);
      void fallback(out, t('qs.declined'));
    }
  });
  realtime.on('qs:timeout', (payload) => {
    const out = outgoing.get(String(payload.transferId ?? ''));
    if (out) {
      out.status = 'timeout';
      updateOutgoing(out);
      void fallback(out, t('qs.timeout'));
    }
    const transferId = String(payload.transferId ?? '');
    if (currentOffer?.transferId === transferId) closeOffer(false);
  });
  realtime.on('qs:cancelled', (payload) => {
    const transferId = String(payload.transferId ?? '');
    const out = outgoing.get(transferId);
    if (out) {
      if (String(payload.by ?? '') !== state.user?.id && !out.delivered) {
        out.status = 'declined';
        updateOutgoing(out);
        void fallback(out, t('qs.cancelled'));
      } else {
        out.status = 'cancelled';
        updateOutgoing(out);
        closeP2P(out);
      }
    }
    if (currentOffer?.transferId === transferId) closeOffer(false);
    if (receiver?.offer.transferId === transferId) failReceiver(t('qs.cancelled'));
  });
  realtime.on('qs:failed', (payload) => {
    const transferId = String(payload.transferId ?? '');
    const out = outgoing.get(transferId);
    if (out && !out.delivered) {
      out.status = 'failed';
      updateOutgoing(out);
      void fallback(out, String(payload.error ?? t('qs.failed')));
    }
    if (receiver?.offer.transferId === transferId) failReceiver(t('qs.failed'));
  });
  realtime.on('qs:unavailable', (payload) => {
    const out = outgoing.get(String(payload.transferId ?? ''));
    if (!out) return;
    void (async () => {
      try {
        out.transferId = await createOfflineTransfer(out);
        outgoing.set(out.transferId, out);
        await fallback(out, t('qs.fallback'));
      } catch (error) {
        out.status = 'failed';
        updateOutgoing(out);
        toast(error instanceof ApiError ? error.message : t('qs.failed'), 'error');
      }
    })();
  });
  realtime.on('qs:signal', handleSignal);
}
