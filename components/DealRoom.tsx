"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { catalog, getItem, missions } from "../src/engine/index.ts";
import {
  buildMissionRun,
  buildSingleRun,
  buildSteps,
  defaultRules,
  deriveView,
  stepDelay,
  type Decision,
  type LineStatus,
  type Run,
  type Step,
} from "../lib/timeline.ts";
import { ASK_MAX, ASK_MIN, BUDGET_MAX, BUDGET_MIN, clampDraft, fmt, rulesFromQuery, rulesPreview, sameRules, type PlayerRules } from "../lib/rules.ts";
import { newNonce, useLivePayPal, type LiveState } from "./useLivePayPal.ts";
import { useVoices, type LineVoices } from "./useVoices.ts";
import { Arena, Caption, Gate } from "./Arena.tsx";

const SPEEDS = [0.5, 1, 1.5, 2, 4];

const STATUS_LABEL: Record<LineStatus, string> = {
  waiting: "Waiting",
  negotiating: "Negotiating",
  checking: "Checking with AgentGuard",
  "awaiting-approval": "Needs your OK",
  paying: "Waiting for PayPal",
  authorized: "Held until delivery",
  captured: "Paid",
  declined: "Declined",
  blocked: "Blocked",
  "no-deal": "Walked away",
  skipped: "Skipped",
  voided: "Hold released",
};

/** Dollars with thousands commas, as everywhere in the room. */
const money = fmt;

/** The same steps with each beat's text swapped for its line's live voice, when it has one. */
function voiceSteps(steps: Step[], applied: (LineVoices | null)[]): Step[] {
  if (!applied.some(Boolean)) return steps;
  const beatNo: Record<number, number> = {};
  return steps.map((s) => {
    if (s.type !== "beat") return s;
    const n = (beatNo[s.line] = (beatNo[s.line] ?? -1) + 1);
    const text = applied[s.line]?.[n];
    return text ? { ...s, beat: { ...s.beat, text } } : s;
  });
}
const NO_FROZEN: Record<number, LineVoices | null> = {};
/** Deal numbers the server accepts. */
const MAX_DEAL = 999_999_999;
const DEFAULT_SELECTION = "mission:hackathon-10-days";
const DEFAULT_DEAL = 42;

/** What a run is, from the "What to buy" choice. */
function runKind(selection: string, rogue: boolean): { kind: Run["kind"]; id: string } {
  if (rogue) return { kind: "rogue", id: "usb-mic" };
  const [kind, id] = selection.split(":");
  return { kind: kind === "mission" ? "mission" : "single", id };
}
const defaultsFor = (selection: string, rogue: boolean) => {
  const k = runKind(selection, rogue);
  return defaultRules(k.kind, k.id);
};
/** An empty field reads as "not set", so it falls back instead of becoming $0. */
const num = (s: string) => (s.trim() === "" ? NaN : Number(s));

/** A dollar field with − and + steppers. Arrow keys step too; Enter applies. */
function Stepper(props: {
  id: string;
  label: string;
  /** Shorter label for narrow screens, where "$" shows inside the field instead. */
  short: string;
  name: string;
  value: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: string) => void;
  onEnter: () => void;
}) {
  const { id, label, short, name, value, min, max, step, onChange, onEnter } = props;
  const now = num(value);
  const bump = (dir: 1 | -1) => {
    const base = Number.isFinite(now) ? now : min;
    // Snap to the step, so 147 goes to 150 or 140.
    const next = dir > 0 ? Math.floor(base / step) * step + step : Math.ceil(base / step) * step - step;
    onChange(String(Math.min(max, Math.max(min, next))));
  };
  const keepFocus = (e: React.MouseEvent) => {
    e.preventDefault();
    document.getElementById(id)?.focus();
  };
  return (
    <div className="field stepper-field">
      <label className="label" htmlFor={id}>
        <span className="label-long">{label}</span>
        <span className="label-short">{short}</span>
      </label>
      <div className="stepper">
        <button type="button" tabIndex={-1} aria-label={`Lower ${name} by $${step}`} onMouseDown={keepFocus} onClick={() => bump(-1)} disabled={Number.isFinite(now) && now <= min}>
          −
        </button>
        <span className="cur" aria-hidden="true">
          $
        </span>
        <input
          id={id}
          role="spinbutton"
          inputMode="decimal"
          autoComplete="off"
          value={value}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={Number.isFinite(now) ? now : undefined}
          aria-describedby="rules-preview"
          onChange={(e) => onChange(e.target.value.slice(0, 9))}
          onKeyDown={(e) => {
            if (e.key === "Enter") onEnter();
            else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              bump(e.key === "ArrowUp" ? 1 : -1);
            }
          }}
        />
        <button type="button" tabIndex={-1} aria-label={`Raise ${name} by $${step}`} onMouseDown={keepFocus} onClick={() => bump(1)} disabled={Number.isFinite(now) && now >= max}>
          +
        </button>
      </div>
    </div>
  );
}

