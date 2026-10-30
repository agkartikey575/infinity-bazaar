# Infinity Bazaar ∞

Give an AI agent a goal and a budget. It picks what to buy from a catalog, negotiates with three AI sellers at once, plays them against each other, and pays through PayPal. **AgentGuard**, plain code rather than AI, checks every payment against the rules you set.

Built for the PayPal AI Hackathon 2026.

## What works today

- **Catalog data** (`data/`): 40 items, 10 seller personalities, 10 random events, 3 missions.
- **Negotiation engine** (`src/engine/`): anchoring, a walk-away price, shrinking concessions, leverage between sellers, fee checks, trading for extras, trick detection, seller memory and random events. Seeded, so any run can be replayed.
- **AgentGuard** (`src/engine/guard.ts`): item caps, total budget, blocked sellers, and an ask-me-first line.

## Try it

Requires Node.js 22.18 or newer. No API keys needed.

```bash
npm install
npm run demo          # a full "hackathon in 10 days, $300" mission
npm run demo:rogue    # the agent falls for an upsell; AgentGuard blocks it
npm test
```

## Coming next

The deal room web app, the AI voice for each seller, and PayPal sandbox payments (authorize, capture on delivery, refund).

## License

MIT
