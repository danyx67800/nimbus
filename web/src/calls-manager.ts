import { ApiError, fetchIceServers } from './api.js';
import { t } from './i18n.js';
import { realtime } from './realtime.js';
import { contactName, state } from './store.js';
import { avatarEl, createSelectPill, h, icon, openModal, toast } from './ui.js';

interface Peer {
  pc: RTCPeerConnection;
  stream: MediaStream;
  pendingCandidates: RTCIceCandidateInit[];
  hasRemoteDescription: boolean;
  connectTimer: number;
}

const CONNECT_TIMEOUT_MS = 20_000;

interface CallSession {
  callId: string;
  kind: 'audio' | 'video';
  initiator: boolean;
  localStream: MediaStream;
  cameraTrack: MediaStreamTrack | null;
  screenTrack: MediaStreamTrack | null;
  peers: Map<string, Peer>;
  known: Map<string, string>;
  pendingTargets: Set<string>;
  overlay: HTMLElement;
  grid: HTMLElement;
  status: string;
  startedAt: number;
  timer: number;
  iceServers: RTCIceServer[];
}

interface IncomingCall {
  callId: string;
  kind: 'audio' | 'video';
  from: { id: string; displayName: string; username?: string };
  members: Array<{ id: string; displayName: string; username?: string }>;
}

let active: CallSession | null = null;
let incomingModal: ReturnType<typeof openModal> | null = null;
let ringTimer = 0;
let ringAudio: AudioContext | null = null;
let initialized = false;

function ringtoneEnabled(): boolean {
  try {
    return localStorage.getItem('nimbus-ring') !== 'off';
  } catch {
    return true;
  }
}

export function setRingtoneEnabled(enabled: boolean): void {
  try {
    localStorage.setItem('nimbus-ring', enabled ? 'on' : 'off');
  } catch {
    // ignore
  }
}

export function isRingtoneEnabled(): boolean {
  return ringtoneEnabled();
}

function beep(): void {
  if (!ringtoneEnabled()) return;
  try {
    ringAudio ??= new AudioContext();
    void ringAudio.resume();
    const now = ringAudio.currentTime;
    const osc = ringAudio.createOscillator();
    const gain = ringAudio.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(740, now);
    osc.frequency.setValueAtTime(920, now + 0.18);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    osc.connect(gain).connect(ringAudio.destination);
    osc.start(now);
    osc.stop(now + 0.6);
  } catch {
    // audio may be blocked until a user gesture
  }
}

function startRingtone(): void {
  stopRingtone();
  beep();
  ringTimer = window.setInterval(beep, 1900);
}

function stopRingtone(): void {
  window.clearInterval(ringTimer);
  ringTimer = 0;
}

function secureContextOk(): boolean {
  if (window.isSecureContext) return true;
  toast(t('calls.insecure'), 'error');
  return false;
}

async function getLocalMedia(kind: 'audio' | 'video'): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error(t('calls.mediaDenied'));
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: kind === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false,
  });
}

function sessionTitle(session: CallSession): string {
  if (session.peers.size === 1) {
    const [peerId] = [...session.peers.keys()];
    return peerId ? contactName(peerId) : session.kind === 'video' ? t('calls.video') : t('calls.audio');
  }
  if (session.peers.size > 1) return `${t('calls.title')} · ${session.peers.size + 1}`;
  return session.kind === 'video' ? t('calls.video') : t('calls.audio');
}

function statusLabel(session: CallSession): string {
  if (session.status === 'ringing') return t('calls.ringing');
  if (session.status === 'connecting') return t('calls.connecting');
  return t('calls.calling');
}