function Receipt({ run, statuses }: { run: Run; statuses: LineStatus[] }) {
  let paid = 0;
  let saved = 0;
  const rows = run.lines.map((l, i) => {
    const o = l.deal.outcome;
    const item = getItem(l.itemId);
    const settled = statuses[i] === "captured";
    if (settled) {
      paid += o.amountToPay ?? 0;
      // Same basis as each row: the true cost, including certain later fees.
      saved += item.price.typical - (o.effectiveCost ?? o.amountToPay ?? 0);
    }
    return { l, o, i, settled };
  });
  return (
    <div className="receipt">
      <div className="receipt-head">
        <span className="label">{run.kind === "mission" ? "Mission receipt" : "Receipt"}</span>
        <b>
          Paid {money(paid)} of {money(run.budgetUsd)} · {paid > 0 ? `saved ${money(Math.max(0, saved))} against typical prices` : "nothing spent"}
        </b>
      </div>
      <div className="tbl">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Seller</th>
              <th>Paid</th>
              <th>vs typical</th>
              <th>Extras won</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ l, o, i, settled }) => (
              <tr key={i}>
                <td>{l.itemName}</td>
                <td>{o.sellerName ?? "—"}</td>
                <td className="num">{settled ? money(o.amountToPay ?? 0) : "—"}</td>
                <td className="num">{settled && o.savedVsTypical !== undefined ? `${o.savedVsTypical > 0 ? "−" : "+"}${Math.abs(o.savedVsTypical)}%` : "—"}</td>
                <td>{settled && o.levers.length ? o.levers.map((x) => x.label).join(", ") : "—"}</td>
                <td>
                  <span className={`pill ${statuses[i]}`}>{STATUS_LABEL[statuses[i]]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function DealRoom() {
  const [selection, setSelection] = useState(DEFAULT_SELECTION);
  const [seed, setSeed] = useState(DEFAULT_DEAL);
  /** Your budget and approval limit, or null for the run's own. */
  const [rules, setRules] = useState<PlayerRules | null>(null);
  const [budgetDraft, setBudgetDraft] = useState(String(defaultsFor(DEFAULT_SELECTION, false).budgetUsd));
  const [askDraft, setAskDraft] = useState(String(defaultsFor(DEFAULT_SELECTION, false).askAboveUsd));
  const [rulesNote, setRulesNote] = useState<string | null>(null);
  /** True once a shared link has been read, so the address isn't rewritten before then. */
  const [linkRead, setLinkRead] = useState(false);
  const [rogue, setRogue] = useState(false);
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const approveRef = useRef<HTMLButtonElement>(null);
  const [showDetails, setShowDetails] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const [seedDraft, setSeedDraft] = useState("42");
  /** A fresh id for every Play, so real PayPal ids never repeat across visitors or replays. */
  const [nonce, setNonce] = useState("startrun00");
  // Random per visitor from the first Play; generated in the browser so server and client render the same.
  useEffect(() => setNonce(newNonce()), []);

  const defaults = useMemo(() => defaultsFor(selection, rogue), [selection, rogue]);
  const applied = rules ?? defaults;
  const run = useMemo(() => {
    const custom = rules ?? undefined;
    if (rogue) return buildSingleRun("usb-mic", seed, true, custom);
    const [kind, id] = selection.split(":");
    return kind === "mission" ? buildMissionRun(id, seed, custom) : buildSingleRun(id, seed, false, custom);
  }, [selection, seed, rogue, rules]);

  // A shared link sets the deal, what to buy and your rules: ?deal=42&budget=150&ask=60.
  // Anything that doesn't read cleanly falls back to the defaults.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const buy = q.get("buy");
    const sel =
      buy && (buy.startsWith("mission:") ? missions.some((m) => `mission:${m.id}` === buy) : buy.startsWith("item:") && catalog.items.some((i) => `item:${i.id}` === buy)) ? buy : DEFAULT_SELECTION;
    const isRogue = buy === "rogue";
    const deal = q.get("deal");
    const n = deal && /^\d{1,9}$/.test(deal) ? Number(deal) : NaN;
    const r = rulesFromQuery(q.get("budget"), q.get("ask"));
    setSelection(sel);
    setRogue(isRogue);
    if (n >= 1 && n <= MAX_DEAL) {
      setSeed(n);
      setSeedDraft(String(n));
    }
    setRules(r && !sameRules(r, defaultsFor(sel, isRogue)) ? r : null);
    setLinkRead(true);
  }, []);

  // Keep the address in step with the deal on screen, so it can be shared as is.
  useEffect(() => {
    if (!linkRead) return;
    const q = new URLSearchParams();
    if (rogue) q.set("buy", "rogue");
    else if (selection !== DEFAULT_SELECTION) q.set("buy", selection);
    if (q.toString() || rules || seed !== DEFAULT_DEAL) q.set("deal", String(seed));
    if (rules) {
      q.set("budget", String(rules.budgetUsd));
      q.set("ask", String(rules.askAboveUsd));
    }
    const url = `${window.location.pathname}${q.toString() ? `?${q}` : ""}${window.location.hash}`;
    if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(window.history.state, "", url);
  }, [linkRead, selection, seed, rogue, rules]);

  // The fields always show the rules in force, until you start typing.
  useEffect(() => {
    setBudgetDraft(String(applied.budgetUsd));
    setAskDraft(String(applied.askAboveUsd));
  }, [applied.budgetUsd, applied.askAboveUsd]);

  const { steps: baseSteps, waitingFor } = useMemo(() => buildSteps(run, decisions), [run, decisions]);

  // Live AI voices reword the chat; the engine's steps above still decide every price,
  // AgentGuard check and payment. A line keeps the words it started with, so text on
  // screen never changes mid-read; voices that arrive later apply from the next line.
  const voiceId = rogue ? "usb-mic" : selection.split(":")[1];
  const voiceRef = useMemo(() => ({ kind: run.kind, id: voiceId, seed, ...(rules ? { rules } : {}) }), [run.kind, voiceId, seed, rules]);
  const ai = useVoices(voiceRef, run.lines.length, playing);
  const [showOriginal, setShowOriginal] = useState(false);
  const started = cursor > 0 && baseSteps.length ? baseSteps[Math.min(cursor, baseSteps.length) - 1].line : -1;
  const playKey = `${run.kind}:${voiceId}:${seed}:${nonce}${rules ? `:r${rules.budgetUsd}-${rules.askAboveUsd}` : ""}`;
  // The words each started line plays with, for this Play. Until the effect below records
  // a line, it shows its current voices, which are exactly what the effect then records.
  const [frozen, setFrozen] = useState<{ key: string; lines: Record<number, LineVoices | null> }>({ key: "", lines: {} });
  const frozenLines = frozen.key === playKey ? frozen.lines : NO_FROZEN;
  useEffect(() => {
    setFrozen((prev) => {
      const lines = { ...(prev.key === playKey ? prev.lines : {}) };
      let changed = prev.key !== playKey;
      for (let i = 0; i <= started; i++) {
        if (i in lines) continue;
        lines[i] = ai.voices[i] ?? null;
        changed = true;
      }
      return changed ? { key: playKey, lines } : prev;
    });
  }, [started, playKey, ai.voices]);
  const steps = useMemo(() => {
    const applied = run.lines.map((_, i) => (showOriginal ? null : i <= started && i in frozenLines ? frozenLines[i] : ai.voices[i] ?? null));
    return voiceSteps(baseSteps, applied);
  }, [run, baseSteps, showOriginal, started, frozenLines, ai.voices]);
  const voicedLine = (i: number) => !showOriginal && Boolean(i <= started && i in frozenLines ? frozenLines[i] : ai.voices[i]);
  const hasVoices = Object.keys(ai.voices).length > 0;
  const baseView = useMemo(() => deriveView(run, steps, cursor), [run, steps, cursor]);
  const finished = cursor >= steps.length && waitingFor === null;
  const awaiting = cursor >= steps.length && waitingFor !== null;

  // Real PayPal sandbox: the server pays; playback waits at each money step until it has.
  const runRef = useMemo(
    () => ({ kind: run.kind, id: rogue ? "usb-mic" : selection.split(":")[1], seed, nonce, ...(rules ? { rules } : {}) }),
    [run.kind, rogue, selection, seed, nonce, rules],
  );
  const live = useLivePayPal(runRef);
  const pendingWin = useRef<Window | null>(null);

  /** A step that must wait for a real PayPal call: paying the line, or settling its hold. */
  const gateAt = (i: number): { line: number; action: "pay" | "deliver"; ready: boolean } | null => {
    if (!live.enabled || i >= steps.length) return null;
    const next = steps[i];
    if (next.type !== "paypal") return null;
    const state: LiveState = live.lines[next.line]?.state ?? "idle";
    const first = steps.findIndex((s) => s.type === "paypal" && s.line === next.line);
    if (i === first) return { line: next.line, action: "pay", ready: ["captured", "authorized", "voided", "blocked", "declined"].includes(state) };
    const held = getItem(run.lines[next.line].itemId).paypalFlow !== "capture_now";
    if (held && (next.effect === "captured" || next.effect === "voided")) {
      return { line: next.line, action: "deliver", ready: ["captured", "voided", "declined", "blocked"].includes(state) };
    }
    return null;
  };
  const gate = gateAt(cursor);

  useEffect(() => {
    if (!playing || !gate || gate.ready) return;
    const state = live.lines[gate.line]?.state ?? "idle";
    if (gate.action === "deliver") {
      if (state === "authorized" && !live.lines[gate.line]?.review) live.deliver(gate.line);
      return;
    }
    if (state !== "idle") return; // working, waiting for you, or failed
    if (gate.action === "pay") {
      const win = pendingWin.current;
      pendingWin.current = null;
      live.pay(gate.line, decisions[gate.line] === "approved", win);
    } else {
      live.deliver(gate.line);
    }
  }, [playing, gate?.line, gate?.action, gate?.ready, live.lines]); // eslint-disable-line react-hooks/exhaustive-deps

  // Latency: start the PayPal call as soon as AgentGuard has approved, while the
  // check is still on screen, so the order is usually ready when playback gets there.
  // Same calls, same order of events; only earlier.
  useEffect(() => {
    if (!live.enabled || !playing || cursor === 0) return;
    const shown = steps[cursor - 1];
    if (!shown) return;
    const idle = (l: number) => (live.lines[l]?.state ?? "idle") === "idle";
    // Approved: pay now. Blocked: let the server's AgentGuard refuse too, so its verdict is on screen.
    if (shown.type === "guard" && shown.guard.decision !== "ask_user" && idle(shown.line)) live.pay(shown.line, false);
    if (shown.type === "event" && live.lines[shown.line]?.state === "authorized" && !live.lines[shown.line]?.review) live.deliver(shown.line);
  }, [cursor, playing, live.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // When PayPal needs a click, bring the button into view (it can be far down on a phone).
  const needsClick = live.lines[baseView.line]?.state === "needs-click";
  useEffect(() => {
    if (!needsClick) return;
    const b = document.getElementById("pay-with-paypal");
    b?.scrollIntoView({ block: "center", behavior: "smooth" });
    b?.focus({ preventScroll: true });
  }, [needsClick]);

  // If you cancel in the PayPal window, the deal room records a decline.
  useEffect(() => {
    for (const [k, l] of Object.entries(live.lines)) {
      const i = Number(k);
      if (!run.lines[i]) continue;
      if (l.state === "declined" && decisions[i] === "approved") setDecisions((prev) => ({ ...prev, [i]: "declined" }));
    }
  }, [live.lines, decisions]);

  // Keyed on the engine's steps, not the voiced ones: voices arriving must not restart the timer.
  useEffect(() => {
    if (!playing || cursor >= steps.length || (gate && !gate.ready)) return;
    const last = steps[cursor - 1];
    const t = setTimeout(() => setCursor((c) => c + 1), last ? stepDelay(last, steps[cursor]) / speed : 300);
    return () => clearTimeout(t);
  }, [playing, cursor, baseSteps, speed, gate?.ready]); // eslint-disable-line react-hooks/exhaustive-deps

  /** In real mode, show what PayPal actually did instead of the simulated steps. */
  const view = useMemo(() => {
    if (!live.enabled) return baseView;
    const statuses = [...baseView.statuses];
    const amounts = [...baseView.amounts];
    const map: Partial<Record<LiveState, LineStatus>> = {
      captured: "captured",
      authorized: "authorized",
      voided: "voided",
      declined: "declined",
      blocked: "blocked",
      "waiting-paypal": "paying",
      "needs-click": "paying",
      "needs-decision": "awaiting-approval",
    };
    for (const [k, l] of Object.entries(live.lines)) {
      const i = Number(k);
      // Under PayPal review: money is set aside but not paid yet.
      const st = l.review && (l.state === "captured" || l.state === "authorized") ? "paying" : map[l.state];
      if (!run.lines[i]) continue;
      if (!st) continue;
      statuses[i] = st;
      amounts[i] = st === "captured" || st === "authorized" || st === "awaiting-approval" || st === "paying" ? run.lines[i].deal.outcome.amountToPay ?? null : null;
    }
    let committedUsd = 0;
    let capturedUsd = 0;
    let pendingUsd = 0;
    statuses.forEach((st, i) => {
      if (st === "captured" || st === "authorized") committedUsd += amounts[i] ?? 0;
      if (st === "captured") capturedUsd += amounts[i] ?? 0;
      if (st === "awaiting-approval" || st === "paying") pendingUsd += amounts[i] ?? 0;
    });
    const rows = live.lines[baseView.line]?.rows ?? [];
    const checkout = [
      ...baseView.checkout.filter((r) => r.source !== "paypal"),
      ...rows.map((r) => ({ text: r.text, detail: [r.detail, r.debugId ? `PayPal debug id ${r.debugId}` : ""].filter(Boolean).join(" · ") || undefined, tone: r.tone ?? ("ok" as const), source: "paypal" as const })),
    ];
    return { ...baseView, statuses, amounts, committedUsd, capturedUsd, pendingUsd, checkout };
  }, [baseView, live.enabled, live.lines, run]);

  useEffect(() => {
    if (awaiting) {
      lastFocus.current = document.activeElement as HTMLElement | null;
      approveRef.current?.focus();
    } else {
      lastFocus.current?.focus?.();
      lastFocus.current = null;
    }
  }, [awaiting]);

  // Keep keyboard focus inside the approval sheet; Escape declines.
  const onSheetKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      decide("declined");
      return;
    }
    if (e.key !== "Tab") return;
    const items = sheetRef.current?.querySelectorAll<HTMLElement>("button");
    if (!items || !items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const applySeed = () => {
    const n = Math.floor(Number(seedDraft));
    if (Number.isFinite(n) && n >= 1 && n <= MAX_DEAL && n !== seed) restart({ seed: n, rogue });
    else setSeedDraft(String(seed));
  };

  /** The rules the fields ask for, made valid, with a note when something had to change. */
  const draftRules = (fallback: PlayerRules) => clampDraft(budgetDraft, askDraft, fallback);
  const rulesChanged = () => !sameRules(draftRules(applied).rules, applied);

  /**
   * Starts the run again with a new nonce. Rules typed but not applied yet are
   * applied now; `resetRules` goes back to the run's own budget and approval limit.
   */
  const restart = (next: { selection?: string; seed?: number; rogue?: boolean; resetRules?: boolean }) => {
    const sel = next.selection ?? selection;
    const isRogue = next.rogue ?? false;
    const target = defaultsFor(sel, isRogue);
    let chosen: PlayerRules | null = null;
    if (next.resetRules) setRulesNote(null);
    else {
      const c = draftRules(applied);
      setRulesNote(c.note);
      chosen = sameRules(c.rules, target) ? null : c.rules;
    }
    const shown = chosen ?? target;
    setRules(chosen);
    setBudgetDraft(String(shown.budgetUsd));
    setAskDraft(String(shown.askAboveUsd));
    if (next.selection !== undefined) setSelection(next.selection);
    if (next.seed !== undefined) {
      setSeed(next.seed);
      setSeedDraft(String(next.seed));
    }
    setRogue(isRogue);
    setNonce(newNonce());
    setDecisions({});
    setCursor(0);
    setPlaying(true);
  };

  /** Enter, or focus leaving the rules: apply them if they changed, and say so if they had to be adjusted. */
  const applyRules = () => {
    const c = draftRules(applied);
    if (!sameRules(c.rules, applied)) return restart({ seed, rogue });
    setRulesNote(c.note);
    setBudgetDraft(String(applied.budgetUsd));
    setAskDraft(String(applied.askAboveUsd));
  };
  const resetRules = () => {
    if (rules) return restart({ seed, rogue, resetRules: true });
    setRulesNote(null);
    setBudgetDraft(String(defaults.budgetUsd));
    setAskDraft(String(defaults.askAboveUsd));
  };
  const previewRules = draftRules(applied).rules;
  const k = runKind(selection, rogue);
  const preview = useMemo(() => rulesPreview(k.kind, k.id, previewRules), [k.kind, k.id, previewRules.budgetUsd, previewRules.askAboveUsd]); // eslint-disable-line react-hooks/exhaustive-deps

  const decide = (d: Decision) => {
    if (waitingFor === null) return;
    if (live.enabled) {
      // Open the PayPal window inside the click, so the browser doesn't block it.
      if (d === "approved") pendingWin.current = window.open("", "paypal", "width=480,height=720");
      else live.decline(waitingFor);
    }
    setDecisions((prev) => ({ ...prev, [waitingFor]: d }));
    setPlaying(true);
  };

  /** Skip stops at the next real PayPal step that still has to happen. */
  const skip = () => {
    let i = cursor;
    while (i < steps.length && !(gateAt(i) && !gateAt(i)!.ready)) i++;
    setCursor(i);
    setPlaying(true);
  };

  const line = run.lines[view.line];
  const item = line ? getItem(line.itemId) : null;
  const pct = (n: number) => Math.min(100, (n / run.budgetUsd) * 100);
  const capturedShare = pct(view.capturedUsd);
  const heldShare = Math.min(100 - capturedShare, pct(view.committedUsd - view.capturedUsd));
  const pendingShare = Math.min(100 - capturedShare - heldShare, pct(view.pendingUsd));
  const askLine = pct(run.askAboveUsd);
  const asking = awaiting ? run.lines[waitingFor!] : null;
  const askItem = asking ? getItem(asking.itemId) : null;
  const askGuard = awaiting ? view.guard : null;

  // The arena's numbers for the current line.
  const deal = line?.deal;
  const span = deal ? Math.max(...deal.sellers.map((s) => s.openAsk)) - deal.plan.anchor : 1;
  // Before the first step, seat the sellers at their opening asks so the arena never starts empty.
  const booths = view.booths.length
    ? view.booths
    : (deal?.sellers ?? []).map((s) => ({ id: s.id, name: s.name, archetype: s.archetype, price: s.openAsk, state: "open" as const, offer: null, fee: null, feeNow: false, offerAllIn: null, lastSeq: 0, offerSeq: 0, askSeq: 0, messages: [] }));
  const floors = booths.map((b) => (view.revealFloors ? deal?.sellers.find((s) => s.id === b.id)?.floor ?? null : null));
  const lineStatus = view.statuses[view.line];
  const arenaState =
    lineStatus === "blocked"
      ? "blocked"
      : lineStatus === "no-deal" || lineStatus === "skipped"
        ? "walked"
        : lineStatus === "declined"
          ? "declined"
          : lineStatus === "voided"
            ? "released"
        : view.dealPrice !== null || view.booths.some((b) => b.state === "won")
          ? "deal"
          : view.transcript.length
            ? "talking"
            : "idle";
  // AgentGuard's checks sit in the gate; everything PayPal did sits in the Payment panel.
  const gateRows = view.checkout.filter((r) => r.source === "guard");
  const payRows = view.checkout.filter((r) => r.source !== "guard");
  const blocked = view.guard?.decision === "block";
  const pipe = blocked ? "cut" : awaiting || lineStatus === "awaiting-approval" || lineStatus === "paying" ? "hold" : payRows.length ? "flow" : "idle";

  return (
    <>
    <main className="wrap" inert={awaiting || undefined}>
      <header className="top">
        <div className="brand">
          <h1>
            Infinity Bazaar<span className="inf">∞</span>
            <span className="about">
              <button type="button" className="info" aria-label="What is Infinity Bazaar?" aria-describedby="about-tip">
                i
              </button>
              <span role="tooltip" id="about-tip" className="tip">
                An AI agent haggles with AI sellers for everything on your list, then pays through PayPal, but only when your rules say yes.
              </span>
            </span>
          </h1>
          <span className="eyebrow">Your AI haggles. Your rules guard the money.</span>
        </div>
        <div className="controls">
          <div className="setup">
          <label className="field">
            <span className="label">What to buy</span>
            <select id="selection" value={rogue ? "" : selection} onChange={(e) => restart({ selection: e.target.value, seed, resetRules: true })}>
              {rogue && <option value="">Stress test: agent goes rogue</option>}
              <optgroup label="Missions">
                {missions.map((m) => (
                  <option key={m.id} value={`mission:${m.id}`}>
                    {m.title} ({money(rules && !rogue && selection === `mission:${m.id}` ? rules.budgetUsd : m.budgetUsd)})
                  </option>
                ))}
              </optgroup>
              {catalog.groups.map((g) => (
                <optgroup key={g.id} label={g.name}>
                  {catalog.items
                    .filter((i) => i.group === g.id)
                    .map((i) => (
                      <option key={i.id} value={`item:${i.id}`}>
                        {i.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="field table-no" title="Same number, same deal: sellers, prices and surprises.">
            <span className="label">Deal #</span>
            <input
              id="seed"
              inputMode="numeric"
              value={seedDraft}
              onChange={(e) => setSeedDraft(e.target.value.replace(/[^0-9]/g, ""))}
              onBlur={applySeed}
              onKeyDown={(e) => e.key === "Enter" && applySeed()}
              aria-describedby="seed-help"
            />
            <span id="seed-help" className="sr-only">Same number, same deal: sellers, prices and surprises. Press Enter to play it.</span>
          </label>
          <fieldset
            className="rules"
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) applyRules();
            }}
          >
            <legend className="sr-only">Your rules</legend>
            <div className="rules-row">
              <Stepper id="budget" label="Budget ($)" short="Budget" name="budget" value={budgetDraft} min={BUDGET_MIN} max={BUDGET_MAX} step={10} onChange={(v) => { setBudgetDraft(v); setRulesNote(null); }} onEnter={applyRules} />
              <Stepper id="ask" label="Ask me above ($)" short="Ask above" name="approval limit" value={askDraft} min={ASK_MIN} max={ASK_MAX} step={5} onChange={(v) => { setAskDraft(v); setRulesNote(null); }} onEnter={applyRules} />
              <button type="button" className="link" onClick={resetRules} disabled={!rules && !rulesChanged() && !rulesNote}>
                Reset
              </button>
            </div>
            <p id="rules-preview" className="rules-preview" aria-live="polite">
              <span className="rules-title" aria-hidden="true">
                Your rules
              </span>{" "}
              {rulesNote ? <span className="rules-note">{rulesNote}.</span> : preview}
            </p>
          </fieldset>
          </div>
          <div className="btns">
            <button
              className="primary"
              disabled={awaiting}
              onClick={() => (finished || rulesChanged() ? restart({ seed, rogue }) : setPlaying((p) => !p))}
              aria-label={finished ? "Replay" : playing ? "Pause" : "Play"}
            >
              {finished ? "↺ Replay" : gate && !gate.ready && playing ? "Waiting for PayPal…" : playing ? "❚❚ Pause" : "▶ Play"}
            </button>
            <button onClick={() => restart({ seed: 1 + Math.floor(Math.random() * 999999), rogue })} title="Deal a new number: new sellers, new prices, new surprises">
              🎲 New deal
            </button>
            <button onClick={skip} disabled={cursor >= steps.length || Boolean(gate && !gate.ready)} aria-label="Skip to the next decision or the end">
              ⏭ Skip
            </button>
            <button className="danger" onClick={() => restart({ seed, rogue: true })} title="Watch a pushy seller talk the agent into a bad deal — and AgentGuard stop it.">
              Agent goes rogue
            </button>
          </div>
          <label className="field speed">
            <span className="label">Speed</span>
            <select id="speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </label>
          {ai.enabled && (
            <label className="switch voice-toggle" title="Show the original lines instead of the live AI voices">
              <input type="checkbox" checked={showOriginal} disabled={!hasVoices} onChange={(e) => setShowOriginal(e.target.checked)} />
              Show original lines
            </label>
          )}
          {live.status.mode === "sandbox" && (
            <div className="paypal-mode">
              <label className="switch" title="Pay with real PayPal sandbox accounts instead of demo payments">
                <input
                  type="checkbox"
                  checked={live.enabled}
                  onChange={(e) => {
                    live.setEnabled(e.target.checked);
                    restart({ seed, rogue });
                  }}
                />
                PayPal sandbox (test money)
              </label>
              {live.walletError && <span className="note">{live.walletError}</span>}
              {live.enabled &&
                (live.status.wallet ? (
                  <span className="pill captured">Wallet connected</span>
                ) : (
                  <button onClick={live.connectWallet} title="Approve once in PayPal so the agent can pay approved items by itself">
                    Connect PayPal wallet
                  </button>
                ))}
            </div>
          )}
        </div>
      </header>

      <section className="room" aria-label="Deal room">
        <div className="mission">
          <div className="goal-box">
            <span className="label">{run.kind === "mission" ? "Mission" : run.kind === "rogue" ? "Stress test" : "Single deal"}</span>
            <p className="goal">“{run.goal}”</p>
            <span className="note">Deal #{run.seed} always replays the same deal.</span>
          </div>
          <div className="budget">
            <span className="label">Budget</span>
            <div className="bbar">
              <span className="sr-only">Spent {money(view.committedUsd)} of {money(run.budgetUsd)}</span>
              <div className="bfill" style={{ transform: `scaleX(${capturedShare / 100})` }} />
              <div className="bheld" style={{ transform: `translateX(${capturedShare}%) scaleX(${heldShare / 100})` }} />
              <div className="bpending" style={{ transform: `translateX(${capturedShare + heldShare}%) scaleX(${pendingShare / 100})` }} />
              <div className="bask" style={{ left: `${askLine}%` }} title={`Approval needed above ${money(run.askAboveUsd)}`} />
            </div>
            <div className="bnums">
              <span>
                <i className="dot paid" /> Paid {money(view.capturedUsd)}
              </span>
              <span>
                <i className="dot held" /> Held {money(view.committedUsd - view.capturedUsd)}
              </span>
              {view.pendingUsd > 0 && (
                <span>
                  <i className="dot pending" /> Waiting {money(view.pendingUsd)}
                </span>
              )}
              <span>Budget {money(run.budgetUsd)}</span>
            </div>
          </div>
        </div>

        <div className="list">
          <span className="label">Shopping list · the agent haggles for each, in order</span>
          <div className="rows">
            {run.lines.map((l, i) => (
              <div key={l.itemId + i} className={`row${i === view.line && !finished ? " current" : ""}`}>
                <span className="row-name">{l.itemName}</span>
                <span className={`pill ${view.statuses[i]}`}>{STATUS_LABEL[view.statuses[i]]}</span>
                <b>{view.amounts[i] !== null ? money(view.amounts[i]!) : "—"}</b>
              </div>
            ))}
          </div>
        </div>

        {item && view.plan && (
          <div className="pricecard">
            <div className="pc">
              <span className="label">Lowest online</span>
              <b>${item.price.low}</b>
            </div>
            <div className="pc">
              <span className="label">Typical</span>
              <b>${item.price.typical}</b>
            </div>
            <div className="pc">
              <span className="label">Highest online</span>
              <b>${item.price.high}</b>
            </div>
            <div className="pc target">
              <span className="label">Target</span>
              <b>${view.plan.target}</b>
            </div>
            <div className="pc walk">
              <span className="label">Walk-away</span>
              <b>${view.plan.walkAway}</b>
            </div>
            <div className="pc limit" title="The most AgentGuard lets the agent pay for this item">
              <span className="label">Your limit</span>
              <b>{line.rules.itemCapUsd !== undefined ? money(line.rules.itemCapUsd) : money(run.budgetUsd)}</b>
              <span className="pc-sub">of {money(run.budgetUsd)} budget</span>
            </div>
            <div className="ladder" aria-label="Agent's planned offers">
              <span className="label">{item.name} · planned offers</span>
              <div className="rungs">
                {view.plan.offers.map((o, i) => (
                  <span key={o} className={`rung${view.dealPrice === null && i === view.offerIndex ? " now" : i <= view.offerIndex ? " used" : ""}`}>
                    ${o}
                  </span>
                ))}
                {view.dealPrice !== null && <span className="rung deal">Deal ${view.dealPrice}</span>}
              </div>
            </div>
          </div>
        )}

        <div className="stage">
          <Arena
            booths={booths}
            lineKey={`${run.kind}:${run.seed}:${run.title}:${view.line}`}
            span={span}
            floors={floors}
            agentOffer={view.agentOffer}
            dealPrice={view.dealPrice ?? (arenaState === "deal" || arenaState === "blocked" ? deal?.outcome.amountToPay ?? null : null)}
            dealSellerId={view.dealSellerId}
            target={view.plan?.target ?? null}
            walkAway={view.plan?.walkAway ?? null}
            state={arenaState}
          />
          <Caption lines={view.commentary} event={view.event} badge={voicedLine(view.line) ? "Live AI voices · Claude" : null} />
        </div>

        <div className={`pipeline ${pipe}`}>
          <Gate
            guard={view.guard}
            rows={gateRows}
            blockedAmount={blocked ? deal?.outcome.amountToPay ?? null : null}
            blockedSeller={blocked ? deal?.outcome.sellerName ?? null : null}
          />
          <div className="pipe" aria-hidden="true">
            <span>{pipe === "cut" ? "✕" : pipe === "hold" ? "❚❚" : "→"}</span>
          </div>
          <section className="paypal" aria-labelledby="paypal-title">
            <h2 id="paypal-title" className="label">
              Payment
            </h2>
            <div className="checkout">
              {payRows.length === 0 && (
                <div className={blocked ? "row-bad" : "row-info"}>{blocked ? "No payment was made. Nothing was sent to PayPal." : "Nothing sent to PayPal yet."}</div>
              )}
              {payRows.map((r, i) => (
                <div key={i} className={`row-${r.tone}`}>
                  {r.text}
                  {showDetails && r.detail && <div className="row-detail">{r.detail}</div>}
                </div>
              ))}
            </div>
            <label className="switch details-toggle">
              <input type="checkbox" checked={showDetails} onChange={(e) => setShowDetails(e.target.checked)} />
              Show PayPal details
            </label>
            {live.enabled && live.lines[view.line]?.state === "needs-click" && (
              <button id="pay-with-paypal" className="primary" onClick={() => live.payWithPayPal(view.line)}>
                Pay with PayPal
              </button>
            )}
            {live.enabled && live.lines[view.line]?.state === "needs-decision" && (
              <div className="row-ask">
                AgentGuard on the server wants your OK for this payment.{" "}
                <button className="primary" onClick={() => live.pay(view.line, true, window.open("", "paypal", "width=480,height=720"))}>
                  Approve
                </button>{" "}
                <button onClick={() => live.decline(view.line)}>Decline</button>
              </div>
            )}
            {live.enabled && live.lines[view.line]?.state === "error" && (
              <div className="row-bad">
                {live.lines[view.line]?.errorFrom === "paypal"
                  ? "PayPal didn't respond as expected. Retry checks with PayPal first, so nothing is charged twice."
                  : "Something went wrong with this payment. Nothing new was charged. Press Retry, or start a new deal."}{" "}
                {showDetails && <span className="row-detail">{live.lines[view.line]?.error}</span>}{" "}
                <button onClick={() => live.retry(view.line)}>Retry</button>
              </div>
            )}
            <span className="note">
              {live.enabled
                ? live.status.wallet
                  ? "Live PayPal sandbox payments. Approved items are paid from your connected wallet."
                  : "Live PayPal sandbox payments. Connect your wallet so the agent can pay approved items by itself, or approve each one in PayPal."
                : "Demo mode: payments are simulated."}
            </span>
          </section>
        </div>

        {finished && <Receipt run={run} statuses={view.statuses} />}
      </section>
      <p className="sr-only" aria-live="polite">
        {run.lines.map((l, i) => `${l.itemName}: ${STATUS_LABEL[view.statuses[i]]}.`).join(" ")}
      </p>
    </main>

      {asking && askItem && (
        <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" ref={sheetRef} onKeyDown={onSheetKey}>
          <div className="sheet-card">
            <span className="label">AgentGuard needs your OK</span>
            <h2 id="sheet-title">
              Pay {money(asking.deal.outcome.amountToPay ?? 0)} to {asking.deal.outcome.sellerName}?
            </h2>
            <dl className="breakdown">
              <dt>Item</dt>
              <dd>{asking.itemName}</dd>
              <dt>Price</dt>
              <dd>{money(asking.deal.outcome.price ?? 0)}</dd>
              {asking.deal.outcome.fee > 0 && (
                <>
                  <dt>Fee charged now</dt>
                  <dd>{money(asking.deal.outcome.fee)}</dd>
                </>
              )}
              {asking.deal.outcome.futureFee > 0 && (
                <>
                  <dt>Later cost</dt>
                  <dd>{money(asking.deal.outcome.futureFee)} (not charged now)</dd>
                </>
              )}
              <dt>How PayPal pays</dt>
              <dd>{askItem.paypalFlow === "capture_now" ? "Charged now (digital delivery)" : "Held now, charged when delivered"}</dd>
              <dt>Why you're asked</dt>
              <dd>{askGuard?.summary.replace(/^Needs your OK because /, "").replace(/\.$/, "") ?? ""}</dd>
            </dl>
            <div className="btns">
              <button ref={approveRef} className="primary" onClick={() => decide("approved")}>
                {live.enabled ? "Approve in PayPal" : "Approve"}
              </button>
              <button onClick={() => decide("declined")}>Decline</button>
            </div>
            <span className="note">Esc declines.</span>
          </div>
        </div>
      )}
    </>
  );
}
