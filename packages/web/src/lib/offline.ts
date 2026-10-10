// SPDX-License-Identifier: Apache-2.0
// Offline state. While the browser reports no network, every change is refused at the API layer
// (see api.ts): nothing is queued, so a stale approval can never be replayed later.
import { useSyncExternalStore } from 'react';

export const OFFLINE_MESSAGE = 'You are offline. Nothing was sent and nothing is queued. Try again when you are back online.';

export const isOnline = (): boolean => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

const subscribe = (l: () => void) => {
  window.addEventListener('online', l);
  window.addEventListener('offline', l);
  return () => {
    window.removeEventListener('online', l);
    window.removeEventListener('offline', l);
  };
};

/** True while the browser reports a network connection. It does not prove the daemon is reachable. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, isOnline, () => true);
}
