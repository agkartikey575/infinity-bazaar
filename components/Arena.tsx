"use client";

// The arena: a slim strip for your agent, then three one-on-one booths, one per
// seller. Each booth closes with a gap bar between the seller's ask and the
// agent's offer. Below it, the broadcast caption, the AgentGuard gate and the
// Payment panel.
import { useEffect, useRef, useState } from "react";
import { sellerData } from "../src/engine/index.ts";
import type { BoothView, CheckoutRow } from "../lib/timeline.ts";
import type { GuardDecision } from "../src/engine/index.ts";

export const SEAT_COLORS = ["var(--brass)", "var(--teal)", "var(--rose)"];
const archetypeLabel = (id: string) => sellerData.archetypes.find((a) => a.id === id)?.label ?? id;
const money = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

type GapTone = "idle" | "open" | "close" | "met" | "over" | "out" | "won" | "blocked";

interface Gap {
  tone: GapTone;
  /** How much of the bar is still open, 0 (met) to 1 (far apart). */
  open: number;
  label: string;
  /** Spoken version for screen readers. */
  spoken: string;
}

/** Works out the gap between a seller's ask and the agent's offer to them. */
export function gapFor(b: BoothView, span: number): Gap {
  if (b.state === "blocked") return { tone: "blocked", open: 0, label: `Blocked $${b.price}`, spoken: `deal at $${b.price} blocked by AgentGuard` };
  if (b.state === "won") return { tone: "won", open: 0, label: `Deal $${b.price}`, spoken: `deal at $${b.price}` };
  if (b.state === "out") return { tone: "out", open: 1, label: "Out", spoken: "out of the running" };
  if (b.offer === null) return { tone: "idle", open: 1, label: "No offer yet", spoken: "no offer yet" };
  const gap = b.price - b.offer;
  if (gap < 0) return { tone: "over", open: 0, label: `Offer $${-gap} over ask`, spoken: `the agent offers $${-gap} more than the ask` };
  if (gap === 0) return { tone: "met", open: 0, label: `Agreed $${b.price}`, spoken: `agreed at $${b.price}` };
  const open = Math.max(0.1, Math.min(1, gap / Math.max(1, span)));
  return { tone: open <= 0.25 ? "close" : "open", open, label: `$${gap} apart`, spoken: `$${gap} apart` };
}

function GapBar({ booth, gap }: { booth: BoothView; gap: Gap }) {
  const seg = (1 - gap.open) * 50;
  return (
    <div className={`gapbar ${gap.tone}`}>
      <span className="g-end you">{booth.offer !== null ? `You $${booth.offer}` : "You —"}</span>
      <span className="g-bar" aria-hidden="true">
        <i className="g-agent" style={{ transform: `scaleX(${gap.tone === "idle" ? 0 : seg / 50})` }} />
        <i className="g-seller" style={{ transform: `scaleX(${(gap.tone === "idle" ? 8 : seg) / 50})` }} />
        <b>{gap.label}</b>
      </span>
      <span className="sr-only">{gap.spoken}</span>
      <span className="g-end ask">Ask ${booth.price}</span>
    </div>
  );
}

function Booth({ booth, index, floor, gap, active, id }: { booth: BoothView; index: number; floor: number | null; gap: Gap; active: boolean; id: string }) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [booth.messages.length]);
  // A booth shown again on a phone jumps straight to its newest message.
  useEffect(() => {
    const el = logRef.current;
    if (active && el) el.scrollTop = el.scrollHeight;
  }, [active]);

  return (
    <article id={id} className={`booth s${index} ${booth.state}${active ? " active" : ""}`} aria-label={`${booth.name}, asks $${booth.price}`}>
      <header className="bhead">
        <div className="face" style={{ background: SEAT_COLORS[index % 3] }} aria-hidden="true">
          {booth.name[0]}
        </div>
        <div className="bname">
          <h3>{booth.name}</h3>
          <span>{archetypeLabel(booth.archetype)}</span>
        </div>
        <div className="bprice">
          <span className="sr-only">asks </span>
          <span key={booth.askSeq} className="tick">
            ${booth.price}
          </span>
          {booth.fee !== null && <small>+${booth.fee} fee</small>}
        </div>
      </header>
      <div className="log" ref={logRef} tabIndex={0} aria-label={`Chat with ${booth.name}`}>
        {booth.messages.length === 0 && <p className="quiet">Waiting for your agent to make the first offer…</p>}
        {booth.messages.map((m, k) => (
          <div key={k} className={`msg ${m.from}`}>
            <span className="who">{m.from === "agent" ? "Your agent" : booth.name}</span>
            {m.text && <div className="b">{m.text}</div>}
            {m.tag && <span className={`tag ${m.tagKind}`}>{m.tag}</span>}
          </div>
        ))}
      </div>
      <footer className="bfoot">
        <GapBar booth={booth} gap={gap} />
        {floor !== null && <div className="floor">Lowest they'd accept: ${floor}</div>}
      </footer>
    </article>
  );
}

const STATE_WORD = { idle: "ready", talking: "haggling", deal: "agreed", walked: "walked away", blocked: "stopped" } as const;
export type ArenaState = keyof typeof STATE_WORD;

