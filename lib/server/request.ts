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

/** The caller's address for the per-client limit: the first x-forwarded-for entry, else x-real-ip. */
export function clientIp(req: { headers: { get(name: string): string | null } }): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip")?.trim() || "unknown";
}
