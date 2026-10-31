"use client";

// The arena: your agent in the middle, three sellers around it, and a tether
// from each seller to the agent whose open gap is the price gap between them.
// Below it, the broadcast caption, the AgentGuard gate and the PayPal rail.
import { useEffect, useRef, useState } from "react";
import { sellerData } from "../src/engine/index.ts";
import type { BoothView, CheckoutRow, TranscriptEntry } from "../lib/timeline.ts";
import type { GuardDecision } from "../src/engine/index.ts";

export const SEAT_COLORS = ["var(--brass)", "var(--teal)", "var(--rose)"];
const archetypeLabel = (id: string) => sellerData.archetypes.find((a) => a.id === id)?.label ?? id;
const money = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

type TetherTone = "idle" | "open" | "close" | "met" | "over" | "out" | "won" | "blocked";

interface Tether {
  tone: TetherTone;
  /** How much of the tether is still open, 0 (met) to 1 (far apart). */
  open: number;
  label: string;
  /** Spoken version for screen readers. */
  spoken: string;
}

/** Works out the tether between a seller's ask and the agent's offer to them. */
export function tetherFor(b: BoothView, span: number): Tether {
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

function lastFrom(b: BoothView, from: "agent" | "seller") {
  for (let i = b.messages.length - 1; i >= 0; i--) if (b.messages[i].from === from) return b.messages[i];
  return null;
}

function SellerSeat({ booth, index, floor, tether }: { booth: BoothView; index: number; floor: number | null; tether: Tether }) {
  const said = lastFrom(booth, "seller");
  const seg = (1 - tether.open) * 50;
  return (
    <article className={`booth seat s${index} ${booth.state}`} aria-label={`${booth.name}, asks $${booth.price}, ${tether.spoken}`}>
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
      <div className="say seller-say" aria-live="off">
        {said?.text ? <p>{said.text}</p> : <p className="quiet">{booth.state === "out" ? "Left the table." : "Waiting for the agent…"}</p>}
        {said?.tag && <span className={`tag ${said.tagKind}`}>{said.tag}</span>}
      </div>
      <div className={`tether ${tether.tone}`} aria-hidden="true">
        <span className="t-end you">{booth.offer !== null ? `You $${booth.offer}` : "You —"}</span>
        <span className="t-bar">
          <i className="t-agent" style={{ transform: `scaleX(${seg / 50})` }} />
          <i className="t-seller" style={{ transform: `scaleX(${(tether.tone === "idle" ? 8 : seg) / 50})` }} />
          <b>{tether.label}</b>
        </span>
        <span className="t-end ask">Ask ${booth.price}</span>
      </div>
      {floor !== null && <div className="floor">Lowest they'd accept: ${floor}</div>}
    </article>
  );
}

/** Desktop only: the three tethers drawn from each seller down to the agent, in real pixels. */
function Wires({ booths, tethers }: { booths: BoothView[]; tethers: Tether[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1200, h: 110 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.max(1, e.contentRect.width), h: Math.max(1, e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { w, h } = size;
  // Only animate a price that moved by one step; a Skip that jumps many steps stays still.
  const seen = useRef<Record<string, { o: number; a: number; oMove: boolean; aMove: boolean }>>({});
  for (const b of booths) {
    const p = seen.current[b.id] ?? { o: 0, a: 0, oMove: false, aMove: false };
    if (b.offerSeq !== p.o) seen.current[b.id] = { ...p, o: b.offerSeq, oMove: b.offerSeq === p.o + 1 };
    const q = seen.current[b.id] ?? p;
    if (b.askSeq !== q.a) seen.current[b.id] = { ...q, a: b.askSeq, aMove: b.askSeq === q.a + 1 };
  }
  const ends = booths.map((_, i) => ({ sx: (w * (1 + 2 * i)) / 6, ax: w / 2 + (i - 1) * Math.min(44, w * 0.035) }));
  return (
    <div className="wires" ref={ref} aria-hidden="true">
      <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h}>
        {booths.map((b, i) => {
          const { sx, ax } = ends[i];
          const t = tethers[i];
          // Each side is half the wire, scaled from its own end: the unscaled middle is the gap.
          const k = 1 - t.open;
          const mx = (sx + ax) / 2;
          const my = h / 2;
          return (
            <g key={b.id} className={`wire ${t.tone}`}>
              <line className="w-track" x1={sx} y1={0} x2={ax} y2={h} />
              <line className="w-seller" x1={sx} y1={0} x2={mx} y2={my} style={{ transformOrigin: `${sx}px 0px`, transform: `scale(${t.tone === "idle" ? 0.16 : k})` }} />
              <line className="w-agent" x1={ax} y1={h} x2={mx} y2={my} style={{ transformOrigin: `${ax}px ${h}px`, transform: `scale(${t.tone === "idle" ? 0 : k})` }} />
            </g>
          );
        })}
      </svg>
      {booths.map((b, i) => {
        const { sx, ax } = ends[i];
        const t = tethers[i];
        const pos = { "--ax": `${ax}px`, "--dx": `${sx - ax}px`, "--dy": `${-h}px` } as React.CSSProperties;
        return (
          <div key={b.id} style={pos}>
            <span className={`knot ${t.tone}`} key={`${t.tone}-${t.label}`} style={{ left: `${(sx + ax) / 2}px` }}>
              {t.label}
            </span>
            {b.offerSeq > 0 && b.offer !== null && seen.current[b.id]?.oMove && (
              <span key={`o${b.offerSeq}`} className="chip out">
                ${b.offer}
              </span>
            )}
            {b.askSeq > 0 && seen.current[b.id]?.aMove && (
              <span key={`a${b.askSeq}`} className="chip in">
                ${b.price}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function Arena({
  booths,
  span,
  floors,
  agentOffer,
  target,
  walkAway,
  agentSay,
  state,
}: {
  booths: BoothView[];
  span: number;
  floors: (number | null)[];
  agentOffer: number | null;
  target: number | null;
  walkAway: number | null;
  agentSay: { text: string; tag?: string } | null;
  state: "idle" | "talking" | "deal" | "blocked" | "walked";
}) {
  const tethers = booths.map((b) => tetherFor(b, span));
  return (
    <div className={`arena ${state}`}>
      <div className="seats">
        {booths.map((b, i) => (
          <SellerSeat key={b.id} booth={b} index={i} floor={floors[i]} tether={tethers[i]} />
        ))}
      </div>
      {booths.length > 0 && <Wires booths={booths} tethers={tethers} />}
      <div className="agent" aria-label="Your agent">
        <div className="medal" aria-hidden="true">
          ∞
        </div>
        <div className="agent-id">
          <span className="label">Your agent</span>
          <div className="agent-offer">
            <span className="sr-only">Current offer </span>
            {agentOffer !== null ? `$${agentOffer}` : "—"}
            <small>{state === "deal" ? "agreed" : state === "blocked" ? "stopped" : agentOffer !== null ? "on the table" : "no offer yet"}</small>
          </div>
          {target !== null && walkAway !== null && (
            <span className="agent-plan">
              Target ${target} · walks at ${walkAway}
            </span>
          )}
        </div>
        <div className="say agent-say">
          {agentSay ? <p>{agentSay.text}</p> : <p className="quiet">Press play to open the table.</p>}
          {agentSay?.tag && <span className="tag move">{agentSay.tag}</span>}
        </div>
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

/** The whole conversation in one drawer, newest at the bottom. */
export function Transcript({ entries, names }: { entries: TranscriptEntry[]; names: string[] }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const toBottom = (smooth: boolean) => {
    const el = logRef.current;
    if (!el || !ref.current?.open) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduce ? "smooth" : "auto" });
  };
  useEffect(() => toBottom(true), [entries.length]);
  return (
    <details className="transcript" ref={ref} onToggle={() => toBottom(false)}>
      <summary>
        <span className="label">Full transcript</span>
        <span className="count">
          {entries.length} {entries.length === 1 ? "message" : "messages"}
        </span>
      </summary>
      <div className="log" ref={logRef} tabIndex={0} aria-label="Negotiation transcript">
        {entries.length === 0 && <p className="note">Nothing said yet.</p>}
        {entries.map((m, k) => {
          const to = m.names.length === names.length && names.length > 1 ? "all sellers" : m.names.join(", ");
          return (
            <div key={k} className={`msg ${m.from}`}>
              <span className="who">
                {m.from === "agent" ? (
                  <>Your agent → {to}</>
                ) : (
                  <>
                    <i className="dot" style={{ background: SEAT_COLORS[(m.sellerIndex ?? 0) % 3] }} /> {m.names[0]}
                  </>
                )}
              </span>
              {m.text && <div className="b">{m.text}</div>}
              {m.tag && <span className={`tag ${m.tagKind}`}>{m.tag}</span>}
            </div>
          );
        })}
      </div>
    </details>
  );
}