function createOverlay(session: CallSession): void {
  const grid = h('div', { class: 'video-grid' });
  const timer = h('span', { class: 'call-timer', text: '00:00' });
  const badge = h('span', { class: 'badge', text: statusLabel(session) });
  const muteButton = h(
    'button',
    {
      type: 'button',
      class: 'call-ctl',
      'aria-label': t('calls.mute'),
      title: t('calls.mute'),
      onclick: () => {
        const tracks = session.localStream.getAudioTracks();
        const enabled = tracks.some((track) => track.enabled);
        for (const track of tracks) track.enabled = !enabled;
        muteButton.classList.toggle('off', enabled);
        muteButton.replaceChildren(icon(enabled ? 'micOff' : 'mic', 20));
        muteButton.setAttribute('aria-label', enabled ? t('calls.unmute') : t('calls.mute'));
      },
    },
    icon('mic', 20),
  );
  const cameraButton = h(
    'button',
    {
      type: 'button',
      class: 'call-ctl',
      'aria-label': t('calls.cameraOff'),
      title: t('calls.cameraOff'),
      disabled: session.kind !== 'video',
      onclick: () => {
        const tracks = session.localStream.getVideoTracks();
        const enabled = tracks.some((track) => track.enabled);
        for (const track of tracks) track.enabled = !enabled;
        cameraButton.classList.toggle('off', enabled);
        cameraButton.replaceChildren(icon(enabled ? 'cameraOff' : 'camera', 20));
        cameraButton.setAttribute('aria-label', enabled ? t('calls.cameraOn') : t('calls.cameraOff'));
        renderGrid(session);
      },
    },
    icon('camera', 20),
  );
  const screenButton = h(
    'button',
    {
      type: 'button',
      class: 'call-ctl',
      'aria-label': t('calls.screenShare'),
      title: t('calls.screenShare'),
      disabled: session.kind !== 'video',
      onclick: () => void toggleScreenShare(session, screenButton),
    },
    icon('screen', 20),
  );
  const devicesButton = h(
    'button',
    {
      type: 'button',
      class: 'call-ctl',
      'aria-label': t('calls.devices'),
      title: t('calls.devices'),
      onclick: () => void openDevices(session),
    },
    icon('settings', 20),
  );
  const hangup = h(
    'button',
    {
      type: 'button',
      class: 'call-ctl hangup',
      'aria-label': t('calls.hangup'),
      title: t('calls.hangup'),
      onclick: () => endCall(session, true),
    },
    icon('phone', 22),
  );
  const overlay = h(
    'div',
    {
      class: 'call-overlay',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': session.kind === 'video' ? t('calls.video') : t('calls.audio'),
    },
    h(
      'div',
      { class: 'call-top' },
      h('h2', { text: sessionTitle(session) }),
      badge,
      timer,
      h('div', { class: 'grow' }),
      h(
        'button',
        {
          type: 'button',
          class: 'icon-btn',
          style: { color: '#fff' },
          'aria-label': t('calls.hangup'),
          onclick: () => endCall(session, true),
        },
        icon('close', 20),
      ),
    ),
    grid,
    h('div', { class: 'call-controls' }, muteButton, cameraButton, screenButton, devicesButton, hangup),
  );
  document.body.append(overlay);
  session.overlay = overlay;
  session.grid = grid;
  renderGrid(session);
  session.timer = window.setInterval(() => {
    const seconds = Math.max(0, Math.floor((Date.now() - session.startedAt) / 1000));
    timer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    badge.textContent = statusLabel(session);
  }, 1000);
}

function renderGrid(session: CallSession): void {
  if (!session.grid) return;
  const previousAudio = session.grid.querySelectorAll('audio[data-peer]');
  for (const element of previousAudio) element.remove();
  const tiles: HTMLElement[] = [];
  const localTile = h('div', { class: 'video-tile' });
  const localVideoEnabled =
    session.kind === 'video' && session.localStream.getVideoTracks().some((track) => track.enabled);
  if (localVideoEnabled) {
    const video = h('video', { autoplay: true, playsinline: true, muted: true });
    video.srcObject = session.localStream;
    void video.play().catch(() => undefined);
    localTile.append(video);
  } else {
    localTile.append(
      avatarEl(
        { id: state.user?.id ?? 'me', displayName: state.user?.displayName ?? 'Tu', status: 'online' },
        { size: 'xl', showStatus: false },
      ),
    );
  }
  localTile.append(h('span', { class: 'tile-label', text: t('calls.you') }));
  tiles.push(localTile);

  const allIds = new Set<string>([...session.known.keys(), ...session.peers.keys()]);
  for (const id of allIds) {
    const peer = session.peers.get(id);
    const tile = h('div', { class: 'video-tile' });
    const videoTrack = peer?.stream.getVideoTracks().find((track) => track.enabled);
    if (session.kind === 'video' && videoTrack) {
      const video = h('video', { autoplay: true, playsinline: true });
      if (peer) video.srcObject = peer.stream;
      void video.play().catch(() => undefined);
      tile.append(video);
    } else {
      tile.append(
        avatarEl(
          { id, displayName: session.known.get(id) ?? contactName(id), status: 'online' },
          { size: 'xl', showStatus: false },
        ),
      );
      if (peer) {
        const audio = h(session.kind === 'video' ? 'video' : 'audio', {
          autoplay: true,
          dataset: { peer: id },
          style: { display: 'none' },
        });
        audio.srcObject = peer.stream;
        tile.append(audio);
        void audio.play().catch(() => undefined);
      }
    }
    tile.append(
      h('span', {
        class: 'tile-label',
        text: `${session.known.get(id) ?? contactName(id)}${peer ? '' : ' · ' + t('calls.connecting')}`,
      }),
    );
    tiles.push(tile);
  }
  session.grid.replaceChildren(...tiles);
}

