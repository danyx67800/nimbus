type Listener<T = unknown> = (detail: T) => void;

export function emit<T>(name: string, detail?: T): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function on<T>(name: string, listener: Listener<T>): () => void {
  const wrapped = (event: Event): void => listener((event as CustomEvent<T>).detail);
  window.addEventListener(name, wrapped);
  return () => window.removeEventListener(name, wrapped);
}

export const events = {
  unauthorized: 'nimbus:unauthorized',
  userUpdated: 'nimbus:user-updated',
  contactsUpdated: 'nimbus:contacts-updated',
  roomsUpdated: 'nimbus:rooms-updated',
  filesChanged: 'nimbus:files-changed',
  presence: 'nimbus:presence',
};
