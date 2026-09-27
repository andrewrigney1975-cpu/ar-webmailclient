/** App-wide preferences, stored with Capacitor Preferences (SharedPreferences on Android). */
import { Preferences } from '@capacitor/preferences';

export const DEFAULT_SETTINGS = Object.freeze({
  /** Group messages into conversations (PLAN.md §4.2). */
  threading: true,
});

const KEY = 'settings';

export async function loadSettings() {
  try {
    const { value } = await Preferences.get({ key: KEY });
    return { ...DEFAULT_SETTINGS, ...(value ? JSON.parse(value) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings) {
  await Preferences.set({ key: KEY, value: JSON.stringify(settings) });
}
