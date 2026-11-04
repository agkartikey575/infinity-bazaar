"use client";

// Live AI voices: fetches Claude's rewording of each line of the current run,
// in parallel, when the run is chosen and again on Play for any line still
// missing, so they're usually ready before playback reaches them. Nothing is
// fetched for runs that aren't on screen. Prices and outcomes never come from
// here; only the wording of chat lines.
import { useEffect, useRef, useState } from "react";

export type LineVoices = Record<number, string>;

export interface VoiceRef {
  kind: "mission" | "single" | "rogue";
  id: string;
  seed: number;
}

const NONE: Record<number, LineVoices> = {};

export function useVoices(ref: VoiceRef, lineCount: number, playing: boolean) {
  const [enabled, setEnabled] = useState(false);
  const key = `${ref.kind}:${ref.id}:${ref.seed}`;
  const [voices, setVoices] = useState<{ key: string; lines: Record<number, LineVoices> }>({ key: "", lines: NONE });
  /** Requests for the current run: which lines are loading or done, and how to cancel them. */
  const job = useRef<{ key: string; ctrl: AbortController; busy: Set<number>; done: Set<number> } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/voice")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => alive && setEnabled(s?.enabled === true))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const load = () => {
    const j = job.current;
    if (!j) return;
    for (let line = 0; line < lineCount; line++) {
      if (j.busy.has(line) || j.done.has(line)) continue;
      j.busy.add(line);
      fetch("/api/voice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run: ref, line }),
        signal: j.ctrl.signal,
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { texts?: Record<string, string> } | null) => {
          const lv: LineVoices = {};
          for (const [k, v] of Object.entries(d?.texts ?? {})) if (typeof v === "string") lv[Number(k)] = v;
          if (!Object.keys(lv).length) return;
          j.done.add(line);
          setVoices((prev) => (prev.key === j.key ? { key: j.key, lines: { ...prev.lines, [line]: lv } } : prev));
        })
        .catch(() => undefined) // No voices: the original lines play.
        .finally(() => j.busy.delete(line));
    }
  };

  // A new run: cancel what the old one still had in flight, then fetch every line.
  useEffect(() => {
    if (!enabled) return;
    const j = { key, ctrl: new AbortController(), busy: new Set<number>(), done: new Set<number>() };
    job.current = j;
    setVoices({ key, lines: NONE });
    load();
    return () => {
      j.ctrl.abort();
      if (job.current === j) job.current = null;
    };
  }, [enabled, key, lineCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // Play: try again for any line that came back without voices.
  useEffect(() => {
    if (enabled && playing) load();
  }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps

  return { enabled, voices: voices.key === key ? voices.lines : NONE };
}
