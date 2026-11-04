"use client";

// Live AI voices: fetches Claude's rewording of each line of the chosen run, in
// parallel, as soon as the run is chosen, so they're usually ready before Play.
// Prices and outcomes never come from here; only the wording of chat lines.
import { useEffect, useState } from "react";

export type LineVoices = Record<number, string>;

export interface VoiceRef {
  kind: "mission" | "single" | "rogue";
  id: string;
  seed: number;
}

export function useVoices(ref: VoiceRef, lineCount: number) {
  const [enabled, setEnabled] = useState(false);
  const key = `${ref.kind}:${ref.id}:${ref.seed}`;
  const [voices, setVoices] = useState<{ key: string; lines: Record<number, LineVoices> }>({ key: "", lines: {} });

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

  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    setVoices({ key, lines: {} });
    for (let line = 0; line < lineCount; line++) {
      fetch("/api/voice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run: ref, line }),
        signal: ctrl.signal,
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { texts?: Record<string, string> } | null) => {
          const texts = d?.texts ?? {};
          if (!Object.keys(texts).length) return;
          const lv: LineVoices = {};
          for (const [k, v] of Object.entries(texts)) if (typeof v === "string") lv[Number(k)] = v;
          setVoices((prev) => (prev.key === key ? { key, lines: { ...prev.lines, [line]: lv } } : prev));
        })
        .catch(() => undefined); // No voices: the original lines play.
    }
    return () => ctrl.abort();
  }, [enabled, key, lineCount]); // eslint-disable-line react-hooks/exhaustive-deps

  return { enabled, voices: voices.key === key ? voices.lines : {} };
}