function ensurePeer(session: CallSession, peerId: string): Peer {
  const existing = session.peers.get(peerId);
  if (existing) return existing;
  const pc = new RTCPeerConnection({ iceServers: session.iceServers, bundlePolicy: 'max-bundle' });
  const stream = new MediaStream();
  for (const track of session.localStream.getTracks()) pc.addTrack(track, session.localStream);
  const peer: Peer = { pc, stream, pendingCandidates: [], hasRemoteDescription: false, connectTimer: 0 };
  pc.ontrack = (event) => {
    for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
      if (!stream.getTracks().some((existingTrack) => existingTrack.id === track.id)) stream.addTrack(track);
    }
    renderGrid(session);
  };
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      realtime.send({
        type: 'call:signal',
        callId: session.callId,
        to: peerId,
        data: { candidate: event.candidate.toJSON() },
      });
    }
  };
  peer.connectTimer = window.setTimeout(() => {
    if (active !== session || session.peers.get(peerId) !== peer) return;
    if (pc.connectionState === 'connected') return;
    toast(t('calls.connectionFailed'), 'error');
  }, CONNECT_TIMEOUT_MS);
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      window.clearTimeout(peer.connectTimer);
      session.status = 'active';
    } else if (pc.connectionState === 'failed') {
      window.clearTimeout(peer.connectTimer);
      toast(t('calls.failed'), 'error');
    }
    renderGrid(session);
  };
  session.peers.set(peerId, peer);
  renderGrid(session);
  return peer;
}

async function offerTo(session: CallSession, peerId: string): Promise<void> {
  if (!realtime.isOpen() || active !== session || session.peers.get(peerId)?.pc.remoteDescription) return;
  const peer = ensurePeer(session, peerId);
  try {
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    realtime.send({
      type: 'call:signal',
      callId: session.callId,
      to: peerId,
      data: { kind: 'offer', sdp: peer.pc.localDescription?.toJSON() },
    });
  } catch (error) {
    toast(error instanceof Error ? error.message : t('calls.failed'), 'error');
  }
}

async function handleSignal(session: CallSession, from: string, data: Record<string, unknown>): Promise<void> {
  if (active !== session) return;
  const peer = ensurePeer(session, from);
  try {
    if (data.kind === 'offer' && data.sdp) {
      if (peer.pc.signalingState !== 'stable') return;
      await peer.pc.setRemoteDescription(data.sdp as RTCSessionDescriptionInit);
      peer.hasRemoteDescription = true;
      for (const candidate of peer.pendingCandidates.splice(0)) await peer.pc.addIceCandidate(candidate);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      realtime.send({
        type: 'call:signal',
        callId: session.callId,
        to: from,
        data: { kind: 'answer', sdp: peer.pc.localDescription?.toJSON() },
      });
    } else if (data.kind === 'answer' && data.sdp) {
      if (peer.pc.signalingState !== 'have-local-offer') return;
      await peer.pc.setRemoteDescription(data.sdp as RTCSessionDescriptionInit);
      peer.hasRemoteDescription = true;
      for (const candidate of peer.pendingCandidates.splice(0)) await peer.pc.addIceCandidate(candidate);
    } else if (data.candidate) {
      const candidate = data.candidate as RTCIceCandidateInit;
      if (peer.hasRemoteDescription) await peer.pc.addIceCandidate(candidate);
      else peer.pendingCandidates.push(candidate);
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : t('calls.failed'), 'error');
  }
}

function endCall(session: CallSession, notify: boolean): void {
  if (active !== session) return;
  if (notify && realtime.isOpen()) realtime.send({ type: 'call:end', callId: session.callId });
  active = null;
  window.clearInterval(session.timer);
  for (const peer of session.peers.values()) {
    window.clearTimeout(peer.connectTimer);
    try {
      peer.pc.close();
    } catch {
      // ignore
    }
  }
  session.peers.clear();
  for (const track of session.localStream.getTracks()) track.stop();
  session.screenTrack?.stop();
  session.overlay.remove();
  stopRingtone();
  toast(t('calls.ended'), 'info');
}

