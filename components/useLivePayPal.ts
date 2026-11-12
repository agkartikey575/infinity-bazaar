"use client";

// Real PayPal sandbox payments for the deal room. The server does all the work
// (AgentGuard, ledger, PayPal); this hook calls it at the right moments, opens
// the PayPal window when a person has to approve, and keeps the signed ledger.
import { useCallback, useEffect, useRef, useState } from "react";

/** The run the server rebuilds: your rules ride along when you set them, and none means the defaults. */
export type RunRef = { kind: "mission" | "single" | "rogue"; id: string; seed: number; nonce: string; rules?: { budgetUsd: number; askAboveUsd: number } };

export type LiveState =
  | "idle"
  | "working"
  /** AgentGuard on the server wants your OK before anything happens. */
  | "needs-decision"
  /** PayPal needs you: click "Pay with PayPal". */
  | "needs-click"
  | "waiting-paypal"
  | "blocked"
  | "declined"
  | "captured"
  | "authorized"
  | "voided"
  | "error";

type Action = "pay" | "complete" | "deliver";

export interface LiveLine {
  state: LiveState;
  rows: { text: string; detail?: string; tone?: "ok" | "ask" | "bad"; debugId?: string | null }[];
  approveUrl?: string;
  error?: string;
  /** What to repeat when you press Retry. */
  failed?: Action;
  /** Whether PayPal or our own server reported the error. */
  errorFrom?: "paypal" | "app";
  userApproved?: boolean;
  /** PayPal accepted the payment but is still reviewing it: not shown as paid yet. */
  review?: boolean;
}

interface Status {
  mode: "sandbox" | "simulated";
  wallet: boolean;
}


/**
 * Opens PayPal in a new tab and switches to it.
 * With no URL yet, it shows a short "Connecting to PayPal…" note instead of a blank page.
 */
export function openPayPalWindow(url?: string): Window | null {
  // A new tab every time, which the browser switches to. A leftover PayPal tab can never swallow the click.
  const win = window.open(url ?? "", `paypal-${Date.now()}`);
  if (!win) return null;
  try {
    win.focus();
    if (!url && (win.location.href === "about:blank" || win.location.origin === window.location.origin)) {
      win.document.title = "Connecting to PayPal…";
      win.document.body.style.cssText = "margin:0;display:grid;place-items:center;height:100vh;font:16px system-ui,sans-serif;color:#444";
      win.document.body.textContent = "Connecting to PayPal…";
    }
  } catch {
    // The window is already on PayPal's site; it will be sent to the new address.
  }
  return win;
}
const BLOCKED = "Your browser blocked the PayPal window. Allow pop-ups for this site, then press Pay with PayPal.";

/** Waits for the PayPal return page to post back, or for the window to close. */
function waitForReturn(win: Window, kind: "order" | "wallet", line?: number): Promise<{ how: "returned" | "cancelled" | "closed"; token?: string | null }> {
  return new Promise((resolve) => {
    let closedAt = 0;
    const done = (how: "returned" | "cancelled" | "closed", token?: string | null) => {
      window.removeEventListener("message", onMessage);
      clearInterval(timer);
      resolve({ how, token });
    };
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; kind?: string; line?: number | null; cancelled?: boolean; token?: string | null };
      if (e.origin !== window.location.origin || m?.type !== "paypal-return") return;
      if (m.kind !== kind || (kind === "order" && m.line !== line)) return;
      done(m.cancelled ? "cancelled" : "returned", m.token);
    };
    window.addEventListener("message", onMessage);
    // A closed window may still have approved: the caller asks the server, it never assumes a cancel.
    const timer = setInterval(() => {
      if (!win.closed) return;
      if (!closedAt) closedAt = Date.now();
      else if (Date.now() - closedAt > 1000) done("closed");
    }, 400);
  });
}

const newNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 20);
export { newNonce };

