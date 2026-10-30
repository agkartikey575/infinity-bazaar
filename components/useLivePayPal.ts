"use client";

// Real PayPal sandbox payments for the deal room. The server does all the work
// (AgentGuard, ledger, PayPal); this hook calls it at the right moments, opens
// the PayPal window when a person has to approve, and keeps the signed ledger.
import { useCallback, useEffect, useRef, useState } from "react";

export type RunRef = { kind: "mission" | "single" | "rogue"; id: string; seed: number };

export type LiveState = "idle" | "working" | "needs-click" | "waiting-paypal" | "blocked" | "declined" | "captured" | "authorized" | "voided" | "error";

export interface LiveLine {
  state: LiveState;
  rows: { text: string; debugId?: string | null }[];
  approveUrl?: string;
  error?: string;
}

interface Status {
  mode: "sandbox" | "simulated";
  wallet: boolean;
}

const POPUP = "width=480,height=720";

/** Waits for the PayPal return page to post back, or for the window to close. */
function waitForReturn(win: Window | null, kind: "order" | "wallet", line?: number): Promise<{ cancelled: boolean }> {
  return new Promise((resolve) => {
    const done = (cancelled: boolean) => {
      window.removeEventListener("message", onMessage);
      clearInterval(timer);
      resolve({ cancelled });
    };
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; kind?: string; line?: number | null; cancelled?: boolean };
      if (e.origin !== window.location.origin || m?.type !== "paypal-return") return;
      if (m.kind !== kind || (kind === "order" && m.line !== line)) return;
      done(Boolean(m.cancelled));
    };
    window.addEventListener("message", onMessage);
    // Closing the window without finishing counts as a cancel.
    const timer = setInterval(() => {
      if (win && win.closed) setTimeout(() => done(true), 800);
    }, 500);
  });
}

export function useLivePayPal(run: RunRef) {
  const [status, setStatus] = useState<Status>({ mode: "simulated", wallet: false });
  const [enabled, setEnabled] = useState(false);
  const [lines, setLines] = useState<Record<number, LiveLine>>({});
  const ledger = useRef<string | undefined>(undefined);
  const runKey = `${run.kind}:${run.id}:${run.seed}`;

  useEffect(() => {
    fetch("/api/agent/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Status | null) => {
        if (s) {
          setStatus(s);
          setEnabled(s.mode === "sandbox");
        }
      })
      .catch(() => undefined); // static hosting: no API, stay simulated
  }, []);

  // A new run starts with an empty ledger.
  useEffect(() => {
    ledger.current = undefined;
    setLines({});
  }, [runKey]);

  /** Merge a patch into a line; new log rows are appended, not replaced. */
  const set = (line: number, patch: Partial<LiveLine>) =>
    setLines((prev) => {
      const cur: LiveLine = prev[line] ?? { state: "idle", rows: [] };
      return { ...prev, [line]: { ...cur, ...patch, rows: [...cur.rows, ...(patch.rows ?? [])] } };
    });

  const post = useCallback(
    async (path: string, line: number, extra: Record<string, unknown> = {}) => {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run, line, ledger: ledger.current, ...extra }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`${data.error ?? res.statusText}${data.debugId ? ` · PayPal debug id ${data.debugId}` : ""}`);
      if (data.ledger) ledger.current = data.ledger;
      return data;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runKey],
  );

  /** Finish an order the person approves in the PayPal window. */
  const approveInWindow = useCallback(
    async (line: number, url: string, win: Window | null) => {
      const w = win ?? window.open(url, "paypal", POPUP);
      if (win) win.location.href = url;
      set(line, { state: "waiting-paypal", rows: [{ text: "Waiting for your approval in the PayPal window…" }] });
      const { cancelled } = await waitForReturn(w, "order", line);
      if (cancelled) {
        const d = await post("/api/agent/decline", line);
        set(line, { state: "declined", rows: [{ text: "You cancelled in PayPal." }, ...d.log] });
        return "declined" as const;
      }
      const c = await post("/api/agent/complete", line);
      set(line, { state: c.state, rows: c.log });
      return c.state as "captured" | "authorized";
    },
    [post],
  );

  /**
   * Pay a line. Pass `win` (opened in the click handler) when the person just
   * approved, so the PayPal window isn't blocked as a pop-up.
   */
  const pay = useCallback(
    async (line: number, userApproved: boolean, win: Window | null = null): Promise<LiveState> => {
      set(line, { state: "working" });
      try {
        const r = await post("/api/agent/pay", line, { userApproved });
        set(line, { rows: r.log });
        if (r.decision === "block") return (set(line, { state: "blocked" }), "blocked");
        if (r.decision === "ask_user") {
          win?.close();
          return (set(line, { state: "idle" }), "idle");
        }
        if (r.decision === "paid") return (set(line, { state: r.state }), r.state);
        // PayPal needs the person: open the window now if we have one, else ask for a click.
        if (win) return await approveInWindow(line, r.approveUrl, win);
        set(line, { state: "needs-click", approveUrl: r.approveUrl });
        return "needs-click";
      } catch (e) {
        win?.close();
        set(line, { state: "error", error: e instanceof Error ? e.message : String(e) });
        return "error";
      }
    },
    [post, approveInWindow],
  );

  /** "Pay with PayPal" button for a payment PayPal needs a person to approve. */
  const payWithPayPal = useCallback(
    (line: number) => {
      const url = lines[line]?.approveUrl;
      if (!url) return;
      const win = window.open(url, "paypal", POPUP);
      approveInWindow(line, url, win).catch((e) => set(line, { state: "error", error: String(e) }));
    },
    [lines, approveInWindow],
  );

  const deliver = useCallback(
    async (line: number) => {
      set(line, { state: "working" });
      try {
        const d = await post("/api/agent/deliver", line);
        set(line, { state: d.state, rows: d.log });
      } catch (e) {
        set(line, { state: "error", error: e instanceof Error ? e.message : String(e) });
      }
    },
    [post],
  );

  const decline = useCallback(
    async (line: number) => {
      try {
        const d = await post("/api/agent/decline", line);
        set(line, { state: "declined", rows: d.log });
      } catch (e) {
        set(line, { state: "error", error: e instanceof Error ? e.message : String(e) });
      }
    },
    [post],
  );

  /** Connect a PayPal wallet once, so approved payments go through with no one present. */
  const connectWallet = useCallback(async () => {
    const win = window.open("", "paypal", POPUP);
    try {
      const res = await fetch("/api/vault/start", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (win) win.location.href = data.approveUrl;
      const { cancelled } = await waitForReturn(win, "wallet");
      if (cancelled) return;
      const fin = await fetch("/api/vault/finish", { method: "POST" });
      if (fin.ok) setStatus((s) => ({ ...s, wallet: true }));
    } catch {
      win?.close();
    }
  }, []);

  return { status, enabled: enabled && status.mode === "sandbox", setEnabled, lines, pay, payWithPayPal, deliver, decline, connectWallet };
}