async function toggleScreenShare(session: CallSession, button: HTMLButtonElement): Promise<void> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast(t('calls.failed'), 'error');
    return;
  }
  if (session.screenTrack) {
    await stopScreenShare(session, button);
    return;
  }
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = display.getVideoTracks()[0];
    if (!track) return;
    session.screenTrack = track;
    session.cameraTrack ??= session.localStream.getVideoTracks()[0] ?? null;
    await replaceVideoTrack(session, track);
    track.addEventListener('ended', () => {
      void stopScreenShare(session, button);
    });
    button.classList.add('off');
    button.setAttribute('aria-label', t('calls.stopShare'));
    button.setAttribute('title', t('calls.stopShare'));
    renderGrid(session);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') return;
    toast(error instanceof Error ? error.message : t('calls.failed'), 'error');
  }
}

async function stopScreenShare(session: CallSession, button: HTMLButtonElement): Promise<void> {
  session.screenTrack?.stop();
  session.screenTrack = null;
  if (session.cameraTrack && session.cameraTrack.readyState === 'live') {
    await replaceVideoTrack(session, session.cameraTrack);
  }
  button.classList.remove('off');
  button.setAttribute('aria-label', t('calls.screenShare'));
  button.setAttribute('title', t('calls.screenShare'));
  renderGrid(session);
}

async function replaceVideoTrack(session: CallSession, track: MediaStreamTrack): Promise<void> {
  const oldTracks = session.localStream.getVideoTracks();
  for (const old of oldTracks) {
    if (old.id !== track.id) {
      session.localStream.removeTrack(old);
      if (old !== session.cameraTrack) old.stop();
    }
  }
  if (!session.localStream.getVideoTracks().some((existing) => existing.id === track.id))
    session.localStream.addTrack(track);
  for (const peer of session.peers.values()) {
    const sender = peer.pc.getSenders().find((entry) => entry.track?.kind === 'video');
    if (sender) await sender.replaceTrack(track);
  }
  renderGrid(session);
}

async function openDevices(session: CallSession): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const microphones = devices.filter((device) => device.kind === 'audioinput');
  const cameras = devices.filter((device) => device.kind === 'videoinput');
  const currentAudio = session.localStream.getAudioTracks()[0]?.getSettings().deviceId;
  const currentVideo = session.localStream.getVideoTracks()[0]?.getSettings().deviceId;
  const micOptions = microphones.map((device, index) => ({
    value: device.deviceId,
    label: device.label || `Microfono ${index + 1}`,
  }));
  const camOptions = cameras.map((device, index) => ({
    value: device.deviceId,
    label: device.label || `Videocamera ${index + 1}`,
  }));
  const micValue =
    currentAudio && micOptions.some((option) => option.value === currentAudio) ? currentAudio : micOptions[0]?.value;
  const camValue =
    currentVideo && camOptions.some((option) => option.value === currentVideo) ? currentVideo : camOptions[0]?.value;
  const mic = createSelectPill({
    value: micValue,
    ariaLabel: t('calls.microphone'),
    options: micOptions,
  });
  const cam = createSelectPill({
    value: camValue,
    ariaLabel: t('calls.camera'),
    options: camOptions,
  });
  const modal = openModal({
    title: t('calls.devices'),
    className: 'call-devices-modal',
    body: h(
      'div',
      { class: 'stack' },
      h('div', { class: 'field' }, h('label', { text: t('calls.microphone') }), mic),
      h('div', { class: 'field' }, h('label', { text: t('calls.camera') }), cam),
      h('p', { class: 'hint', text: t('settings.devicesHint') }),
    ),
    actions: [
      { label: t('common.cancel') },
      {
        label: t('common.apply'),
        kind: 'primary',
        close: false,
        onClick: async () => {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: { deviceId: mic.value ? { exact: mic.value } : undefined },
              video: session.kind === 'video' && cam.value ? { deviceId: { exact: cam.value } } : false,
            });
            const audioTrack = stream.getAudioTracks()[0];
            if (audioTrack) {
              const old = session.localStream.getAudioTracks()[0];
              for (const peer of session.peers.values()) {
                const sender = peer.pc.getSenders().find((entry) => entry.track?.kind === 'audio');
                if (sender) await sender.replaceTrack(audioTrack);
              }
              if (old) {
                session.localStream.removeTrack(old);
                old.stop();
              }
              session.localStream.addTrack(audioTrack);
            }
            const videoTrack = stream.getVideoTracks()[0];
            if (videoTrack) {
              session.cameraTrack?.stop();
              session.cameraTrack = videoTrack;
              await replaceVideoTrack(session, videoTrack);
            }
            modal.close();
            renderGrid(session);
          } catch (error) {
            toast(error instanceof Error ? error.message : t('calls.mediaDenied'), 'error');
          }
        },
      },
    ],
  });
}