export function useLivePayPal(run: RunRef) {
  const [status, setStatus] = useState<Status>({ mode: "simulated", wallet: false });
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<{ key: string; lines: Record<number, LiveLine> }>({ key: "", lines: {} });
  const [walletError, setWalletError] = useState<string | null>(null);
  const ledger = useRef<string | undefined>(undefined);
  const busy = useRef(new Set<number>());
  const keyRef = useRef("");
  const runKey = `${run.kind}:${run.id}:${run.seed}:${run.nonce}:${run.rules ? `${run.rules.budgetUsd}/${run.rules.askAboveUsd}` : ""}`;
  // Lines belong to one run: after a switch they read as empty immediately, not one render later.
  const lines = state.key === runKey ? state.lines : {};

  useEffect(() => {
    fetch("/api/agent/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Status | null) => {
        if (s) {
          // Demo mode first: live sandbox payments need a PayPal sandbox login, so you switch them on yourself.
          setStatus(s);
        }
      })
      .catch(() => undefined); // static hosting: no API, stay simulated
  }, []);

  // Every Play gets a new nonce, a new ledger and a clean slate.
  useEffect(() => {
    ledger.current = undefined;
    keyRef.current = runKey;
    busy.current.clear();
    setState({ key: runKey, lines: {} });
  }, [runKey]);

  /** Merge a patch into a line; new log rows are appended, not replaced. */
  const set = (line: number, patch: Partial<LiveLine>) =>
    setState((prev) => {
      if (prev.key !== keyRef.current) return prev; // a reply for a run that has been replaced
      const cur: LiveLine = prev.lines[line] ?? { state: "idle", rows: [] };
      return { ...prev, lines: { ...prev.lines, [line]: { ...cur, ...patch, rows: [...cur.rows, ...(patch.rows ?? [])] } } };
    });

  const post = useCallback(
    async (path: string, line: number, extra: Record<string, unknown> = {}) => {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run, line, ledger: ledger.current, ...extra }),
      });
      const data = await res.json().catch(() => ({ error: res.statusText }));
      if (!res.ok) throw Object.assign(new Error(`${data.error ?? res.statusText}${data.debugId ? ` · PayPal debug id ${data.debugId}` : ""}`), { fromPayPal: res.status === 502 });
      if (data.ledger) ledger.current = data.ledger;
      return data;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runKey],
  );

  /** Runs one server step for a line; on failure, Retry repeats that same step. */
  const guarded = useCallback(async (line: number, action: Action, fn: () => Promise<void>) => {
    if (busy.current.has(line)) return; // double click
    busy.current.add(line);
    try {
      await fn();
    } catch (e) {
      // A network failure reaching our own server reads as "app"; only PayPal's own errors (502) blame PayPal.
      const fromPayPal = (e as { fromPayPal?: boolean })?.fromPayPal === true;
      set(line, { state: "error", failed: action, errorFrom: fromPayPal ? "paypal" : "app", error: e instanceof Error ? e.message : String(e) });
    } finally {
      busy.current.delete(line);
    }
  }, []);

  /** After the PayPal window: finish the order, or go back to waiting for you. */
  const finish = useCallback(
    async (line: number) => {
      const c = await post("/api/agent/complete", line);
      if (c.needsApproval) return set(line, { state: "needs-click", approveUrl: c.approveUrl, rows: c.log });
      set(line, { state: c.state, review: c.review === true, rows: c.log });
    },
    [post],
  );

  const approveInWindow = useCallback(
    async (line: number, url: string, win: Window | null) => {
      const w = win ?? openPayPalWindow(url);
      if (!w) return set(line, { state: "needs-click", approveUrl: url, rows: [{ text: BLOCKED, tone: "ask" }] });
      if (win) w.location.href = url;
      set(line, { state: "waiting-paypal", approveUrl: url, rows: [{ text: "Waiting for your approval in the PayPal window…", tone: "ask" }] });
      const r = await waitForReturn(w, "order", line);
      if (r.how === "cancelled") {
        const d = await post("/api/agent/decline", line);
        return set(line, { state: "declined", rows: [{ text: "You cancelled in PayPal.", tone: "bad" }, ...d.log] });
      }
      // Returned or just closed: the server checks with PayPal whether it was approved.
      await finish(line);
    },
    [post, finish],
  );

  /**
   * Pay a line. Pass `win` (opened in the click handler) when the person just
   * approved, so the PayPal window isn't blocked as a pop-up.
   */
  const pay = useCallback(
    (line: number, userApproved: boolean, win: Window | null = null) =>
      guarded(line, "pay", async () => {
        set(line, { state: "working", userApproved });
        const r = await post("/api/agent/pay", line, { userApproved });
        set(line, { rows: r.log });
        if (r.decision === "needs_paypal_approval") {
          if (win) return approveInWindow(line, r.approveUrl, win);
          return set(line, { state: "needs-click", approveUrl: r.approveUrl });
        }
        win?.close();
        if (r.decision === "ask_user") return set(line, { state: "needs-decision" });
        if (r.decision === "block") return set(line, { state: "blocked" });
        if (r.decision === "declined") return set(line, { state: "declined" });
        set(line, { state: r.state, review: r.review === true });
      }).catch(() => win?.close()),
    [guarded, post, approveInWindow],
  );

  /** "Pay with PayPal" button for a payment PayPal needs a person to approve. */
  const payWithPayPal = useCallback(
    (line: number) => {
      const url = lines[line]?.approveUrl;
      if (!url) return;
      const win = openPayPalWindow(url);
      if (!win) return set(line, { state: "needs-click", rows: [{ text: BLOCKED, tone: "ask" }] });
      guarded(line, "complete", () => approveInWindow(line, url, win));
    },
    [lines, guarded, approveInWindow],
  );

  const deliver = useCallback(
    (line: number) =>
      guarded(line, "deliver", async () => {
        set(line, { state: "working" });
        const d = await post("/api/agent/deliver", line);
        set(line, { state: d.state, review: d.review === true, rows: d.log });
      }),
    [guarded, post],
  );

  const decline = useCallback(
    (line: number) =>
      guarded(line, "pay", async () => {
        const d = await post("/api/agent/decline", line);
        set(line, { state: "declined", rows: d.log });
      }),
    [guarded, post],
  );

  /** Repeat the step that failed. */
  const retry = useCallback(
    (line: number) => {
      const l = lines[line];
      if (!l || l.state !== "error") return;
      if (l.failed === "deliver") return deliver(line);
      if (l.failed === "complete") return guarded(line, "complete", () => finish(line));
      return pay(line, l.userApproved ?? false);
    },
    [lines, deliver, guarded, finish, pay],
  );

  /** Connect a PayPal wallet once, so approved payments go through with no one present. */
  const connectWallet = useCallback(async () => {
    setWalletError(null);
    const win = openPayPalWindow();
    if (!win) return setWalletError(BLOCKED.replace("Pay with PayPal", "Connect PayPal wallet"));
    try {
      const res = await fetch("/api/vault/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      win.location.href = data.approveUrl;
      const r = await waitForReturn(win, "wallet");
      if (r.how === "cancelled") return;
      const fin = await fetch("/api/vault/finish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: r.token ?? null }) });
      if (fin.ok) setStatus((s) => ({ ...s, wallet: true }));
      else setWalletError((await fin.json().catch(() => ({}))).error ?? "PayPal didn't save the wallet.");
    } catch (e) {
      win.close();
      setWalletError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return { status, enabled: enabled && status.mode === "sandbox", setEnabled, lines, pay, payWithPayPal, deliver, decline, retry, connectWallet, walletError };
}
