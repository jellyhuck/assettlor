/**
 * Builds a Content-Disposition value that makes the browser save the response
 * under the asset's own file name. Archive entry names can carry their inner
 * folder path, so only the last path segment is used. The quoted `filename`
 * is an ASCII fallback; `filename*` carries the exact UTF-8 name (RFC 6266).
 */
export function attachmentContentDisposition(name: string): string {
  const baseName = name.split(/[\\/]/u).filter(Boolean).pop() || 'download';
  const asciiName = baseName.replace(/[^\x20-\x7e]|["\\]/gu, '_');
  const encodedName = encodeURIComponent(baseName)
    .replace(/['()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}
