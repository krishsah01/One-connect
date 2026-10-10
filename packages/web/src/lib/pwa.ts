// SPDX-License-Identifier: Apache-2.0
// Progressive web app support. The service worker precaches only a static offline page, the
// manifest and icons. It never stores API or event responses, transcripts, prompts, source,
// credentials or pairing/sign-in links (see public/sw.js). Install state is only what the browser
// tells the page; the page cannot know whether the app was installed elsewhere.
import { isDesktop } from './desktop';

export type InstallState = 'standalone' | 'not-standalone' | 'unsupported';

export async function registerServiceWorker(): Promise<'registered' | 'unsupported' | 'insecure' | 'failed'> {
  if (isDesktop || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 'unsupported';
  const secure = window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!secure) return 'insecure';
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return 'registered';
  } catch {
    return 'failed';
  }
}

export function installState(): InstallState {
  if (typeof window === 'undefined') return 'unsupported';
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches) return 'standalone';
  return 'not-standalone';
}

export interface InstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
let deferred: InstallPromptEvent | null = null;
export function captureInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as InstallPromptEvent; });
}
export const canPromptInstall = (): boolean => deferred !== null;
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferred) return 'unavailable';
  await deferred.prompt();
  const r = await deferred.userChoice;
  deferred = null;
  return r.outcome;
}

export type NotificationPermissionState = 'unsupported' | 'default' | 'granted' | 'denied';
export const notificationPermission = (): NotificationPermissionState => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.requestPermission();
}