function closeIncoming(): void {
  incomingModal?.close();
  incomingModal = null;
  stopRingtone();
}

async function acceptIncoming(info: IncomingCall): Promise<void> {
  if (active) {
    realtime.send({ type: 'call:reject', callId: info.callId, reason: 'busy' });
    closeIncoming();
    return;
  }
  if (!secureContextOk()) return;
  let localStream: MediaStream;
  try {
    localStream = await getLocalMedia(info.kind);
  } catch (error) {
    realtime.send({ type: 'call:reject', callId: info.callId, reason: 'media_error' });
    toast(error instanceof Error ? error.message : t('calls.mediaDenied'), 'error');
    closeIncoming();
    return;
  }
  const session: CallSession = {
    callId: info.callId,
    kind: info.kind,
    initiator: false,
    localStream,
    cameraTrack: localStream.getVideoTracks()[0] ?? null,
    screenTrack: null,
    peers: new Map(),
    known: new Map(
      info.members.filter((member) => member.id !== state.user?.id).map((member) => [member.id, member.displayName]),
    ),
    pendingTargets: new Set(),
    overlay: h('div'),
    grid: h('div'),
    status: 'connecting',
    startedAt: Date.now(),
    timer: 0,
    iceServers: [],
  };
  active = session;
  closeIncoming();
  createOverlay(session);
  try {
    const ice = await fetchIceServers();
    session.iceServers = ice.iceServers;
  } catch {
    session.iceServers = [];
  }
  realtime.send({ type: 'call:accept', callId: info.callId });
}

function showIncoming(info: IncomingCall): void {
  if (active) {
    realtime.send({ type: 'call:reject', callId: info.callId, reason: 'busy' });
    return;
  }
  closeIncoming();
  startRingtone();
  const modal = openModal({
    title: info.kind === 'video' ? t('calls.incomingVideo') : t('calls.incoming'),
    body: h(
      'div',
      { class: 'ring-modal' },
      h(
        'div',
        { class: 'ring-avatar' },
        avatarEl(
          { id: info.from.id, displayName: info.from.displayName, status: 'online' },
          { size: 'xl', showStatus: false },
        ),
      ),
      h('h2', { text: info.from.displayName }),
      h('p', { class: 'soft', text: info.kind === 'video' ? t('calls.video') : t('calls.audio') }),
      h('p', { class: 'hint', text: t('calls.accept') }),
    ),
    actions: [
      {
        label: t('calls.reject'),
        kind: 'danger',
        close: false,
        onClick: () => {
          realtime.send({ type: 'call:reject', callId: info.callId, reason: 'declined' });
          closeIncoming();
        },
      },
      {
        label: t('calls.accept'),
        kind: 'primary',
        close: false,
        onClick: () => void acceptIncoming(info),
      },
    ],
    onClose: () => {
      if (!active) realtime.send({ type: 'call:reject', callId: info.callId, reason: 'declined' });
      stopRingtone();
    },
  });
  incomingModal = modal;
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(info.from.displayName, {
        body: info.kind === 'video' ? t('calls.incomingVideo') : t('calls.incoming'),
        icon: '/icon.svg',
        tag: `call-${info.callId}`,
      });
    } catch {
      // ignore
    }
  }
}

export function startCall(userId: string, kind: 'audio' | 'video'): void {
  void startGroupCall([userId], kind);
}

