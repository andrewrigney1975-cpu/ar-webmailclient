/**
 * Native integration through Capacitor. Everything here degrades to browser
 * behaviour, so the web build stays usable for development and UI tests.
 */
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Network } from '@capacitor/network';

export const isNative = Capacitor.isNativePlatform();

/**
 * @param {object} hooks
 * @param {() => void} hooks.onResume  the app came back to the foreground
 * @param {() => void} hooks.onOnline  the network came back
 */
export async function initPlatform({ router, store, onResume = () => {}, onOnline = () => {} }) {
  const status = await Network.getStatus();
  store.set({ online: status.connected });
  Network.addListener('networkStatusChange', ({ connected }) => {
    const wasOnline = store.get().online;
    store.set({ online: connected });
    if (connected && !wasOnline) onOnline();
  });

  if (!isNative) {
    // Browser development: Escape stands in for the Android back gesture.
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') router.back();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') onResume();
    });
    return;
  }

  // With a listener registered, Capacitor takes over the system back callback
  // (predictive back is enabled in AndroidManifest.xml).
  App.addListener('backButton', () => {
    if (!router.back()) App.exitApp();
  });
  App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) onResume();
  });
}

/** Opens an external page (e.g. a provider's app-password page) in a Custom Tab or new tab. */
export async function openExternal(url) {
  if (isNative) {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url });
  } else {
    window.open(url, '_blank', 'noopener');
  }
}
