"use client";

// The arena: a slim strip for your agent, then three one-on-one booths, one per
// seller. Each booth closes with a gap bar between the seller's all-in ask and the
// agent's all-in offer. Below it, the broadcast caption, the AgentGuard gate and
// the Payment panel.
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
  /** What the seller asks all in: price plus a known checkout fee. */
  ask: number;
}

const askAllIn = (b: BoothView) => b.price + (b.feeNow && b.fee ? b.fee : 0);

/** Works out the gap between a seller's all-in ask and the agent's all-in offer to them. */
export function gapFor(b: BoothView, span: number): Gap {
  const ask = askAllIn(b);
  if (b.state === "blocked") return { tone: "blocked", open: 0, label: `Blocked at $${ask}`, ask };
  if (b.state === "won") return { tone: "won", open: 0, label: `Deal at $${ask}`, ask };
  if (b.state === "out") return { tone: "out", open: 1, label: "Out", ask };
  if (b.offerAllIn === null) return { tone: "idle", open: 1, label: "No offer yet", ask };
  const gap = ask - b.offerAllIn;
  if (gap < 0) return { tone: "over", open: 0, label: `Offer $${-gap} over the ask`, ask };
  if (gap === 0) return { tone: "met", open: 0, label: `Agreed at $${ask}`, ask };
  const open = Math.max(0.1, Math.min(1, gap / Math.max(1, span)));
  return { tone: open <= 0.25 ? "close" : "open", open, label: `$${gap} apart`, ask };
}

function GapBar({ booth, gap }: { booth: BoothView; gap: Gap }) {
  const seg = (1 - gap.open) * 50;
  const withFee = booth.feeNow && booth.fee !== null;
  return (
    <div className={`gapbar ${gap.tone}`}>
      <b className="g-label">{gap.label}</b>
      <span className="g-end you">{booth.offerAllIn !== null ? `You $${booth.offerAllIn}` : "You —"}</span>
      <span className="g-bar" aria-hidden="true">
        <i className="g-agent" style={{ transform: `scaleX(${gap.tone === "idle" ? 0 : seg / 50})` }} />
        <i className="g-seller" style={{ transform: `scaleX(${(gap.tone === "idle" ? 8 : seg) / 50})` }} />
      </span>
      <span className="g-end ask">
        Ask ${gap.ask}
        {withFee && " incl. fee"}
      </span>
    </div>
  );
}

