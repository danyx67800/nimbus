import { uploadFile } from './api.js';
import { emit, events } from './bus.js';
import { t } from './i18n.js';
import { hashFile } from './sha256.js';
import { formatBytes, h, icon, toast } from './ui.js';

export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  parentId: string | null;
}

interface Task {
  id: string;
  file: File;
  parentId: string | null;
  status: 'queued' | 'hashing' | 'uploading' | 'done' | 'error';
  progress: number;
  hash: string | null;
  element: HTMLElement;
  bar: HTMLElement;
  label: HTMLElement;
  cancelButton: HTMLButtonElement;
  statusMessage?: string;
  cancelRequested: boolean;
  result: UploadedFile | null;
}

let tray: HTMLElement | null = null;
const tasks: Task[] = [];
let running = false;

function ensureTray(): HTMLElement {
  if (!tray) {
    tray = h('div', { class: 'uploads-tray', id: 'uploads-tray', role: 'region', 'aria-label': 'Caricamenti' });
    document.body.append(tray);
  }
  return tray;
}

function taskLabel(task: Task): string {
  if (task.status === 'hashing') return 'Preparazione…';
  if (task.status === 'uploading') return `${t('files.uploading')} ${Math.round(task.progress * 100)}%`;
  if (task.status === 'done') return t('files.uploadComplete');
  if (task.status === 'error') return task.statusMessage ?? t('files.uploadFailed');
  return t('qs.queued');
}

function updateTask(task: Task): void {
  task.bar.style.width = `${Math.round(task.progress * 100)}%`;
  task.label.textContent = task.status === 'error' ? (task.statusMessage ?? t('files.uploadFailed')) : taskLabel(task);
  task.element.classList.toggle('error', task.status === 'error');
  task.cancelButton.hidden = task.status !== 'queued' && task.status !== 'error';
}

function buildTask(file: File, parentId: string | null): Task {
  const bar = h('span', { style: { width: '0%' } });
  const label = h('span', { class: 'muted', text: t('qs.queued') });
  const cancelButton = h(
    'button',
    { type: 'button', class: 'icon-btn', 'aria-label': t('common.cancel'), hidden: true },
    icon('close', 14),
  );
  const element = h(
    'div',
    { class: 'upload-item', role: 'status' },
    h(
      'div',
      { class: 'row' },
      h('span', { text: file.name, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }),
      cancelButton,
    ),
    h(
      'div',
      { class: 'row', style: { marginTop: '2px' } },
      label,
      h('span', { class: 'muted', text: formatBytes(file.size) }),
    ),
    h('div', { class: 'progress' }, bar),
  );
  const task: Task = {
    id: crypto.randomUUID(),
    file,
    parentId,
    status: 'queued',
    progress: 0,
    hash: null,
    element,
    bar,
    label,
    cancelButton,
    cancelRequested: false,
    result: null,
  };
  cancelButton.addEventListener('click', () => {
    if (task.status === 'error' || task.status === 'queued') {
      task.cancelRequested = true;
      task.status = 'error';
      task.statusMessage = t('qs.cancelled');
      task.label.textContent = task.statusMessage;
      task.cancelButton.hidden = true;
    }
  });
  return task;
}

async function runTask(task: Task): Promise<UploadedFile | null> {
  if (task.status === 'error') return null;
  task.status = 'hashing';
  task.progress = 0;
  updateTask(task);
  try {
    const hash =
      task.hash ??
      (await hashFile(task.file, (fraction) => {
        task.progress = fraction * 0.3;
        updateTask(task);
      }));
    task.hash = hash;
    if (task.cancelRequested) return null;
    task.status = 'uploading';
    const item = await uploadFile(task.file, task.parentId, hash, (fraction) => {
      task.progress = 0.3 + fraction * 0.7;
      updateTask(task);
    });
    task.result = item;
    task.status = 'done';
    task.progress = 1;
    updateTask(task);
    emit(events.filesChanged);
    return item;
  } catch (error) {
    task.status = 'error';
    task.statusMessage = error instanceof Error ? error.message : t('files.uploadFailed');
    updateTask(task);
    toast(`${task.file.name}: ${task.statusMessage}`, 'error');
    return null;
  }
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    ensureTray();
    while (true) {
      const next = tasks.find((task) => task.status === 'queued');
      if (!next) break;
      await runTask(next);
    }
  } finally {
    running = false;
    const active = tasks.some(
      (task) => task.status === 'queued' || task.status === 'hashing' || task.status === 'uploading',
    );
    if (!active) {
      window.setTimeout(() => {
        if (tasks.every((task) => task.status === 'done')) {
          tray?.remove();
          tray = null;
          tasks.length = 0;
        }
      }, 3500);
    }
  }
}

export function enqueueUploads(files: File[], parentId: string | null): Promise<Array<UploadedFile | null>> {
  if (files.length === 0) return Promise.resolve([]);
  const trayElement = ensureTray();
  const created = files.map((file) => buildTask(file, parentId));
  for (const task of created) {
    trayElement.append(task.element);
    tasks.push(task);
    task.element.addEventListener('dblclick', () => {
      if (task.status === 'error') {
        task.status = 'queued';
        task.statusMessage = undefined;
        updateTask(task);
        void pump();
      }
    });
  }
  void pump();
  return Promise.all(
    created.map(
      (task) =>
        new Promise<UploadedFile | null>((resolve) => {
          const check = window.setInterval(() => {
            if (task.status === 'done' || task.status === 'error') {
              window.clearInterval(check);
              resolve(
                task.status === 'done'
                  ? (task.result ?? { id: '', name: task.file.name, size: task.file.size, parentId })
                  : null,
              );
            }
          }, 120);
        }),
    ),
  );
}

export async function uploadAndWait(file: File, parentId: string | null, sha256?: string): Promise<UploadedFile> {
  const trayElement = ensureTray();
  const task = buildTask(file, parentId);
  task.hash = sha256 ?? null;
  trayElement.append(task.element);
  tasks.push(task);
  const result = await runTask(task);
  if (!result) throw new Error(task.statusMessage ?? t('files.uploadFailed'));
  return result;
}
