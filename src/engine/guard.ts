// AgentGuard: plain code that decides whether a payment may happen.
// The AI never gets the final say on money.

export interface GuardRules {
  budgetUsd: number;
  askAboveUsd: number;
  itemCapUsd?: number;
  blockedSellers?: string[];
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

export function checkPayment(p: { amount: number; spentSoFar: number; sellerName: string; rules: GuardRules }): GuardDecision {
  const { amount, spentSoFar, sellerName, rules } = p;
  const total = spentSoFar + amount;
  const checks: GuardCheck[] = [
    { label: `$${amount} is a positive amount`, pass: amount > 0 && Number.isFinite(amount) },
    { label: `$${amount} ≤ item cap $${rules.itemCapUsd ?? "none"}`, pass: rules.itemCapUsd === undefined || amount <= rules.itemCapUsd },
    { label: `total $${total} ≤ budget $${rules.budgetUsd}`, pass: total <= rules.budgetUsd },
    { label: `${sellerName} is an allowed seller`, pass: !(rules.blockedSellers ?? []).includes(sellerName) },
  ];
  if (checks.some((c) => !c.pass)) {
    const failed = checks.filter((c) => !c.pass).map((c) => c.label);
    return { decision: "block", checks, summary: `BLOCKED: failed ${failed.join("; ")}. No call to PayPal was made.` };
  }
  const needsOk = amount > rules.askAboveUsd;
  checks.push({ label: `$${amount} ≤ ask-me line $${rules.askAboveUsd}`, pass: !needsOk });
  return needsOk
    ? { decision: "ask_user", checks, summary: `ASKING YOU: $${amount} is above your $${rules.askAboveUsd} ask-me line.` }
    : { decision: "approve", checks, summary: `APPROVED: all checks passed.` };
}
