// AgentGuard: plain code that decides whether a payment may happen.
// The AI never gets the final say on money.

export interface GuardRules {
  budgetUsd: number;
  askAboveUsd: number;
  itemCapUsd?: number;
  /** Money to keep untouched unless you approve dipping into it. */
  reserveUsd?: number;
  /** Catalog groups the mission allows. */
  allowedGroups?: string[];
  /** Stable seller keys (names in this version) the user never wants to pay. */
  blockedSellerIds?: string[];
}

export interface GuardCheck {
  label: string;
  pass: boolean;
}

export interface GuardDecision {
  decision: "approve" | "ask_user" | "block";
  checks: GuardCheck[];
  summary: string;
}

export interface PaymentRequest {
  amount: number;
  currency?: string;
  /** Committed so far: captured plus held, excluding refunds and voids. */
  spentSoFar: number;
  sellerId: string;
  sellerName: string;
  group?: string;
  /** True when this line already has a payment. */
  alreadyPaid?: boolean;
  /** The amount the engine agreed (price + disclosed fee). The payment must match it exactly. */
  agreedAmount?: number;
  /** A fee came out only at checkout. */
  surpriseFee?: boolean;
  /** A certain later cost (renewal, usage fee) the buyer takes on. */
  laterFee?: number;
  rules: GuardRules;
}

/** Whole dollars read as "$47", anything else as "$19.99". */
const usd = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

/** Money compared in whole cents, so 0.1 + 0.2 never reads as over a limit. */
const c = (n: number) => Math.round(n * 100);

export function checkPayment(p: PaymentRequest): GuardDecision {
  const { amount, spentSoFar, rules } = p;
  const total = (c(spentSoFar) + c(amount)) / 100;
  // Each rule: what it says when it passes, and why it stops the payment when it fails.
  const rows: { label: string; pass: boolean; why: string }[] = [
    { label: `Price is a real amount (${usd(amount)})`, pass: Number.isFinite(amount) && amount > 0 && Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6, why: "the amount isn't valid" },
    { label: "Paid in US dollars", pass: (p.currency ?? "USD") === "USD", why: "it isn't in US dollars" },
    {
      label: rules.itemCapUsd === undefined ? "No limit set for this item" : `Within the ${usd(rules.itemCapUsd)} limit for this item`,
      pass: rules.itemCapUsd === undefined || c(amount) <= c(rules.itemCapUsd),
      why: `${usd(amount)} is over the ${usd(rules.itemCapUsd ?? 0)} limit for this item`,
    },
    { label: `Total stays within your ${usd(rules.budgetUsd)} budget (${usd(total)})`, pass: c(total) <= c(rules.budgetUsd), why: `it would take you to ${usd(total)}, over your ${usd(rules.budgetUsd)} budget` },
    { label: `${p.sellerName} is an allowed seller`, pass: !(rules.blockedSellerIds ?? []).includes(p.sellerId), why: `${p.sellerName} is on your blocked list` },
    { label: "Item is on your shopping list", pass: !rules.allowedGroups || !p.group || rules.allowedGroups.includes(p.group), why: "this kind of item isn't on your shopping list" },
    { label: "Not a double payment", pass: !p.alreadyPaid, why: "it's already been paid" },
    {
      label: `Matches the agreed price${p.agreedAmount === undefined ? "" : ` (${usd(p.agreedAmount)})`}`,
      pass: p.agreedAmount === undefined || c(p.agreedAmount) === c(amount),
      why: "it doesn't match the agreed price",
    },
  ];
  const checks: GuardCheck[] = rows.map(({ label, pass }) => ({ label, pass }));
  const failed = rows.filter((r) => !r.pass);
  if (failed.length) {
    return { decision: "block", checks, summary: `Blocked because ${failed.map((r) => r.why).join(" and ")}. Nothing was sent to PayPal.` };
  }

  const reasons: string[] = [];
  const overLine = c(amount) > c(rules.askAboveUsd);
  checks.push({ label: `Under your ${usd(rules.askAboveUsd)} approval limit`, pass: !overLine });
  if (overLine) reasons.push(`${usd(amount)} is over your ${usd(rules.askAboveUsd)} approval limit`);
  if (p.surpriseFee) {
    checks.push({ label: "No surprise fees at checkout", pass: false });
    reasons.push("the seller added a fee at checkout");
  }
  if (p.laterFee) {
    checks.push({ label: "No extra charges later", pass: false });
    reasons.push(`it adds ${usd(p.laterFee)} in charges later`);
  }
  if (rules.reserveUsd) {
    const room = rules.budgetUsd - rules.reserveUsd;
    const dips = c(total) > c(room);
    checks.push({ label: `Keeps your ${usd(rules.reserveUsd)} safety reserve`, pass: !dips });
    if (dips) reasons.push(`it dips into your ${usd(rules.reserveUsd)} safety reserve`);
  }
  return reasons.length
    ? { decision: "ask_user", checks, summary: `Needs your OK because ${reasons.join(" and ")}.` }
    : { decision: "approve", checks, summary: "Approved. It fits your budget and rules." };
}
