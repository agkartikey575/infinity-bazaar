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