export async function startGroupCall(userIds: string[], kind: 'audio' | 'video'): Promise<void> {
  if (!secureContextOk()) return;
  if (!realtime.isOpen()) {
    toast('Connessione realtime non disponibile. Riprova tra poco.', 'error');
    return;
  }
  if (active) {
    toast(t('calls.busy'), 'error');
    return;
  }
  const targets = [...new Set(userIds)].filter((id) => id !== state.user?.id);
  if (targets.length === 0 || targets.length > 3) {
    toast(t('calls.failed'), 'error');
    return;
  }
  let localStream: MediaStream;
  try {
    localStream = await getLocalMedia(kind);
  } catch (error) {
    toast(error instanceof Error ? error.message : t('calls.mediaDenied'), 'error');
    return;
  }
  const callId = crypto.randomUUID();
  const session: CallSession = {
    callId,
    kind,
    initiator: true,
    localStream,
    cameraTrack: localStream.getVideoTracks()[0] ?? null,
    screenTrack: null,
    peers: new Map(),
    known: new Map(targets.map((id) => [id, contactName(id)])),
    pendingTargets: new Set(targets),
    overlay: h('div'),
    grid: h('div'),
    status: 'ringing',
    startedAt: Date.now(),
    timer: 0,
    iceServers: [],
  };
  active = session;
  createOverlay(session);
  try {
    const ice = await fetchIceServers();
    session.iceServers = ice.iceServers;
  } catch (error) {
    if (error instanceof ApiError) toast(error.message, 'error');
  }
  const sent = realtime.send({ type: 'call:invite', callId, kind, to: targets });
  if (!sent) {
    endCall(session, false);
    toast(t('calls.failed'), 'error');
  }
}

export function initCalls(): void {
  if (initialized) return;
  initialized = true;
  realtime.on('call:incoming', (payload) => {
    const info = payload as unknown as IncomingCall;
    if (!info.callId || !info.from) return;
    showIncoming(info);
  });
  realtime.on('call:ringing', () => {
    if (active) {
      active.status = 'ringing';
      renderGrid(active);
    }
  });
  realtime.on('call:accepted', (payload) => {
    if (!active || payload.callId !== active.callId) return;
    const userId = String(payload.userId ?? '');
    if (!userId) return;
    active.pendingTargets.delete(userId);
    const user = payload.user as { displayName?: string } | undefined;
    active.known.set(userId, user?.displayName ?? contactName(userId));
    active.status = 'connecting';
    void offerTo(active, userId);
  });
  realtime.on('call:peer-joined', (payload) => {
    if (!active || payload.callId !== active.callId) return;
    const userId = String(payload.userId ?? '');
    if (!userId) return;
    const user = payload.user as { displayName?: string } | undefined;
    active.known.set(userId, user?.displayName ?? contactName(userId));
    void offerTo(active, userId);
  });
  realtime.on('call:signal', (payload) => {
    if (!active || payload.callId !== active.callId) return;
    const from = String(payload.from ?? '');
    if (!from || !payload.data) return;
    void handleSignal(active, from, payload.data as Record<string, unknown>);
  });
  realtime.on('call:rejected', (payload) => {
    if (!active || payload.callId !== active.callId) return;
    const userId = String(payload.userId ?? '');
    toast(payload.busy ? t('calls.busy') : t('calls.rejected'), 'info');
    active.pendingTargets.delete(userId);
    if (active.peers.size === 0 && active.pendingTargets.size === 0) endCall(active, false);
  });
  realtime.on('call:busy', (payload) => {
    if (active && payload.callId === active.callId) {
      toast(t('calls.busy'), 'info');
      endCall(active, false);
    }
  });
  realtime.on('call:unavailable', (payload) => {
    if (!active || payload.callId !== active.callId) return;
    toast(t('calls.failed'), 'info');
    const ids = Array.isArray(payload.userIds) ? payload.userIds.map(String) : [];
    for (const id of ids) active.pendingTargets.delete(id);
    if (active.peers.size === 0 && active.pendingTargets.size === 0) endCall(active, false);
  });
  realtime.on('call:timeout', (payload) => {
    if (active && payload.callId === active.callId) {
      toast(t('calls.timeout'), 'info');
      endCall(active, false);
    }
  });
  realtime.on('call:ended', (payload) => {
    if (active && payload.callId === active.callId) endCall(active, false);
  });
  realtime.on('call:peer-left', (payload) => {
    if (!active || payload.callId !== active.callId) return;
    const userId = String(payload.userId ?? '');
    const peer = active.peers.get(userId);
    if (peer) {
      peer.pc.close();
      active.peers.delete(userId);
      renderGrid(active);
    }
    if (active.peers.size === 0) endCall(active, false);
  });
  window.addEventListener('beforeunload', () => {
    if (active) realtime.send({ type: 'call:end', callId: active.callId });
  });
}
