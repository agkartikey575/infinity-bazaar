"use client";

import { useEffect, useState } from "react";

/** PayPal sends the buyer back here inside the popup. Tell the deal room, then close. */
export default function PayPalReturn() {
  const [note, setNote] = useState("Returning to Infinity Bazaar…");
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const message = {
      type: "paypal-return",
      kind: q.get("kind") ?? "order",
      line: q.get("line") === null ? null : Number(q.get("line")),
      cancelled: q.get("cancel") === "1",
      token: q.get("token") ?? q.get("approval_token_id"),
    };
    if (window.opener) {
      window.opener.postMessage(message, window.location.origin);
      window.close();
    }
    setNote(message.cancelled ? "Cancelled. You can close this window." : "Done. You can close this window.");
  }, []);
  return (
    <main className="wrap">
      <p className="goal">{note}</p>
    </main>
  );
}
