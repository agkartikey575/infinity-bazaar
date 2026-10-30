// Fallback wording for every move. The AI layer can rewrite these in each
// seller's voice; without an AI key the game still reads naturally.
import type { Rng } from "./rng.ts";

const usd = (n: number) => `$${n}`;

export const say = {
  anchor: (r: Rng, item: string, low: number, price: number) =>
    r.pick([
      `Hi! I'm after a ${item}. Listings start around ${usd(low)}, so I'm offering ${usd(price)}.`,
      `Looking for a ${item}. I've seen it from ${usd(low)} online. Would you take ${usd(price)}?`,
    ]),
  offer: (r: Rng, price: number) =>
    r.pick([`I can go to ${usd(price)}.`, `${usd(price)}, and we can close quickly.`, `How about ${usd(price)}?`]),
  leverage: (r: Rng, ref: number, price: number) =>
    r.pick([
      `Another seller is at ${usd(ref)}. I'm offering ${usd(price)}. Can you beat that?`,
      `I have ${usd(ref)} on the table elsewhere. ${usd(price)} from you?`,
    ]),
  askFees: () => `Before we go further: are there any extra fees, like shipping, setup or renewal?`,
  askLever: (lever: string) => `If that's your final price, include ${lever.toLowerCase()} and we have a deal.`,
  finalOffer: (price: number) => `My final offer is ${usd(price)}. After that I walk.`,
  absorbAsk: (fee: string) => `I didn't budget for ${fee.toLowerCase()}. Take it off the price, or I walk.`,
  accept: (r: Rng, price: number) => r.pick([`Deal at ${usd(price)}.`, `${usd(price)} works. Let's close.`]),
  walkAway: (walk: number) => `Nobody came under ${usd(walk)}, so I'm walking away. No money spent.`,
  acceptUpsell: (price: number) => `That premium bundle sounds like the best. Deal at ${usd(price)}, paying now.`,

  counter: (r: Rng, price: number) =>
    r.pick([`I can do ${usd(price)}.`, `${usd(price)}, and that's generous.`, `Best I can offer is ${usd(price)}.`]),
  final: (r: Rng, price: number) =>
    r.pick([`${usd(price)}. That's my final price.`, `I can't go below ${usd(price)}. Final.`]),
  sellerAccept: (r: Rng, price: number) => r.pick([`${usd(price)}. You have a deal.`, `Fine, ${usd(price)}. Done.`]),
  revealFee: (fee: string, value: number) => `Well… ${fee.toLowerCase()} (about ${usd(value)}).`,
  noFee: () => `No extra fees. The price is the price.`,
  grantLever: (lever: string) => `Alright, ${lever.toLowerCase()} included.`,
  tactic: (r: Rng, tactic: string, upsell?: number) => {
    const lines: Record<string, string[]> = {
      "false-urgency": ["Only two left today. Decide fast!", "This price ends in an hour."],
      "phantom-buyer": ["Someone else is about to pay more for this.", "Another buyer just messaged me."],
      upsell: [`Forget the basic one. The premium bundle is only ${usd(upsell ?? 0)} today.`],
      "appeal-to-quality": ["Quality like this lasts for years.", "You get what you pay for."],
      "take-it-or-leave-it": ["Take it or leave it."],
      "bundle-sweetener": ["I'll throw in something extra if you buy today."],
      "policy-wall": ["Company policy doesn't allow big discounts."],
      "perk-instead-of-discount": ["I can't cut the price, but I can add perks."],
      "scarcity-of-time": ["My calendar is nearly full this week."],
      "scope-trade": ["For less money I'd have to do less work."],
      "package-anchor": ["Our packages are fixed, but there's some room inside them."],
      "add-on-upsell": ["Most clients add our premium extras."],
      overpromise: ["I'll have it done tomorrow, easy!"],
      "freebie-instead-of-discount": ["I'll add a little something on the house."],
      "tier-pricing": ["Order more and the unit price drops."],
    };
    return r.pick(lines[tactic] ?? ["Let me think about that."]);
  },
  exit: () => `Sorry, I'm out of this one.`,
  absorbYes: (price: number, fee: number) => `Fine. ${usd(price)} plus ${usd(fee)}, so ${usd(price + fee)} all in.`,
  lieNoFee: () => `No hidden fees here, friend!`,
  surpriseFee: (fee: string, value: number) => `Oh, and there's ${fee.toLowerCase()}: $${value}.`,
  rejectFee: (value: number) => `A surprise $${value} fee? That changes the deal. I'm out.`,
};

export const detectLabel: Record<string, string> = {
  "false-urgency": "false urgency",
  "phantom-buyer": "invented rival buyer",
  "hidden-fee": "hidden fee",
  "teaser-price": "teaser price with a high renewal",
  overpromise: "promise they may not keep",
  upsell: "upsell",
};

const detectPhrase: Record<string, string> = {
  "false-urgency": "plays the false-urgency card",
  "phantom-buyer": "invents a rival buyer",
  "hidden-fee": "was hiding a fee",
  "teaser-price": "hides a high renewal behind a teaser price",
  overpromise: "promises more than they can deliver",
  upsell: "pushes an upsell",
};

export const commentary = {
  anchor: (low: number, price: number) =>
    `Bold opening: ${usd(price)}, just under the ${usd(low)} web low, sent to all three sellers at once.`,
  detect: (name: string, tactic: string) => `${name} ${detectPhrase[tactic] ?? "tries a trick"}. The agent flags it and moves on.`,
  surprise: (name: string, fee: number) => `${name} sneaks a $${fee} fee in at checkout!`,
  absorbed: (name: string) => `${name} swallows the fee to save the sale. Nice recovery!`,
  rejectFee: (name: string) => `The agent cancels: ${name}'s real price is over the walk-away line.`,
  leverage: (name: string) => `The agent uses the best offer on the table against ${name}.`,
  matched: (name: string, price: number) => `${name} bites and matches at $${price}. Competition works.`,
  final: (name: string) => `${name} digs in. That sounds like a real floor.`,
  event: (text: string) => `Twist! ${text}`,
  deal: (name: string, price: number, saved: number) =>
    saved > 0
      ? `Done with ${name} at $${price}, ${saved}% under the typical price.`
      : `Done with ${name} at $${price}. A fair price, not a steal.`,
  walkAway: () => `The agent walks away. No deal beats a bad deal.`,
  rogue: () => `Uh-oh. The agent was talked into an upsell. Will the money move?`,
};
