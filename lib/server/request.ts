// Request checks shared by the payment routes. No framework imports, so tests can run them directly.

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Only our own pages may call the payment routes, and only with JSON. Browsers always send Origin on a POST. */
export function checkOrigin(req: { url: string; headers: { get(name: string): string | null } }) {
  const origin = req.headers.get("origin");
  if (origin !== new URL(req.url).origin) throw new HttpError(403, "Requests must come from this site.");
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "Send JSON.");
}

/**
 * The caller's address, for the per-client voice limit. On Vercel the platform sets
 * x-vercel-forwarded-for (and x-real-ip, x-forwarded-for) itself, so the first entry is the
 * visitor. Anywhere else these headers come from the visitor and could be faked, so every
 * request shares one bucket. The per-client limit only spreads use fairly: the real bound on
 * spend is the daily cap (VOICE_DAILY_LIMIT).
 */
export function clientIp(req: { headers: { get(name: string): string | null } }, onVercel = process.env.VERCEL === "1"): string {
  if (!onVercel) return "local";
  const first = (name: string) => req.headers.get(name)?.split(",")[0]?.trim();
  return first("x-vercel-forwarded-for") || first("x-real-ip") || first("x-forwarded-for") || "unknown";
}
