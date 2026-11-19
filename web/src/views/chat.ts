import { ApiError, api, blockUser, downloadUrl, getMessages, listRooms, markRead as markRoomRead } from '../api.js';
import { emit, events, on } from '../bus.js';
import { startCall } from '../calls-manager.js';
import { t } from '../i18n.js';
import { realtime } from '../realtime.js';
import { type ChatMessage, type Room, state } from '../store.js';
import {
  avatarEl,
  confirmDialog,
  createSelectPill,
  debounce,
  emptyState,
  fileIcon,
  formatBytes,
  formatDate,
  formatTime,
  h,
  icon,
  openModal,
  promptDialog,
  showMenu,
  toast,
} from '../ui.js';
import { uploadAndWait } from '../uploads.js';
import type { View } from './types.js';

interface FileChoice {
  id: string;
  name: string;
  size: number;
  mime: string;
  kind: string;
  parentId: string | null;
}

interface OwnFilesResponse {
  items: FileChoice[];
  breadcrumb: Array<{ id: string; name: string }>;
}

const MESSAGE_EMOJI = ['👍', '❤️', '😂', '🎉', '👀'];

export function renderChat(initialRoomId?: string, options: { directUserId?: string; search?: string } = {}): View {
  let rooms: Room[] = state.rooms;
  let active: Room | null = null;
  let messages: ChatMessage[] = [];
  let hasMore = false;
  let searchQuery = options.search?.trim() ?? '';
  let searching = searchQuery.length > 0;
  let replyTo: ChatMessage | null = null;
  let attachments: FileChoice[] = [];
  let sending = false;
  let destroyed = false;
  const typingTimer = 0;
  let typingStopTimer = 0;
  const typingUsers = new Map<string, { name: string; expires: number }>();
  const unsubscribes: Array<() => void> = [];
  let searchInput: HTMLInputElement | null = null;
  let messagesEl: HTMLElement | null = null;
  let composerTextarea: HTMLTextAreaElement | null = null;

  const shell = h('div', {
    class: `chat-shell ${initialRoomId || options.directUserId ? '' : 'show-rooms'}`,
  });
  const roomListBody = h('div', { class: 'room-list-body' });
  const conversationRoot = h('div', { class: 'conversation' });
  const roomList = h(
    'aside',
    { class: 'room-list' },
    h(
      'div',
      { class: 'room-list-head' },
      h('strong', { class: 'grow', text: t('chat.title') }),
      h(
        'button',
        {
          type: 'button',
          class: 'icon-btn',
          'aria-label': t('chat.newChat'),
          title: t('chat.newChat'),
          onclick: () => void openNewChat(),
        },
        icon('plus', 18),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'icon-btn',
          'aria-label': t('chat.newGroup'),
          title: t('chat.newGroup'),
          onclick: () => void openNewGroup(),
        },
        icon('users', 18),
      ),
    ),
    roomListBody,
  );
  shell.append(roomList, conversationRoot);
  const node = shell;

  function otherMember(room: Room): Room['members'][number] | undefined {
    return room.members.find((member) => member.id !== state.user?.id);
  }

  function roomAvatar(room: Room): HTMLElement {
    if (room.kind === 'dm') {
      const other = otherMember(room);
      return avatarEl(
        { id: other?.id ?? room.id, displayName: other?.displayName ?? room.title, status: other?.status },
        { size: 'sm' },
      );
    }
    return avatarEl({ id: room.id, displayName: room.title, status: 'online' }, { size: 'sm', showStatus: false });
  }

  function previewText(room: Room): string {
    if (!room.lastMessage) return t('chat.emptyConversation');
    const sender =
      room.lastMessage.senderId === state.user?.id
        ? t('common.you')
        : (room.members.find((member) => member.id === room.lastMessage?.senderId)?.displayName ?? '');
    return `${sender}: ${room.lastMessage.preview}`;
  }

  function renderRoomList(): void {
    roomListBody.replaceChildren();
    if (rooms.length === 0) {
      roomListBody.append(
        h(
          'div',
          { class: 'empty', style: { padding: '30px 14px' } },
          h('div', { class: 'empty-icon' }, icon('chat', 26)),
          h('p', { text: t('chat.emptyTitle') }),
          h('button', { type: 'button', class: 'btn small', onclick: () => void openNewChat() }, t('chat.newChat')),
        ),
      );
      return;
    }
    for (const room of rooms) {
      const button = h(
        'button',
        {
          type: 'button',
          class: `room-item ${active?.id === room.id ? 'active' : ''}`,
          onclick: () => void openRoom(room),
        },
        roomAvatar(room),
        h(
          'div',
          { class: 'room-info' },
          h(
            'div',
            { class: 'row' },
            h('div', { class: 'room-title grow', text: room.title }),
            room.muted ? icon('bell', 13) : null,
          ),
          h('div', { class: 'room-preview', text: previewText(room) }),
        ),
        room.unread > 0 ? h('span', { class: 'unread', text: String(room.unread) }) : null,
      );
      roomListBody.append(button);
    }
  }

  function showRoomList(show: boolean): void {
    shell.classList.toggle('show-rooms', show);
  }

  function activeSubtitle(room: Room): string {
    if (room.kind === 'dm') {
      const other = otherMember(room);
      return other ? `${t('common.' + (other.status || 'offline'))}` : '';
    }
    return t('chat.memberCount', { n: room.members.length });
  }

  function conversationHeader(room: Room): HTMLElement {
    const other = otherMember(room);
    const actions = h('div', { class: 'actions' });
    actions.append(
      h(
        'button',
        {
          type: 'button',
          class: 'icon-btn',
          'aria-label': t('chat.searchMessages'),
          title: t('chat.searchMessages'),
          onclick: () => toggleSearch(),
        },
        icon('search', 18),
      ),
    );
    if (room.kind === 'dm' && other) {
      actions.append(
        h(
          'button',
          {
            type: 'button',
            class: 'icon-btn',
            'aria-label': t('calls.audio'),
            title: t('calls.audio'),
            onclick: () => startCall(other.id, 'audio'),
          },
          icon('phone', 18),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-btn',
            'aria-label': t('calls.video'),
            title: t('calls.video'),
            onclick: () => startCall(other.id, 'video'),
          },
          icon('video', 18),
        ),
      );
    }
    actions.append(
      h(
        'button',
        {
          type: 'button',
          class: 'icon-btn',
          'aria-label': t('chat.roomSettings'),
          title: t('chat.roomSettings'),
          onclick: (event: MouseEvent) => roomMenu(room, event.currentTarget as HTMLElement),
        },
        icon('more', 18),
      ),
    );
    const header = h(
      'div',
      { class: 'conversation-head' },
      h(
        'button',
        {
          type: 'button',
          class: 'icon-btn mobile-menu',
          'aria-label': t('chat.toggleRooms'),
          onclick: () => showRoomList(true),
        },
        icon('arrowLeft', 18),
      ),
      roomAvatar(room),
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'title', text: room.title }),
        h('div', { class: 'sub', text: activeSubtitle(room) }),
      ),
      actions,
    );
    if (searching) {
      searchInput = h('input', {
        type: 'search',
        placeholder: t('chat.searchMessages'),
        value: searchQuery,
        'aria-label': t('chat.searchMessages'),
        oninput: debounce(() => {
          searchQuery = searchInput?.value.trim() ?? '';
          void loadMessages();
        }, 350),
      });
      header.append(h('label', { class: 'search-box', style: { minWidth: '180px' } }, icon('search', 15), searchInput));
      window.setTimeout(() => searchInput?.focus(), 0);
    }
    return header;
  }

  function toggleSearch(): void {
    searching = !searching;
    if (!searching) searchQuery = '';
    renderConversation();
    if (searching) void loadMessages();
  }

  function renderConversation(): void {
    conversationRoot.replaceChildren();
    if (!active) {
      conversationRoot.append(
        h(
          'div',
          { class: 'conversation-empty' },
          emptyState(
            'chat',
            t('chat.selectChat'),
            t('chat.emptyText'),
            h('button', { type: 'button', class: 'btn primary', onclick: () => void openNewChat() }, t('chat.newChat')),
          ),
        ),
      );
      return;
    }
    conversationRoot.append(conversationHeader(active));
    messagesEl = h('div', { class: 'messages', role: 'log', 'aria-live': 'polite' });
    conversationRoot.append(messagesEl);
    const typing = h('div', { class: 'typing', 'aria-live': 'polite' });
    conversationRoot.append(typing);
    conversationRoot.append(composer());
    renderMessages();
    updateTyping();
  }

  function composer(): HTMLElement {
    const chips = h('div', { class: 'attachment-preview-row' });
    const renderChips = (): void => {
      chips.replaceChildren();
      for (const file of attachments) {
        chips.append(
          h(
            'span',
            { class: 'attachment-chip' },
            icon('paperclip', 13),
            h('span', { text: file.name }),
            h(
              'button',
              {
                type: 'button',
                'aria-label': `${t('common.remove')} ${file.name}`,
                onclick: () => {
                  attachments = attachments.filter((entry) => entry.id !== file.id);
                  renderChips();
                },
              },
              icon('close', 12),
            ),
          ),
        );
      }
    };
    renderChips();
    const replyRow = h('div', { class: 'attachment-preview-row' });
    const renderReply = (): void => {
      replyRow.replaceChildren();
      if (replyTo) {
        replyRow.append(
          h(
            'span',
            { class: 'attachment-chip' },
            icon('chat', 13),
            h('span', { text: `${t('chat.reply')}: ${replyTo.body.slice(0, 60)}` }),
            h(
              'button',
              {
                type: 'button',
                'aria-label': t('common.remove'),
                onclick: () => {
                  replyTo = null;
                  renderReply();
                },
              },
              icon('close', 12),
            ),
          ),
        );
      }
    };
    renderReply();

    const textarea = h('textarea', {
      rows: '1',
      placeholder: t('chat.typeMessage'),
      'aria-label': t('chat.typeMessage'),
      oninput: () => {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(160, textarea.scrollHeight)}px`;
        if (active) {
          realtime.send({ type: 'typing', roomId: active.id, typing: true });
          window.clearTimeout(typingStopTimer);
          typingStopTimer = window.setTimeout(() => {
            if (active) realtime.send({ type: 'typing', roomId: active.id, typing: false });
          }, 1600);
        }
      },
      onkeydown: (event: KeyboardEvent) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          void sendMessage();
        }
      },
    });
    composerTextarea = textarea;

    const attachFromFiles = h(
      'button',
      {
        type: 'button',
        class: 'icon-btn',
        'aria-label': t('chat.attachFromFiles'),
        title: t('chat.attachFromFiles'),
        onclick: () =>
          void pickFiles((file) => {
            attachments.push(file);
            renderChips();
          }),
      },
      icon('paperclip', 18),
    );
    const uploadInput = h('input', {
      type: 'file',
      hidden: true,
      onchange: async () => {
        const file = uploadInput.files?.[0];
        uploadInput.value = '';
        if (!file) return;
        attachFromFiles.disabled = true;
        try {
          const uploaded = await uploadAndWait(file, null);
          attachments.push({
            id: uploaded.id,
            name: uploaded.name,
            size: uploaded.size,
            mime: file.type || 'application/octet-stream',
            kind: 'file',
            parentId: null,
          });
          renderChips();
        } catch (error) {
          toast(error instanceof Error ? error.message : t('files.uploadFailed'), 'error');
        } finally {
          attachFromFiles.disabled = false;
        }
      },
    });
    const uploadButton = h(
      'button',
      {
        type: 'button',
        class: 'icon-btn',
        'aria-label': t('chat.attach'),
        title: t('chat.uploadAndSend'),
        onclick: () => uploadInput.click(),
      },
      icon('upload', 18),
    );
    const sendButton = h(
      'button',
      {
        type: 'button',
        class: 'send',
        'aria-label': t('chat.send'),
        title: t('chat.send'),
        onclick: () => void sendMessage(),
      },
      icon('send', 18),
    );
    const inner = h(
      'div',
      { class: 'composer-inner' },
      attachFromFiles,
      uploadButton,
      textarea,
      sendButton,
      uploadInput,
    );
    const element = h('div', { class: 'composer' }, chips, replyRow, inner);
    element.dataset.composer = 'true';
    return element;
  }

  function renderMessages(keepPosition = false): void {
    if (!messagesEl || !active) return;
    const previousScroll = messagesEl.scrollTop;
    const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140;
    messagesEl.replaceChildren();
    if (searching && searchQuery) {
      messagesEl.append(h('div', { class: 'day-sep', text: `${t('chat.searchResults')}: ${searchQuery}` }));
    }
    if (messages.length === 0) {
      messagesEl.append(
        h(
          'div',
          { class: 'conversation-empty' },
          emptyState(
            searching ? 'search' : 'chat',
            searching ? t('chat.noMessagesFound') : t('chat.emptyConversation'),
            searching ? '' : t('chat.emptyText'),
          ),
        ),
      );
      return;
    }
    let lastDay = '';
    for (const message of messages) {
      const day = new Date(message.createdAt).toDateString();
      if (day !== lastDay) {
        lastDay = day;
        messagesEl.append(h('div', { class: 'day-sep', text: dateLabel(message.createdAt) }));
      }
      messagesEl.append(messageRow(message));
    }
    if (hasMore && !searching) {
      messagesEl.prepend(
        h(
          'div',
          { class: 'row', style: { justifyContent: 'center', padding: '4px' } },
          h('button', { type: 'button', class: 'btn small', onclick: () => void loadOlder() }, t('common.loadMore')),
        ),
      );
    }
    if (!keepPosition) {
      if (nearBottom || messages[messages.length - 1]?.sender.id === state.user?.id) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } else {
        messagesEl.scrollTop = previousScroll;
      }
    }
  }

  function dateLabel(timestamp: number): string {
    const date = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return t('chat.today');
    if (date.toDateString() === yesterday.toDateString()) return t('chat.yesterday');
    return formatDate(timestamp);
  }

  function messageRow(message: ChatMessage): HTMLElement {
    const mine = message.sender.id === state.user?.id;
    const showAvatar = !mine;
    const bubble = h('div', { class: 'bubble' });
    if (message.replyTo) {
      bubble.append(h('div', { class: 'reply-quote', text: `${message.replyTo.senderName}: ${message.replyTo.body}` }));
    }
    if (message.body) bubble.append(h('div', { text: message.body }));
    for (const attachment of message.attachments) {
      bubble.append(
        h(
          'a',
          {
            class: 'attachment-card',
            href: downloadUrl(attachment.fileId),
            download: attachment.name,
            title: `${t('common.download')} ${attachment.name}`,
          },
          fileIcon(attachment.kind, attachment.mime),
          h(
            'div',
            { class: 'grow' },
            h('div', { class: 'att-name', text: attachment.name }),
            h('div', { class: 'att-meta', text: formatBytes(attachment.size) }),
          ),
          icon('download', 15),
        ),
      );
    }
    const meta = h('div', { class: 'msg-meta' });
    if (!mine && active?.kind !== 'dm') meta.append(h('strong', { text: message.sender.displayName }));
    meta.append(h('span', { text: formatTime(message.createdAt) }));
    if (mine && active?.readReceipts && (message.readBy ?? 0) > 0)
      meta.append(h('span', { text: t('chat.readBy', { n: message.readBy ?? 0 }) }));
    const actions = h(
      'div',
      { class: 'msg-actions' },
      h(
        'button',
        {
          type: 'button',
          'aria-label': t('chat.reply'),
          title: t('chat.reply'),
          onclick: () => {
            replyTo = message;
            renderConversation();
            composerTextarea?.focus();
          },
        },
        icon('arrowLeft', 13),
      ),
      h(
        'button',
        {
          type: 'button',
          'aria-label': t('chat.react'),
          title: t('chat.react'),
          onclick: (event: MouseEvent) => reactionMenu(message, event.currentTarget as HTMLElement),
        },
        '☺',
      ),
      mine
        ? h(
            'button',
            {
              type: 'button',
              'aria-label': t('chat.deleteMessage'),
              title: t('chat.deleteMessage'),
              onclick: async () => {
                if (
                  !(await confirmDialog({
                    title: t('chat.deleteMessage'),
                    message: t('chat.deleteMessage'),
                    confirmLabel: t('common.delete'),
                    danger: true,
                  }))
                )
                  return;
                try {
                  await api(`/api/messages/${encodeURIComponent(message.id)}`, { method: 'DELETE' });
                  messages = messages.filter((entry) => entry.id !== message.id);
                  renderMessages();
                } catch (error) {
                  toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
                }
              },
            },
            icon('trash', 13),
          )
        : null,
    );
    const reactions = h('div', { class: 'reactions' });
    for (const reaction of message.reactions) {
      reactions.append(
        h(
          'button',
          {
            type: 'button',
            class: `reaction ${reaction.mine ? 'mine' : ''}`,
            title: t('chat.react'),
            onclick: () => void toggleReaction(message, reaction.emoji),
          },
          h('span', { text: reaction.emoji }),
          h('span', { text: String(reaction.count) }),
        ),
      );
    }
    const bubbleWrap = h(
      'div',
      { class: 'bubble-wrap' },
      meta,
      h('div', { class: 'row', style: { alignItems: 'flex-end', gap: '4px' } }, bubble, actions),
      reactions.childElementCount > 0 ? reactions : null,
    );
    return h(
      'div',
      { class: `message-row ${mine ? 'mine' : ''}` },
      showAvatar
        ? h(
            'div',
            { class: 'msg-avatar' },
            avatarEl(
              { id: message.sender.id, displayName: message.sender.displayName },
              { size: 'sm', showStatus: false },
            ),
          )
        : null,
      bubbleWrap,
    );
  }

  function reactionMenu(message: ChatMessage, anchor: HTMLElement): void {
    showMenu(
      anchor,
      MESSAGE_EMOJI.map((emoji) => ({
        label: emoji,
        onClick: () => toggleReaction(message, emoji),
      })),
    );
  }

  async function toggleReaction(message: ChatMessage, emoji: string): Promise<void> {
    try {
      const result = await api<{ reactions: ChatMessage['reactions'] }>(
        `/api/messages/${encodeURIComponent(message.id)}/reactions`,
        {
          method: 'POST',
          body: { emoji },
        },
      );
      message.reactions = result.reactions;
      renderMessages(true);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
    }
  }

  function updateTyping(): void {
    const element = conversationRoot.querySelector('.typing');
    if (!element) return;
    const now = Date.now();
    for (const [id, entry] of typingUsers) if (entry.expires < now) typingUsers.delete(id);
    const names = [...typingUsers.values()].map((entry) => entry.name);
    element.textContent = names.length > 0 ? t('chat.typing', { name: names.join(', ') }) : '';
  }

  async function loadMessages(): Promise<void> {
    if (!active) return;
    try {
      const response = await getMessages(active.id, { q: searching && searchQuery ? searchQuery : undefined });
      if (destroyed) return;
      messages = response.messages;
      hasMore = response.hasMore;
      renderConversation();
      await markRoomRead(active.id, messages[messages.length - 1]?.id);
      active.unread = 0;
      renderRoomList();
      emit(events.roomsUpdated);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        toast(error.message, 'error');
        active = null;
        renderConversation();
        renderRoomList();
        return;
      }
      toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
    }
  }

  async function loadOlder(): Promise<void> {
    if (!active || messages.length === 0) return;
    const oldest = messages[0];
    if (!oldest) return;
    const response = await getMessages(active.id, { before: oldest.createdAt });
    messages = [...response.messages, ...messages];
    hasMore = response.hasMore;
    renderMessages(true);
    if (messagesEl) messagesEl.scrollTop = 120;
  }

  async function openRoom(room: Room, push = true): Promise<void> {
    if (active?.id === room.id && push) {
      showRoomList(false);
      return;
    }
    active = room;
    room.unread = 0;
    searchQuery = '';
    searching = false;
    replyTo = null;
    attachments = [];
    typingUsers.clear();
    messages = [];
    showRoomList(false);
    renderRoomList();
    renderConversation();
    if (push) history.pushState(null, '', `/chat/${encodeURIComponent(room.id)}`);
    else history.replaceState(null, '', `/chat/${encodeURIComponent(room.id)}`);
    await loadMessages();
  }

  async function sendMessage(): Promise<void> {
    if (!active || sending) return;
    const text = composerTextarea?.value.trim() ?? '';
    if (!text && attachments.length === 0) return;
    sending = true;
    try {
      const response = await api<{ message: ChatMessage }>(
        `/api/chat/rooms/${encodeURIComponent(active.id)}/messages`,
        {
          method: 'POST',
          body: {
            body: text,
            replyToId: replyTo?.id ?? null,
            attachmentFileIds: attachments.map((file) => file.id),
          },
        },
      );
      messages.push(response.message);
      replyTo = null;
      attachments = [];
      if (composerTextarea) {
        composerTextarea.value = '';
        composerTextarea.style.height = 'auto';
      }
      renderConversation();
      active.unread = 0;
      renderRoomList();
      await markRoomRead(active.id, response.message.id);
      if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
    } finally {
      sending = false;
    }
  }

  async function createRoom(body: Record<string, unknown>): Promise<Room | null> {
    try {
      const response = await api<{ room: Room }>('/api/chat/rooms', { method: 'POST', body });
      const room = response.room;
      rooms = [room, ...rooms.filter((entry) => entry.id !== room.id)];
      state.rooms = rooms;
      renderRoomList();
      await openRoom(room);
      return room;
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
      return null;
    }
  }

  function contactPicker(onPick: (id: string) => void): void {
    const contacts = state.contacts.filter((contact) => !contact.blocked);
    const body = h('div', { class: 'stack' });
    if (contacts.length === 0) body.append(h('p', { class: 'soft', text: t('calls.noContacts') }));
    for (const contact of contacts) {
      body.append(
        h(
          'button',
          {
            type: 'button',
            class: 'room-item',
            onclick: () => {
              modal.close();
              onPick(contact.id);
            },
          },
          avatarEl(contact, { size: 'sm' }),
          h(
            'div',
            { class: 'room-info' },
            h('div', { class: 'room-title', text: contact.displayName }),
            h('div', { class: 'room-preview', text: `@${contact.username} · ${t('common.' + contact.status)}` }),
          ),
        ),
      );
    }
    const modal = openModal({ title: t('chat.newChat'), body, actions: [{ label: t('common.cancel') }] });
  }

  function openNewChat(): void {
    contactPicker((id) => void createRoom({ kind: 'dm', userId: id }));
  }

  function openNewGroup(): void {
    const name = h('input', { class: 'input', maxlength: '80', placeholder: t('chat.groupName'), required: true });
    const kind = createSelectPill({
      value: 'group',
      ariaLabel: 'Tipo',
      options: [
        { value: 'group', label: t('chat.newGroup'), dotColor: 'var(--accent)' },
        { value: 'channel', label: 'Canale', dotColor: 'var(--mint)' },
      ],
    });
    const list = h('div', { class: 'stack' });
    const selected = new Set<string>();
    for (const contact of state.contacts.filter((entry) => !entry.blocked)) {
      const checkbox = h('input', {
        type: 'checkbox',
        value: contact.id,
        onchange: () => {
          if (checkbox.checked) selected.add(contact.id);
          else selected.delete(contact.id);
        },
      });
      list.append(
        h(
          'label',
          { class: 'row', style: { padding: '6px 0', cursor: 'pointer' } },
          checkbox,
          avatarEl(contact, { size: 'sm', showStatus: false }),
          h('span', { text: contact.displayName }),
        ),
      );
    }
    const body = h(
      'div',
      { class: 'stack' },
      h('div', { class: 'field' }, h('label', { text: t('chat.groupName') }), name),
      h('div', { class: 'field' }, h('label', { text: 'Tipo' }), kind),
      h('div', { class: 'field' }, h('label', { text: t('chat.members') }), list),
    );
    openModal({
      title: t('chat.newGroup'),
      body,
      wide: true,
      actions: [
        { label: t('common.cancel') },
        {
          label: t('chat.createGroup'),
          kind: 'primary',
          close: false,
          onClick: async () => {
            if (!name.value.trim()) {
              toast(t('chat.groupName'), 'error');
              return;
            }
            const room = await createRoom({ kind: kind.value, name: name.value.trim(), memberIds: [...selected] });
            if (room) {
              toast(t('chat.groupCreated'), 'success');
              for (const element of document.querySelectorAll('.modal-backdrop')) element.remove();
            }
          },
        },
      ],
    });
  }

  async function pickFiles(onPick: (file: FileChoice) => void): Promise<void> {
    let current: string | null = null;
    const list = h('div', { class: 'stack' }, h('p', { class: 'soft', text: t('common.loading') }));
    const crumbs = h('div', { class: 'breadcrumb' });
    const modal = openModal({
      title: t('chat.selectFilesTitle'),
      body: h('div', { class: 'stack' }, crumbs, list),
      wide: true,
      actions: [{ label: t('common.close') }],
    });
    const go = async (parent: string | null): Promise<void> => {
      current = parent;
      try {
        const data = await api<OwnFilesResponse>(`/api/files?${parent ? `parent=${encodeURIComponent(parent)}` : ''}`);
        crumbs.replaceChildren(h('button', { type: 'button', text: t('files.root'), onclick: () => void go(null) }));
        for (const crumb of data.breadcrumb)
          crumbs.append(
            h('span', { class: 'sep', text: '/' }),
            h('button', { type: 'button', text: crumb.name, onclick: () => void go(crumb.id) }),
          );
        list.replaceChildren();
        const folders = data.items.filter((item) => item.kind === 'folder');
        const files = data.items.filter((item) => item.kind === 'file' && item.mime);
        for (const folder of folders) {
          list.append(
            h(
              'button',
              {
                type: 'button',
                class: 'file-row',
                style: { border: '1px solid var(--border)', borderRadius: '10px' },
                onclick: () => void go(folder.id),
              },
              fileIcon('folder', ''),
              h('span', { class: 'grow file-name', text: folder.name }),
              icon('chevron', 15),
            ),
          );
        }
        for (const file of files) {
          list.append(
            h(
              'button',
              {
                type: 'button',
                class: 'file-row',
                style: { border: '1px solid var(--border)', borderRadius: '10px' },
                onclick: () => {
                  onPick(file);
                  modal.close();
                },
              },
              fileIcon('file', file.mime),
              h(
                'span',
                { class: 'grow', style: { textAlign: 'left' } },
                h('div', { class: 'file-name', text: file.name }),
                h('div', { class: 'hint', text: formatBytes(file.size) }),
              ),
              icon('paperclip', 15),
            ),
          );
        }
        if (data.items.length === 0) list.append(h('p', { class: 'soft', text: t('files.emptyTitle') }));
      } catch (error) {
        list.replaceChildren(
          h('div', { class: 'notice danger', text: error instanceof ApiError ? error.message : t('common.error') }),
        );
      }
    };
    void go(current);
  }

  function roomMenu(room: Room, anchor: HTMLElement): void {
    const other = otherMember(room);
    const blockedByMe = other ? Boolean(state.contacts.find((contact) => contact.id === other.id)?.blocked) : false;
    showMenu(anchor, [
      {
        label: room.readReceipts
          ? `${t('chat.readReceipts')}: ${t('common.enabled')}`
          : `${t('chat.readReceipts')}: ${t('common.disabled')}`,
        iconName: 'check',
        onClick: async () => {
          const response = await api<{ room: Room }>(`/api/chat/rooms/${encodeURIComponent(room.id)}`, {
            method: 'PATCH',
            body: { readReceipts: !room.readReceipts },
          });
          Object.assign(room, response.room);
          renderConversation();
        },
      },
      {
        label: room.muted ? t('chat.unmute') : t('chat.mute'),
        iconName: 'bell',
        onClick: async () => {
          const response = await api<{ room: Room }>(`/api/chat/rooms/${encodeURIComponent(room.id)}`, {
            method: 'PATCH',
            body: { muted: !room.muted },
          });
          Object.assign(room, response.room);
          renderRoomList();
        },
      },
      ...(room.kind !== 'dm'
        ? [
            {
              label: t('common.rename'),
              iconName: 'file',
              onClick: async () => {
                const name = await promptDialog({
                  title: t('common.rename'),
                  label: t('chat.groupName'),
                  value: room.title,
                });
                if (!name) return;
                const response = await api<{ room: Room }>(`/api/chat/rooms/${encodeURIComponent(room.id)}`, {
                  method: 'PATCH',
                  body: { name },
                });
                Object.assign(room, response.room);
                renderRoomList();
                renderConversation();
              },
            },
          ]
        : []),
      ...(other
        ? [
            {
              label: blockedByMe ? t('chat.unblock') : t('chat.block'),
              iconName: 'shield',
              danger: !blockedByMe,
              onClick: async () => {
                await blockUser(other.id, !blockedByMe);
                const contact = state.contacts.find((entry) => entry.id === other.id);
                if (contact) contact.blocked = !contact.blocked;
                toast(t('common.saved'), 'success');
              },
            },
            {
              label: t('chat.report'),
              iconName: 'shield',
              danger: true,
              onClick: async () => {
                const reason = await promptDialog({ title: t('chat.report'), label: t('chat.reportReason') });
                if (!reason) return;
                await api('/api/reports', { method: 'POST', body: { targetUserId: other.id, reason } });
                toast(t('chat.reportSent'), 'success');
              },
            },
          ]
        : []),
    ]);
  }

  const unsubscribeMessage = realtime.on('message:new', (payload) => {
    const message = payload.message as ChatMessage | undefined;
    if (!message) return;
    const room =
      rooms.find((entry) => entry.id === message.roomId) ?? state.rooms.find((entry) => entry.id === message.roomId);
    if (active?.id === message.roomId) {
      messages.push(message);
      renderMessages();
      if (document.visibilityState === 'visible') void markRoomRead(active.id, message.id);
    } else if (!room) {
      // A brand-new room can arrive before its room:created frame (for
      // example after a reconnect). Re-read the authoritative list.
      void reloadRooms();
    } else if (room) {
      room.unread += 1;
      room.lastMessage = {
        id: message.id,
        senderId: message.sender.id,
        preview: message.body.slice(0, 120),
        createdAt: message.createdAt,
      };
      renderRoomList();
      emit(events.roomsUpdated);
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        try {
          new Notification(message.sender.displayName, {
            body: message.body.slice(0, 120) || t('chat.attachment'),
            icon: '/icon.svg',
            tag: `room-${room.id}`,
          });
        } catch {
          // notifications may be blocked
        }
      }
    }
    if (room) {
      room.lastMessage = {
        id: message.id,
        senderId: message.sender.id,
        preview: message.body.slice(0, 120) || t('chat.attachment'),
        createdAt: message.createdAt,
      };
      rooms = [...rooms].sort((a, b) => b.updatedAt - a.updatedAt);
      renderRoomList();
    }
  });
  const unsubscribeTyping = realtime.on('typing', (payload) => {
    if (payload.roomId !== active?.id) return;
    const userId = String(payload.userId ?? '');
    if (!userId) return;
    if (payload.typing === true)
      typingUsers.set(userId, { name: String(payload.displayName ?? ''), expires: Date.now() + 4500 });
    else typingUsers.delete(userId);
    updateTyping();
  });
  const unsubscribeReactions = realtime.on('message:reactions', (payload) => {
    if (payload.roomId !== active?.id) return;
    const message = messages.find((entry) => entry.id === payload.messageId);
    if (message) {
      message.reactions = payload.reactions as ChatMessage['reactions'];
      renderMessages(true);
    }
  });
  const unsubscribeDeleted = realtime.on('message:deleted', (payload) => {
    if (payload.roomId !== active?.id) return;
    messages = messages.filter((entry) => entry.id !== payload.messageId);
    renderMessages(true);
  });
  const unsubscribeCreated = realtime.on('room:created', () => {
    void reloadRooms();
  });
  const unsubscribeRead = realtime.on('read:update', (payload) => {
    if (!active || payload.roomId !== active.id || !active.readReceipts) return;
    for (const message of messages) {
      if (message.sender.id === state.user?.id && message.createdAt <= Number(payload.lastReadAt)) {
        message.readBy = Math.max(message.readBy ?? 0, 1);
      }
    }
    renderMessages(true);
  });
  const unsubscribePresence = on(events.contactsUpdated, () => {
    // The local room list can be a re-sorted copy of state.rooms, so sync the
    // member snapshots before re-rendering to reflect presence immediately.
    for (const room of rooms) {
      for (const member of room.members) {
        const contact = state.contacts.find((entry) => entry.id === member.id);
        if (!contact) continue;
        member.status = contact.status;
        member.displayName = contact.displayName;
      }
    }
    renderRoomList();
    if (active) renderConversation();
  });
  unsubscribes.push(
    unsubscribeMessage,
    unsubscribeTyping,
    unsubscribeReactions,
    unsubscribeDeleted,
    unsubscribeCreated,
    unsubscribeRead,
    unsubscribePresence,
  );

  async function reloadRooms(): Promise<void> {
    try {
      rooms = await listRooms();
      state.rooms = rooms;
      if (!active && rooms[0]) {
        active = rooms[0];
        history.replaceState(null, '', `/chat/${encodeURIComponent(active.id)}`);
        await loadMessages();
        return;
      }
      if (active) active = rooms.find((room) => room.id === active?.id) ?? active;
      renderRoomList();
      renderConversation();
    } catch {
      // best effort
    }
  }

  renderRoomList();
  if (initialRoomId) {
    const existing = rooms.find((room) => room.id === initialRoomId);
    if (existing) {
      active = existing;
      renderRoomList();
      renderConversation();
      void loadMessages();
    } else {
      conversationRoot.append(
        h('div', { class: 'conversation-empty' }, h('p', { class: 'soft', text: t('common.loading') })),
      );
      void reloadRooms().then(() => {
        if (!active) {
          void openRoomFallback(initialRoomId);
        }
      });
    }
  } else if (options.directUserId) {
    conversationRoot.append(
      h('div', { class: 'conversation-empty' }, h('p', { class: 'soft', text: t('common.loading') })),
    );
    void createRoom({ kind: 'dm', userId: options.directUserId }).then((room) => {
      if (!room && !destroyed) renderConversation();
    });
  } else if (rooms[0]) {
    void openRoom(rooms[0], false);
  } else {
    void reloadRooms();
    renderConversation();
  }

  async function openRoomFallback(roomId: string): Promise<void> {
    try {
      const fresh = await listRooms();
      rooms = fresh;
      state.rooms = fresh;
      const room = fresh.find((entry) => entry.id === roomId);
      if (room) {
        active = room;
        renderRoomList();
        renderConversation();
        void loadMessages();
      } else {
        renderConversation();
        toast(t('chat.noRooms'), 'error');
      }
    } catch {
      renderConversation();
    }
  }

  const typingInterval = window.setInterval(() => {
    if (typingUsers.size > 0) updateTyping();
  }, 2000);

  return {
    node,
    destroy: () => {
      destroyed = true;
      window.clearInterval(typingInterval);
      window.clearTimeout(typingTimer);
      window.clearTimeout(typingStopTimer);
      for (const unsubscribe of unsubscribes) unsubscribe();
      if (active) realtime.send({ type: 'typing', roomId: active.id, typing: false });
    },
  };
}
