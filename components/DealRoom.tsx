"use client";

import { useEffect, useMemo, useState } from "react";
import { catalog, getItem, missions, sellerData } from "../src/engine/index.ts";
import { buildMissionRun, buildSingleRun, buildSteps, deriveView, stepDelay, type Decision, type LineStatus } from "../lib/timeline.ts";

const SPEEDS = [0.5, 1, 2, 4];
const FACE_COLORS = ["var(--brass)", "var(--teal)", "var(--rose)"];

const STATUS_LABEL: Record<LineStatus, string> = {
  waiting: "Waiting",
  negotiating: "Negotiating",
  checking: "AgentGuard check",
  "awaiting-approval": "Needs your OK",
  paid: "Paid",
  held: "Paid, held until delivery",
  declined: "Declined",
  blocked: "Blocked",
  "no-deal": "Walked away",
  refunded: "Refunded",
};

const archetypeLabel = (id: string) => sellerData.archetypes.find((a) => a.id === id)?.label ?? id;

export default function DealRoom() {
  const [selection, setSelection] = useState("mission:hackathon-10-days");
  const [seed, setSeed] = useState(42);
  const [rogue, setRogue] = useState(false);
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const run = useMemo(() => {
    if (rogue) return buildSingleRun("usb-mic", seed, true);
    const [kind, id] = selection.split(":");
    return kind === "mission" ? buildMissionRun(id, seed) : buildSingleRun(id, seed);
  }, [selection, seed, rogue]);

  const { steps, waitingFor } = useMemo(() => buildSteps(run, decisions), [run, decisions]);
  const view = useMemo(() => deriveView(run, steps, cursor), [run, steps, cursor]);
  const finished = cursor >= steps.length && waitingFor === null;
  const awaiting = cursor >= steps.length && waitingFor !== null;

  useEffect(() => {
    if (!playing || cursor >= steps.length) return;
    const last = steps[cursor - 1];
    const t = setTimeout(() => setCursor((c) => c + 1), last ? stepDelay(last) / speed : 300);
    return () => clearTimeout(t);
  }, [playing, cursor, steps, speed]);

  const restart = (next: { selection?: string; seed?: number; rogue?: boolean }) => {
    if (next.selection !== undefined) setSelection(next.selection);
    if (next.seed !== undefined) setSeed(next.seed);
    setRogue(next.rogue ?? false);
    setDecisions({});
    setCursor(0);
    setPlaying(true);
  };

  const decide = (d: Decision) => {
    if (waitingFor === null) return;
    setDecisions((prev) => ({ ...prev, [waitingFor]: d }));
  };

  const line = run.lines[view.line];
  const item = line ? getItem(line.itemId) : null;
  const spentShare = Math.min(100, (view.spentUsd / run.budgetUsd) * 100);
  const pendingShare = Math.min(100 - spentShare, (view.pendingUsd / run.budgetUsd) * 100);
  const askLine = Math.min(100, (run.askAboveUsd / run.budgetUsd) * 100);

  return (
    <main className="wrap">
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
          <div className="btns">
            <button className="primary" onClick={() => (finished ? restart({ selection, seed, rogue }) : setPlaying((p) => !p))}>
              {finished ? "↺ Replay" : playing && !awaiting ? "❚❚ Pause" : "▶ Play"}
            </button>
            <button onClick={() => restart({ selection, seed: Math.floor(Math.random() * 1e6) })} title="Shuffle sellers, floors and events">
              🎲 New table
            </button>
            <button onClick={() => setCursor(steps.length)} disabled={cursor >= steps.length}>
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
        </div>
      </header>

      <section className="room" aria-label="Deal room">
        <div className="mission">
          <div className="goal-box">
            <span className="label">{run.kind === "mission" ? "Mission" : run.kind === "rogue" ? "Rogue demo" : "Single deal"}</span>
            <p className="goal">“{run.goal}”</p>
            <span className="note">Table #{run.seed}. The same table number always replays the same deal.</span>
          </div>
          <div className="budget">
            <span className="label">AgentGuard budget</span>
            <div className="bbar">
              <div className="bfill" style={{ width: `${spentShare}%` }} />
              <div className="bpending" style={{ left: `${spentShare}%`, width: `${pendingShare}%` }} />
              <div className="bask" style={{ left: `${askLine}%` }} title={`Ask me above $${run.askAboveUsd}`} />
            </div>
            <div className="bnums">
              <span>Spent ${view.spentUsd}</span>
              {view.pendingUsd > 0 && <span>Waiting ${view.pendingUsd}</span>}
              <span>Ask me above ${run.askAboveUsd}</span>
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
                  <span key={o} className={`rung${i === view.offerIndex ? " now" : i < view.offerIndex ? " used" : ""}`}>
                    ${o}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="booths">
          {view.booths.map((b, i) => (
            <div key={b.id} className={`booth${b.won ? " won" : ""}${b.out && !b.won ? " out" : ""}`}>
              <div className="bhead">
                <div className="face" style={{ background: FACE_COLORS[i % 3] }}>
                  {b.name[0]}
                </div>
                <div className="bname">
                  <h3>{b.name}</h3>
                  <span>{archetypeLabel(b.archetype)}</span>
                </div>
                <div className="bprice">${b.price}</div>
              </div>
              <div className="log">
                {b.messages.map((m, k) => (
                  <div key={k} className={`msg ${m.from}`}>
                    <span className="who">{m.from === "agent" ? "Your agent" : b.name}</span>
                    {m.text && <div className="b">{m.text}</div>}
                    {m.tag && <span className={`tag ${m.tagKind}`}>{m.tag}</span>}
                  </div>
                ))}
              </div>
              {view.revealFloors && (
                <div className="floor">Hidden floor: ${run.lines[view.line].deal.sellers.find((s) => s.id === b.id)?.floor}</div>
              )}
            </div>
          ))}
        </div>

        <div className="rail">
          <div>
            <span className="label">Commentator</span>
            <p className="caster">{view.commentary[0] ?? "Press play to start."}</p>
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
            {awaiting && (
              <div className="approve">
                <p>
                  Your agent wants to pay <b>${run.lines[waitingFor!].deal.outcome.amountToPay}</b> to {run.lines[waitingFor!].deal.outcome.sellerName} for{" "}
                  {run.lines[waitingFor!].itemName.toLowerCase()}.
                </p>
                <div className="btns">
                  <button className="primary" onClick={() => decide("approved")}>
                    Approve
                  </button>
                  <button onClick={() => decide("declined")}>Decline</button>
                </div>
              </div>
            )}
            <span className="note">PayPal calls are simulated until the sandbox keys are connected.</span>
          </div>
        </div>

        <div className="list">
          <span className="label">Shopping list</span>
          <div className="rows">
            {run.lines.map((l, i) => (
              <div key={l.itemId + i} className={`row${i === view.line && !finished ? " current" : ""}`}>
                <span>{l.itemName}</span>
                <span className={`pill ${view.statuses[i]}`}>{STATUS_LABEL[view.statuses[i]]}</span>
                <b>{view.amounts[i] !== null ? `$${view.amounts[i]}` : "—"}</b>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
