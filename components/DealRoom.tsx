"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { catalog, getItem, missions, sellerData } from "../src/engine/index.ts";
import {
  buildMissionRun,
  buildSingleRun,
  buildSteps,
  deriveView,
  stepDelay,
  type BoothView,
  type Decision,
  type LineStatus,
  type Run,
} from "../lib/timeline.ts";
import { useLivePayPal, type LiveState } from "./useLivePayPal.ts";

const SPEEDS = [0.5, 1, 2, 4];
const FACE_COLORS = ["var(--brass)", "var(--teal)", "var(--rose)"];

const STATUS_LABEL: Record<LineStatus, string> = {
  waiting: "Waiting",
  negotiating: "Negotiating",
  checking: "AgentGuard check",
  "awaiting-approval": "Needs your OK",
  authorized: "Held until delivery",
  captured: "Paid",
  declined: "Declined",
  blocked: "Blocked",
  "no-deal": "Walked away",
  voided: "Hold voided",
};

const archetypeLabel = (id: string) => sellerData.archetypes.find((a) => a.id === id)?.label ?? id;
const money = (n: number) => `$${n.toFixed(2)}`;

function Booth({ booth, color, floor }: { booth: BoothView; color: string; floor: number | null }) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [booth.messages.length]);

  return (
    <div className={`booth ${booth.state}`}>
      <div className="bhead">
        <div className="face" style={{ background: color }} aria-hidden="true">
          {booth.name[0]}
        </div>
        <div className="bname">
          <h3>{booth.name}</h3>
          <span>{archetypeLabel(booth.archetype)}</span>
        </div>
        <div className="bprice">
          <span className="sr-only">{booth.name} asks </span>${booth.price}
        </div>
      </div>
      {booth.state === "blocked" && <div className="stamp">Blocked by AgentGuard</div>}
      <div className="log" ref={logRef}>
        {booth.messages.map((m, k) => (
          <div key={k} className={`msg ${m.from}`}>
            <span className="who">{m.from === "agent" ? "Your agent" : booth.name}</span>
            {m.text && <div className="b">{m.text}</div>}
            {m.tag && <span className={`tag ${m.tagKind}`}>{m.tag}</span>}
          </div>
        ))}
      </div>
      {floor !== null && <div className="floor">Hidden floor was ${floor}</div>}
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
          Paid {money(paid)} of {money(run.budgetUsd)} · saved {money(Math.max(0, saved))} against typical prices
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
  const [selection, setSelection] = useState("mission:hackathon-10-days");
  const [seed, setSeed] = useState(42);
  const [rogue, setRogue] = useState(false);
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const approveRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const [seedDraft, setSeedDraft] = useState("42");

  const run = useMemo(() => {
    if (rogue) return buildSingleRun("usb-mic", seed, true);
    const [kind, id] = selection.split(":");
    return kind === "mission" ? buildMissionRun(id, seed) : buildSingleRun(id, seed);
  }, [selection, seed, rogue]);

  const { steps, waitingFor } = useMemo(() => buildSteps(run, decisions), [run, decisions]);
  const baseView = useMemo(() => deriveView(run, steps, cursor), [run, steps, cursor]);
  const finished = cursor >= steps.length && waitingFor === null;
  const awaiting = cursor >= steps.length && waitingFor !== null;

  // Real PayPal sandbox: the server pays; playback waits at each money step until it has.
  const runRef = useMemo(
    () => ({ kind: run.kind, id: rogue ? "usb-mic" : selection.split(":")[1], seed }),
    [run.kind, rogue, selection, seed],
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
    if ((live.lines[gate.line]?.state ?? "idle") !== "idle") return; // working, waiting for you, or failed
    if (gate.action === "pay") {
      const win = pendingWin.current;
      pendingWin.current = null;
      live.pay(gate.line, decisions[gate.line] === "approved", win);
    } else {
      live.deliver(gate.line);
    }
  }, [playing, gate?.line, gate?.action, gate?.ready, live.lines]); // eslint-disable-line react-hooks/exhaustive-deps

  // If you cancel in the PayPal window, the deal room records a decline.
  useEffect(() => {
    for (const [k, l] of Object.entries(live.lines)) {
      const i = Number(k);
      if (l.state === "declined" && decisions[i] === "approved") setDecisions((prev) => ({ ...prev, [i]: "declined" }));
    }
  }, [live.lines, decisions]);

  useEffect(() => {
    if (!playing || cursor >= steps.length || (gate && !gate.ready)) return;
    const last = steps[cursor - 1];
    const t = setTimeout(() => setCursor((c) => c + 1), last ? stepDelay(last) / speed : 300);
    return () => clearTimeout(t);
  }, [playing, cursor, steps, speed, gate?.ready]); // eslint-disable-line react-hooks/exhaustive-deps

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
      "waiting-paypal": "awaiting-approval",
      "needs-click": "awaiting-approval",
    };
    for (const [k, l] of Object.entries(live.lines)) {
      const i = Number(k);
      const st = map[l.state];
      if (!st) continue;
      statuses[i] = st;
      amounts[i] = st === "captured" || st === "authorized" || st === "awaiting-approval" ? run.lines[i].deal.outcome.amountToPay ?? null : null;
    }
    let committedUsd = 0;
    let capturedUsd = 0;
    let pendingUsd = 0;
    statuses.forEach((st, i) => {
      if (st === "captured" || st === "authorized") committedUsd += amounts[i] ?? 0;
      if (st === "captured") capturedUsd += amounts[i] ?? 0;
      if (st === "awaiting-approval") pendingUsd += amounts[i] ?? 0;
    });
    const rows = live.lines[baseView.line]?.rows ?? [];
    const checkout = [
      ...baseView.checkout.filter((r) => r.source !== "paypal"),
      ...rows.map((r) => ({ text: r.debugId ? `${r.text} · debug ${r.debugId}` : r.text, tone: "ok" as const })),
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
    if (Number.isFinite(n) && n >= 1 && n !== seed) restart({ seed: n, rogue });
    else setSeedDraft(String(seed));
  };

  const restart = (next: { selection?: string; seed?: number; rogue?: boolean }) => {
    if (next.selection !== undefined) setSelection(next.selection);
    if (next.seed !== undefined) {
      setSeed(next.seed);
      setSeedDraft(String(next.seed));
    }
    setRogue(next.rogue ?? false);
    setDecisions({});
    setCursor(0);
    setPlaying(true);
  };

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

  return (
    <>
    <main className="wrap" inert={awaiting || undefined}>
      <header className="top">
        <div className="brand">
          <h1>
            Infinity Bazaar<span className="inf">∞</span>
          </h1>
          <span className="eyebrow">Deal room</span>
        </div>
        <div className="controls">
          <label className="field">
            <span className="label">Mission or item</span>
            <select id="selection" value={rogue ? "" : selection} onChange={(e) => restart({ selection: e.target.value, seed })}>
              {rogue && <option value="">Rogue agent demo</option>}
              <optgroup label="Missions">
                {missions.map((m) => (
                  <option key={m.id} value={`mission:${m.id}`}>
                    {m.title} (${m.budgetUsd})
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
          <label className="field table-no">
            <span className="label">Table #</span>
            <input
              id="seed"
              inputMode="numeric"
              value={seedDraft}
              onChange={(e) => setSeedDraft(e.target.value.replace(/[^0-9]/g, ""))}
              onBlur={applySeed}
              onKeyDown={(e) => e.key === "Enter" && applySeed()}
              aria-describedby="seed-help"
            />
            <span id="seed-help" className="sr-only">Press Enter to replay this table.</span>
          </label>
          <div className="btns">
            <button
              className="primary"
              disabled={awaiting}
              onClick={() => (finished ? restart({ seed, rogue }) : setPlaying((p) => !p))}
              aria-label={finished ? "Replay" : playing ? "Pause" : "Play"}
            >
              {finished ? "↺ Replay" : playing ? "❚❚ Pause" : "▶ Play"}
            </button>
            <button onClick={() => restart({ seed: 1 + Math.floor(Math.random() * 999999), rogue })} title="Shuffle sellers, floors and events">
              🎲 New table
            </button>
            <button onClick={skip} disabled={cursor >= steps.length || Boolean(gate && !gate.ready)} aria-label="Skip to the next decision or the end">
              ⏭ Skip
            </button>
            <button className="danger" onClick={() => restart({ seed, rogue: true })}>
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
          {live.status.mode === "sandbox" && (
            <div className="paypal-mode">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={live.enabled}
                  onChange={(e) => {
                    live.setEnabled(e.target.checked);
                    restart({ seed, rogue });
                  }}
                />
                Real PayPal sandbox
              </label>
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
            <span className="label">{run.kind === "mission" ? "Mission" : run.kind === "rogue" ? "Rogue demo" : "Single deal"}</span>
            <p className="goal">“{run.goal}”</p>
            <span className="note">Table #{run.seed} always replays the same deal.</span>
          </div>
          <div className="budget">
            <span className="label">AgentGuard budget</span>
            <div className="bbar">
              <span className="sr-only">Committed ${view.committedUsd} of ${run.budgetUsd}</span>
              <div className="bfill" style={{ width: `${capturedShare}%` }} />
              <div className="bheld" style={{ left: `${capturedShare}%`, width: `${heldShare}%` }} />
              <div className="bpending" style={{ left: `${capturedShare + heldShare}%`, width: `${pendingShare}%` }} />
              <div className="bask" style={{ left: `${askLine}%` }} title={`Ask me above $${run.askAboveUsd}`} />
            </div>
            <div className="bnums">
              <span>
                <i className="dot paid" /> Paid ${view.capturedUsd}
              </span>
              <span>
                <i className="dot held" /> Held ${view.committedUsd - view.capturedUsd}
              </span>
              {view.pendingUsd > 0 && (
                <span>
                  <i className="dot pending" /> Waiting ${view.pendingUsd}
                </span>
              )}
              <span>Budget ${run.budgetUsd}</span>
            </div>
          </div>
        </div>

        {item && view.plan && (
          <div className="pricecard">
            <div className="pc">
              <span className="label">Web low</span>
              <b>${item.price.low}</b>
            </div>
            <div className="pc">
              <span className="label">Typical</span>
              <b>${item.price.typical}</b>
            </div>
            <div className="pc">
              <span className="label">Web high</span>
              <b>${item.price.high}</b>
            </div>
            <div className="pc target">
              <span className="label">Agent target</span>
              <b>${view.plan.target}</b>
            </div>
            <div className="pc walk">
              <span className="label">Walk-away</span>
              <b>${view.plan.walkAway}</b>
            </div>
            <div className="ladder" aria-label="Agent's planned offers">
              <span className="label">{item.name} · offer ladder</span>
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

        <div className="booths">
          {view.booths.map((b, i) => (
            <Booth
              key={`${view.line}-${b.id}`}
              booth={b}
              color={FACE_COLORS[i % 3]}
              floor={view.revealFloors ? run.lines[view.line].deal.sellers.find((s) => s.id === b.id)?.floor ?? null : null}
            />
          ))}
        </div>

        <div className="rail">
          <div>
            <span className="label">Commentator</span>
            <p className="caster">
              {view.commentary[0] ?? "Press play to start."}
            </p>
            <div className="history">
              {view.commentary.slice(1).map((c, i) => (
                <span key={i}>· {c}</span>
              ))}
            </div>
            {view.event && <div className="event">⚡ {view.event}</div>}
          </div>
          <div>
            <span className="label">AgentGuard and PayPal sandbox</span>
            <div className="checkout">
              {view.checkout.length === 0 && <div className="row-info">Waiting for a deal…</div>}
              {view.checkout.map((r, i) => (
                <div key={i} className={`row-${r.tone}`}>
                  {r.text}
                </div>
              ))}
            </div>
            {live.enabled && live.lines[view.line]?.state === "needs-click" && (
              <button className="primary" onClick={() => live.payWithPayPal(view.line)}>
                Pay with PayPal
              </button>
            )}
            {live.enabled && live.lines[view.line]?.state === "error" && (
              <div className="row-bad">
                PayPal error: {live.lines[view.line]?.error}{" "}
                <button onClick={() => live.pay(view.line, decisions[view.line] === "approved")}>Retry</button>
              </div>
            )}
            <span className="note">
              {live.enabled
                ? live.status.wallet
                  ? "Real PayPal sandbox. Approved payments use your connected wallet; ids are PayPal's own."
                  : "Real PayPal sandbox. Connect a wallet to let the agent pay by itself, or approve each payment in PayPal."
                : "PayPal calls are simulated here."}
            </span>
          </div>
        </div>

        <div className="list">
          <span className="label">Shopping list</span>
          <div className="rows">
            {run.lines.map((l, i) => (
              <div key={l.itemId + i} className={`row${i === view.line && !finished ? " current" : ""}`}>
                <span className="row-name">{l.itemName}</span>
                <span className={`pill ${view.statuses[i]}`}>{STATUS_LABEL[view.statuses[i]]}</span>
                <b>{view.amounts[i] !== null ? `$${view.amounts[i]}` : "—"}</b>
              </div>
            ))}
          </div>
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
              <dd>{askGuard?.summary.replace(/^ASKING YOU: /, "") ?? ""}</dd>
            </dl>
            <div className="btns">
              <button ref={approveRef} className="primary" onClick={() => decide("approved")}>
                Approve in PayPal
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
