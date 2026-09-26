/**
 * The physical items on our demo table. The pickup page's listing picker and the agent's free-text checkout use
 * exactly these; any other purchase must name a catalog listing, which is pre-screened on the server.
 */
export const DEMO_TABLE = [
  { label: "Harppa high chair (table prop with the printed CPSC 26-061 label)", amountUsd: 64 },
  // not $40.00: the sandbox simulator returns AVS_FAILED / PENDING_REVIEW for that exact amount
  { label: "Used baby item from our table", amountUsd: 45 },
] as const;
