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
  rules: GuardRules;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export function checkPayment(p: PaymentRequest): GuardDecision {
  const { amount, spentSoFar, rules } = p;
  const total = spentSoFar + amount;
  const checks: GuardCheck[] = [
    { label: `${usd(amount)} is a valid amount in whole cents`, pass: Number.isFinite(amount) && amount > 0 && Math.round(amount * 100) === amount * 100 },
    { label: `currency is USD`, pass: (p.currency ?? "USD") === "USD" },
    { label: `${usd(amount)} ≤ item cap ${rules.itemCapUsd === undefined ? "(none)" : usd(rules.itemCapUsd)}`, pass: rules.itemCapUsd === undefined || amount <= rules.itemCapUsd },
    { label: `total ${usd(total)} ≤ budget ${usd(rules.budgetUsd)}`, pass: total <= rules.budgetUsd },
    { label: `${p.sellerName} is an allowed seller`, pass: !(rules.blockedSellerIds ?? []).includes(p.sellerId) },
    { label: `item category is allowed`, pass: !rules.allowedGroups || !p.group || rules.allowedGroups.includes(p.group) },
    { label: `not already paid`, pass: !p.alreadyPaid },
  ];
  if (checks.some((c) => !c.pass)) {
    const failed = checks.filter((c) => !c.pass).map((c) => c.label);
    return { decision: "block", checks, summary: `BLOCKED: failed ${failed.join("; ")}. No call to PayPal was made.` };
  }

  const reasons: string[] = [];
  const overLine = amount > rules.askAboveUsd;
  checks.push({ label: `${usd(amount)} ≤ ask-me line ${usd(rules.askAboveUsd)}`, pass: !overLine });
  if (overLine) reasons.push(`${usd(amount)} is above your ${usd(rules.askAboveUsd)} ask-me line`);
  if (rules.reserveUsd) {
    const room = rules.budgetUsd - rules.reserveUsd;
    const dips = total > room;
    checks.push({ label: `keeps the ${usd(rules.reserveUsd)} reserve`, pass: !dips });
    if (dips) reasons.push(`it dips into your ${usd(rules.reserveUsd)} reserve`);
  }
  return reasons.length
    ? { decision: "ask_user", checks, summary: `ASKING YOU: ${reasons.join(" and ")}.` }
    : { decision: "approve", checks, summary: `APPROVED: all checks passed.` };
}
