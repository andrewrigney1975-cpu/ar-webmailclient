/**
 * Outgoing attachments. Files picked in the WebView are copied into the app
 * cache so the native mail plugin can attach them by path.
 */
import { Capacitor } from '@capacitor/core';

export const MAX_ATTACHMENTS_BYTES = 25 * 1024 * 1024;

function safeName(name) {
  return name.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || 'attachment';
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Copies a picked File into the cache. Returns { filename, mimeType, size, path }. */
export async function stageFile(file) {
  const attachment = {
    filename: file.name || 'attachment',
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
  };
  if (!Capacitor.isNativePlatform()) {
    return { ...attachment, path: `memory://${crypto.randomUUID()}/${safeName(attachment.filename)}` };
  }
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const { uri } = await Filesystem.writeFile({
    path: `outgoing/${crypto.randomUUID()}/${safeName(attachment.filename)}`,
    data: await readAsBase64(file),
    directory: Directory.Cache,
    recursive: true,
  });
  return { ...attachment, path: decodeURIComponent(new URL(uri).pathname) };
}

/**
 * Gives forwarded attachments (still on the server) local paths.
 * @param {(fromMessage: { id, partId }, filename) => Promise<string>} download
 */
export async function resolveAttachments(attachments, download) {
  const resolved = [];
  for (const attachment of attachments) {
    if (attachment.path) resolved.push(attachment);
    else resolved.push({ ...attachment, path: await download(attachment.fromMessage, attachment.filename) });
  }
  return resolved;
}

export function totalSize(attachments) {
  return attachments.reduce((sum, a) => sum + (a.size ?? 0), 0);
}
