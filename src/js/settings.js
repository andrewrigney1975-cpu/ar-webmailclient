/** App-wide preferences, stored with Capacitor Preferences (SharedPreferences on Android). */
import { Preferences } from '@capacitor/preferences';

export const DEFAULT_SETTINGS = Object.freeze({
  /** Group messages into conversations (PLAN.md §4.2). */
  threading: true,
});

const KEY = 'settings';
const LIST_KEY = 'listPrefs';

/** Sort and filter for a list, kept per folder ("unified", a folder ID, or "search"). */
export const DEFAULT_LIST_PREFS = Object.freeze({ sort: 'dateReceived', descending: true, attachments: 'any' });

export async function loadListPrefs() {
  try {
    const { value } = await Preferences.get({ key: LIST_KEY });
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

export async function saveListPrefs(prefs) {
  await Preferences.set({ key: LIST_KEY, value: JSON.stringify(prefs) });
}

export function listPrefsFor(prefs, folderKey) {
  return { ...DEFAULT_LIST_PREFS, ...(prefs[folderKey] ?? {}) };
}

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
