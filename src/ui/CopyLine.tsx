"use client";

import { useState } from "react";

/** A command a judge can copy with one tap. */
export function CopyLine({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="mt-3 flex items-stretch rounded-xl border-2 border-ink overflow-hidden bg-ink text-paper">
      <code className="flex-1 px-4 py-3 text-sm overflow-x-auto whitespace-nowrap">{text}</code>
      <button
        type="button"
        onClick={async () => {
          try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500); } catch {}
        }}
        className="px-4 font-bold bg-amber text-ink shrink-0">
        {ok ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
