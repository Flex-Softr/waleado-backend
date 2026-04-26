/**
 * macOS often resolves `localhost` to ::1 while Homebrew Postgres listens on 127.0.0.1 only,
 * which yields P1001 / "Can't reach database server at localhost:5432".
 */
export function normalizeDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "localhost") {
      u.hostname = "127.0.0.1";
      return u.toString();
    }
  } catch {
    // non-standard URL strings: leave unchanged
  }
  return url;
}
