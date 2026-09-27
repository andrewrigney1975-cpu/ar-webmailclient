/**
 * HTTP GET for account discovery. On Android it goes through CapacitorHttp
 * (native), which isn't subject to the WebView's CORS rules or the page CSP;
 * in the browser it falls back to fetch.
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';

export async function getText(url, { timeoutMs = 6000, headers = {} } = {}) {
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.get({
      url,
      headers,
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
      responseType: 'text',
    });
    return { status: response.status, text: typeof response.data === 'string' ? response.data : JSON.stringify(response.data) };
  }

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status, text: await response.text() };
}