export function Arena({
  booths,
  lineKey,
  span,
  floors,
  agentOffer,
  target,
  walkAway,
  state,
}: {
  booths: BoothView[];
  /** Changes when a new item starts, so phone tabs reset. */
  lineKey: string;
  span: number;
  floors: (number | null)[];
  agentOffer: number | null;
  target: number | null;
  walkAway: number | null;
  state: ArenaState;
}) {
  const gaps = booths.map((b) => gapFor(b, span));

  // Phone tabs: follow the booth with the newest message, unless the player picked one.
  const [picked, setPicked] = useState<string | null>(null);
  const [latest, setLatest] = useState<string | null>(null);
  const [unread, setUnread] = useState<string[]>([]);
  const counts = useRef<Record<string, number>>({});
  useEffect(() => {
    setPicked(null);
    setLatest(null);
    setUnread([]);
    counts.current = {};
  }, [lineKey]);
  const countKey = booths.map((b) => b.messages.length).join(",");
  const shown = picked ?? latest ?? booths[0]?.id ?? null;
  useEffect(() => {
    let newest: string | null = null;
    const grew: string[] = [];
    for (const b of booths) {
      if (b.messages.length > (counts.current[b.id] ?? 0)) {
        grew.push(b.id);
        if (b.messages.at(-1)?.from === "seller" || newest === null) newest = b.id;
      }
      counts.current[b.id] = b.messages.length;
    }
    if (!grew.length) return;
    if (newest) setLatest(newest);
    const visible = picked ?? newest;
    setUnread((u) => [...new Set([...u, ...grew])].filter((id) => id !== visible));
  }, [countKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (id: string) => {
    setPicked(id);
    setUnread((u) => u.filter((x) => x !== id));
  };

  return (
    <div className={`arena ${state}`}>
      <div className="agent-strip" aria-label="Your agent">
        <div className="medal" aria-hidden="true">
          ∞
        </div>
        <span className="agent-name">Your agent</span>
        <span className="agent-offer">
          {agentOffer !== null ? (
            <>
              <b>${agentOffer}</b> {state === "deal" ? "agreed" : "on the table"}
            </>
          ) : (
            "No offer yet"
          )}
        </span>
        {target !== null && walkAway !== null && (
          <span className="agent-plan">
            Target ${target} · walks at ${walkAway}
          </span>
        )}
        <span className={`agent-state ${state}`}>{STATE_WORD[state]}</span>
      </div>

      <div className="tabs" role="group" aria-label="Booths">
        {booths.map((b, i) => (
          <button
            key={b.id}
            className={`tab s${i}${shown === b.id ? " on" : ""}`}
            aria-pressed={shown === b.id}
            aria-controls={`booth-${b.id}`}
            onClick={() => pick(b.id)}
          >
            <span className="tab-name">{b.name}</span>
            <span className="tab-ask">${b.price}</span>
            {unread.includes(b.id) && <i className="unread" aria-label="new message" />}
          </button>
        ))}
      </div>

      <div className="booths">
        {booths.map((b, i) => (
          <Booth key={b.id} id={`booth-${b.id}`} booth={b} index={i} floor={floors[i]} gap={gaps[i]} active={shown === b.id} />
        ))}
      </div>
    </div>
  );
}

export function Caption({ lines, event }: { lines: string[]; event: string | null }) {
  return (
    <div className="caption">
      <span className="onair" aria-hidden="true">
        <i /> Live
      </span>
      <div className="caption-body">
        <span className="sr-only">Commentator: </span>
        <p className="caster" key={lines[0] ?? ""}>
          {lines[0] ?? "Press play to start."}
        </p>
        {lines[1] && <p className="history">{lines[1]}</p>}
      </div>
      {event && <span className="event">⚡ {event}</span>}
    </div>
  );
}

const LAMPS: { id: GuardDecision["decision"]; icon: string; text: string }[] = [
  { id: "approve", icon: "✓", text: "Approve" },
  { id: "ask_user", icon: "?", text: "Ask you" },
  { id: "block", icon: "✕", text: "Block" },
];

/** AgentGuard sits between the deal and PayPal; nothing reaches PayPal without passing it. */
export function Gate({
  guard,
  rows,
  blockedAmount,
  blockedSeller,
}: {
  guard: GuardDecision | null;
  rows: CheckoutRow[];
  blockedAmount: number | null;
  blockedSeller: string | null;
}) {
  const d = guard?.decision ?? "idle";
  // Passed checks read as a compact row of ticks; failures and the verdict stay full width.
  const isPass = (r: CheckoutRow) => r.tone === "info" && r.text.startsWith("✓");
  const passed = rows.filter(isPass);
  const others = rows.filter((r) => !isPass(r));
  return (
    <section className={`gate ${d}`} aria-labelledby="gate-title">
      <div className="gate-head">
        <h2 id="gate-title" className="label">
          AgentGuard · checks every payment
        </h2>
        <div className="lamps">
          {LAMPS.map((l) => (
            <span key={l.id} className={`lamp ${l.id}${d === l.id ? " on" : ""}`} aria-current={d === l.id || undefined}>
              <i aria-hidden="true">{l.icon}</i> {l.text}
            </span>
          ))}
        </div>
      </div>
      {d === "block" && (
        <div className="blocked-hero">
          <div className="stamp">Blocked</div>
          <p>
            Your agent agreed to pay {blockedAmount !== null ? money(blockedAmount) : "it"}
            {blockedSeller ? ` to ${blockedSeller}` : ""}. AgentGuard said no.
            <b> Nothing was sent to PayPal.</b>
          </p>
        </div>
      )}
      {passed.length > 0 && (
        <ul className="passed" aria-label={`${passed.length} checks passed`}>
          {passed.map((r, i) => (
            <li key={i}>{r.text}</li>
          ))}
        </ul>
      )}
      <div className="checks">
        {rows.length === 0 && <div className="row-info">Waiting for a deal…</div>}
        {others.map((r, i) => (
          <div key={i} className={`row-${r.tone}`}>
            {r.text}
          </div>
        ))}
      </div>
    </section>
  );
}
