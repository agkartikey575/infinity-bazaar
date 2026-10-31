// PayPal REST client for the sandbox (or live, by base URL). Server-only:
// it reads the client secret. Every write carries a PayPal-Request-Id so a
// retry or double click returns the same result instead of paying twice.
import { toValue, type Cents } from "../money.ts";

export interface PayPalConfig {
  base: string;
  clientId: string;
  secret: string;
  fetch?: typeof fetch;
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): PayPalConfig | null {
  const clientId = env.PAYPAL_CLIENT_ID;
  const secret = env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) return null;
  return { base: env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com", clientId, secret };
}

export class PayPalError extends Error {
  status: number;
  issue: string | null;
  debugId: string | null;
  constructor(status: number, name: string, message: string, issue: string | null, debugId: string | null) {
    super(`${name}: ${message}${issue ? ` (${issue})` : ""}`);
    this.name = "PayPalError";
    this.status = status;
    this.issue = issue;
    this.debugId = debugId;
  }
}

export interface Call<T> {
  data: T;
  debugId: string | null;
  /** Method and path, for the on-screen log. */
  label: string;
}

export interface OrderLink {
  rel: string;
  href: string;
}

export interface Order {
  id: string;
  status: string;
  links?: OrderLink[];
  purchase_units?: {
    payments?: {
      captures?: { id: string; status: string }[];
      authorizations?: { id: string; status: string }[];
    };
  }[];
}

export interface OrderRequest {
  intent: "CAPTURE" | "AUTHORIZE";
  /** Stable key for this payment line; also the invoice id, which PayPal refuses to reuse. */
  lineKey: string;
  description: string;
  itemName: string;
  itemCents: Cents;
  /** Fee charged now, shown to the buyer as shipping or handling. */
  feeCents: Cents;
  feeKind?: "shipping" | "handling";
  category: "PHYSICAL_GOODS" | "DIGITAL_GOODS";
  /** Shipped goods ask PayPal for the buyer's address; digital goods and services don't. */
  shipped: boolean;
  /** Charge a saved PayPal wallet with no buyer present. */
  vaultId?: string;
  returnUrl?: string;
  cancelUrl?: string;
}

export class PayPalClient {
  private cfg: PayPalConfig;
  private cached: { value: string; expires: number } | null = null;

  constructor(cfg: PayPalConfig) {
    this.cfg = cfg;
  }

  private get fetch() {
    return this.cfg.fetch ?? fetch;
  }

