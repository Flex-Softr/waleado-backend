/** Avoid open redirects via ?next=//evil.com */
export function isSafeInternalPath(path: string | null | undefined): boolean {
  if (!path) return false;
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//")) return false;
  if (path.includes("://")) return false;
  // Browsers treat "\\" like "/", so "/\\evil.com" would leave the site.
  if (path.includes("\\")) return false;
  // Reject control characters (tabs/newlines are stripped by URL parsers).
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  return true;
}