function Booth({
  booth,
  index,
  floor,
  gap,
  shown,
  narrow,
  live,
  note,
}: {
  booth: BoothView;
  index: number;
  floor: number | null;
  gap: Gap;
  /** Visible on a phone (one booth at a time). */
  shown: boolean;
  narrow: boolean;
  /** This booth's chat is announced to screen readers. */
  live: boolean;
  /** A closing system note, for sellers who are out. */
  note: string | null;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  const count = booth.messages.length + (note ? 1 : 0);
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [count]);
  // A booth shown again on a phone jumps straight to its newest message.
  useEffect(() => {
    const el = logRef.current;
    if (shown && el) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const fee = booth.fee !== null ? (booth.feeNow ? `+$${booth.fee} fee` : `+$${booth.fee} later`) : null;
  const panel = narrow ? { role: "tabpanel", "aria-labelledby": `tab-${booth.id}` } : { "aria-label": `${booth.name}, asks $${booth.price}` };
  return (
    <article id={`booth-${booth.id}`} className={`booth s${index} ${booth.state}${shown ? " active" : ""}`} {...panel}>
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
          {fee && <small>{fee}</small>}
        </div>
      </header>
      <div className="log" ref={logRef} tabIndex={0} role="log" aria-live={live ? "polite" : "off"} aria-label={`Chat with ${booth.name}`}>
        {booth.messages.length === 0 && <p className="quiet">Waiting for your agent to make the first offer…</p>}
        {booth.messages.map((m) => (
          <div key={m.seq} className={`msg ${m.from}`}>
            <span className="who">{m.from === "agent" ? "Your agent" : booth.name}</span>
            {m.text && <div className="b">{m.text}</div>}
            {m.tag && <span className={`tag ${m.tagKind}`}>{m.tag}</span>}
          </div>
        ))}
        {note && <p className="sys">{note}</p>}
      </div>
      <footer className="bfoot">
        <GapBar booth={booth} gap={gap} />
        {floor !== null && <div className="floor">Lowest they'd accept: ${floor}</div>}
      </footer>
    </article>
  );
}

const STATE_WORD = { idle: "ready", talking: "haggling", deal: "agreed", walked: "walked away", blocked: "stopped", declined: "declined", released: "not delivered" } as const;
export type ArenaState = keyof typeof STATE_WORD;

/** True below the width where booths stack into tabs. */
function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 899px)");
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

export function Arena({
  booths,
  lineKey,
  span,
  floors,
  agentOffer,
  dealPrice,
  dealSellerId,
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
  /** What the agreed deal costs all in, once agreed. */
  dealPrice: number | null;
  dealSellerId: string | null;
  target: number | null;
  walkAway: number | null;
  state: ArenaState;
}) {
  const gaps = booths.map((b) => gapFor(b, span));
  const narrow = useNarrow();

  // The booth that matters: the winning or blocked seller once there is one,
  // otherwise whoever spoke last. On a phone, a tab the player picked wins.
  const winner = booths.find((b) => b.state === "won" || b.state === "blocked") ?? booths.find((b) => b.id === dealSellerId) ?? null;
  const latest = booths.reduce<BoothView | null>((best, b) => (b.lastSeq > (best?.lastSeq ?? 0) ? b : best), null);
  const focus = winner?.id ?? latest?.id ?? booths[0]?.id ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const [seen, setSeen] = useState<Record<string, number>>({});
  useEffect(() => {
    setPicked(null);
    setSeen({});
  }, [lineKey]);
  const shown = picked ?? focus;
  const shownSeq = booths.find((b) => b.id === shown)?.lastSeq ?? 0;
  useEffect(() => {
    if (shown) setSeen((s) => (s[shown] === shownSeq ? s : { ...s, [shown]: shownSeq }));
  }, [shown, shownSeq]);

  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "Home" ? -i : e.key === "End" ? booths.length - 1 - i : 0;
    if (!step && e.key !== "Home") return;
    e.preventDefault();
    const j = (i + step + booths.length) % booths.length;
    setPicked(booths[j].id);
    tabRefs.current[j]?.focus();
  };

  const winnerName = winner?.name ?? null;
  const noteFor = (b: BoothView) => {
    if (winner && b.id !== winner.id && (winner.state === "won" || winner.state === "blocked")) return `Out of the running — your agent went with ${winnerName}.`;
    if (b.state === "out" && b.messages.at(-1)?.from !== "seller") return "Out of the running.";
    return null;
  };

  let offerText: React.ReactNode = "No offer yet";
  if (state === "blocked" && dealPrice !== null) offerText = <>Agreed to <b>${dealPrice}</b> — blocked by AgentGuard</>;
  else if (state === "deal" && dealPrice !== null) offerText = <><b>${dealPrice}</b> agreed</>;
  else if (state === "declined" && dealPrice !== null) offerText = <>Agreed <b>${dealPrice}</b> — you declined, nothing paid</>;
  else if (state === "released" && dealPrice !== null) offerText = <><b>${dealPrice}</b> held — not delivered, so the hold was released</>;
  else if (state === "walked") offerText = agentOffer !== null ? <>No deal · last offer <b>${agentOffer}</b></> : "No deal";
  else if (agentOffer !== null) offerText = <><b>${agentOffer}</b> on the table</>;

  return (
    <div className={`arena ${state}`}>
      <div className="agent-strip" aria-label="Your agent">
        <div className="medal" aria-hidden="true">
          ∞
        </div>
        <span className="agent-name">Your agent</span>
        <span className="agent-offer">{offerText}</span>
        {target !== null && walkAway !== null && (
          <span className="agent-plan">
            Target ${target} · walks at ${walkAway}
          </span>
        )}
        <span className={`agent-state ${state}`}>{STATE_WORD[state]}</span>
      </div>

      <div className="tabs" role="tablist" aria-label="Sellers">
        {booths.map((b, i) => {
          const on = shown === b.id;
          const unread = !on && b.lastSeq > (seen[b.id] ?? 0);
          return (
            <button
              key={b.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              id={`tab-${b.id}`}
              role="tab"
              aria-selected={on}
              aria-controls={`booth-${b.id}`}
              tabIndex={on ? 0 : -1}
              className={`tab s${i}${on ? " on" : ""}`}
              onClick={() => setPicked(b.id)}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              <span className="tab-name">{b.name}</span>
              <span className="tab-ask">${askAllIn(b)}</span>
              {unread && (
                <>
                  <i className="unread" aria-hidden="true" />
                  <span className="sr-only"> (new message)</span>
                </>
              )}
            </button>
          );
        })}
      </div>

      <div className="booths">
        {booths.map((b, i) => (
          <Booth
            key={b.id}
            booth={b}
            index={i}
            floor={floors[i]}
            gap={gaps[i]}
            shown={shown === b.id}
            narrow={narrow}
            live={narrow ? shown === b.id : focus === b.id}
            note={noteFor(b)}
          />
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