  async accessToken(): Promise<string> {
    if (this.cached && this.cached.expires > Date.now()) return this.cached.value;
    let res: Response;
    try {
      res = await this.fetch(`${this.cfg.base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
        body: "grant_type=client_credentials",
      });
    } catch (e) {
      throw new PayPalError(0, "PAYPAL_UNREACHABLE", "Couldn't reach PayPal. Check the connection and press Retry.", null, null);
    }
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !data.access_token) throw new PayPalError(res.status, "AUTH_FAILED", data.error_description ?? "could not get a token", null, null);
    this.cached = { value: data.access_token, expires: Date.now() + Math.max(60, (data.expires_in ?? 300) - 60) * 1000 };
    return data.access_token;
  }

  /** One REST call. Retries once on a network error, a 5xx (same request id) or an expired token. */
  async call<T>(method: "GET" | "POST", path: string, body?: unknown, requestId?: string): Promise<Call<T>> {
    const label = `${method} ${path}`;
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      let res: Response;
      try {
        res = await this.fetch(`${this.cfg.base}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Prefer: "return=representation",
            ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        if (attempt === 0) continue;
        throw new PayPalError(0, "PAYPAL_UNREACHABLE", "Couldn't reach PayPal. Check the connection and press Retry.", null, null);
      }
      const debugId = res.headers.get("paypal-debug-id");
      const text = await res.text();
      let parsed: unknown = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { name: "BAD_RESPONSE", message: text.slice(0, 200) };
      }
      const data = parsed as T & { name?: string; message?: string; details?: { issue?: string }[] };
      if (res.status === 401 && attempt === 0) {
        this.cached = null;
        continue;
      }
      if (res.status >= 500 && attempt === 0) continue;
      if (!res.ok) throw new PayPalError(res.status, data.name ?? "PAYPAL_ERROR", data.message ?? res.statusText, data.details?.[0]?.issue ?? null, debugId);
      return { data, debugId, label };
    }
  }

  createOrder(req: OrderRequest, requestId: string) {
    const item = toValue(req.itemCents);
    const total = toValue((req.itemCents + req.feeCents) as Cents);
    const breakdown: Record<string, { currency_code: string; value: string }> = { item_total: { currency_code: "USD", value: item } };
    if (req.feeCents > 0) breakdown[req.feeKind ?? "handling"] = { currency_code: "USD", value: toValue(req.feeCents) };
    const experience = {
      brand_name: "Infinity Bazaar",
      shipping_preference: req.shipped ? "GET_FROM_FILE" : "NO_SHIPPING",
      user_action: "PAY_NOW",
      ...(req.returnUrl ? { return_url: req.returnUrl, cancel_url: req.cancelUrl ?? req.returnUrl } : {}),
    };
    return this.call<Order>(
      "POST",
      "/v2/checkout/orders",
      {
        intent: req.intent,
        purchase_units: [
          {
            reference_id: req.lineKey,
            invoice_id: `IB-${req.lineKey}`,
            description: req.description.slice(0, 127),
            amount: { currency_code: "USD", value: total, breakdown },
            items: [{ name: req.itemName.slice(0, 127), quantity: "1", unit_amount: { currency_code: "USD", value: item }, category: req.category }],
          },
        ],
        payment_source: {
          paypal: req.vaultId
            ? {
                vault_id: req.vaultId,
                stored_credential: { payment_initiator: "MERCHANT", usage: "SUBSEQUENT", usage_pattern: "UNSCHEDULED_POSTPAID" },
                experience_context: experience,
              }
            : { experience_context: experience },
        },
      },
      requestId,
    );
  }

  captureOrder(orderId: string, requestId: string) {
    return this.call<Order>("POST", `/v2/checkout/orders/${orderId}/capture`, {}, requestId);
  }

  authorizeOrder(orderId: string, requestId: string) {
    return this.call<Order>("POST", `/v2/checkout/orders/${orderId}/authorize`, {}, requestId);
  }

  captureAuthorization(authorizationId: string, requestId: string) {
    return this.call<{ id: string; status: string }>("POST", `/v2/payments/authorizations/${authorizationId}/capture`, { final_capture: true }, requestId);
  }

  voidAuthorization(authorizationId: string, requestId: string) {
    return this.call<{ id?: string; status?: string }>("POST", `/v2/payments/authorizations/${authorizationId}/void`, undefined, requestId);
  }

  getOrder(orderId: string) {
    return this.call<Order>("GET", `/v2/checkout/orders/${orderId}`);
  }

  /** Step 1 of saving a PayPal wallet for the agent: the buyer approves once. */
  createSetupToken(returnUrl: string, cancelUrl: string, requestId: string) {
    return this.call<{ id: string; status: string; links?: OrderLink[] }>(
      "POST",
      "/v3/vault/setup-tokens",
      {
        payment_source: {
          paypal: {
            description: "Infinity Bazaar shopping agent",
            usage_type: "MERCHANT",
            customer_type: "CONSUMER",
            permit_multiple_payment_tokens: true,
            experience_context: { brand_name: "Infinity Bazaar", return_url: returnUrl, cancel_url: cancelUrl },
          },
        },
      },
      requestId,
    );
  }

  /** Step 2: turn the approved setup token into a vault id the agent can charge. */
  createPaymentToken(setupTokenId: string, requestId: string) {
    return this.call<{ id: string; customer?: { id: string } }>(
      "POST",
      "/v3/vault/payment-tokens",
      { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } },
      requestId,
    );
  }
}

/** The approval link in an order or setup-token response. */
export const approveLink = (links?: OrderLink[]) => links?.find((l) => l.rel === "approve" || l.rel === "payer-action")?.href ?? null;

/** Capture or authorization from an order response, with PayPal's own status for it. */
export function paymentIds(order: Order): { captureId: string | null; authorizationId: string | null; status: string | null } {
  const p = order.purchase_units?.[0]?.payments;
  const cap = p?.captures?.[0];
  const auth = p?.authorizations?.[0];
  return { captureId: cap?.id ?? null, authorizationId: auth?.id ?? null, status: cap?.status ?? auth?.status ?? null };
}

/** A capture counts once COMPLETED (or PENDING review); an authorization once CREATED (or PENDING). */
export const paymentSucceeded = (status: string | null) => status === "COMPLETED" || status === "CREATED" || status === "PENDING";
