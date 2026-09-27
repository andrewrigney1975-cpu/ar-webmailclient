/**
 * Native integration through Capacitor. Everything here is a no-op in a plain
 * browser, so the web build stays usable for development and UI tests.
 */
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Network } from '@capacitor/network';

export const isNative = Capacitor.isNativePlatform();

export async function initPlatform({ router, store }) {
  const status = await Network.getStatus();
  store.set({ online: status.connected });
  Network.addListener('networkStatusChange', ({ connected }) => store.set({ online: connected }));

  if (!isNative) {
    // Browser development: Escape stands in for the Android back gesture.
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') router.back();
    });
    return;
  }

  // With a listener registered, Capacitor takes over the system back callback
  // (predictive back is enabled in AndroidManifest.xml).
  App.addListener('backButton', () => {
    if (!router.back()) App.exitApp();
  });
}
