// Shapes of the data files in /data and of what the engine produces.

export type GroupId = "online" | "design" | "gear" | "freelancers" | "fun";
export type Delivery = "instant" | "shipped" | "service";
export type Concession = "slow" | "medium" | "fast";

export interface Lever {
  id: string;
  label: string;
  valueUsd: number;
  /** For hidden fees: true when charged at checkout, false for a later cost such as a renewal. */
  payNow?: boolean;
}

export interface CatalogItem {
  id: string;
  name: string;
  /** How the item reads mid-sentence, e.g. "a USB microphone". */
  phrase: string;
  group: GroupId;
  unit: string;
  description: string;
  delivery: Delivery;
  paypalFlow: "capture_now" | "authorize_then_capture_on_delivery";
  price: { currency: "USD"; low: number; typical: number; high: number; confidence: string };
  verifyQuery: string;
  seller: { costProfile: string; costShare: [number, number]; minMargin: number; floorRange: [number, number] };
  sellerTypes: string[];
  levers: Lever[];
  hiddenFees: Lever[];
}

export interface Catalog {
  version: number;
  groups: { id: GroupId; name: string }[];
  items: CatalogItem[];
}

export interface Archetype {
  id: string;
  label: string;
  names: string[];
  voice: string;
  openMarkup: [number, number];
  concession: Concession;
  floorBias: number;
  tactics: string[];
  softSpots: string[];
  reliability: number;
}

export interface SellerData {
  archetypes: Archetype[];
  tactics: Record<string, string>;
  detectable: string[];
  concessionSpeed: Record<Concession, [number, number]>;
}

export interface GameEvent {
  id: string;
  label: string;
  text: string;
  weight: number;
  appliesTo?: string[];
  appliesToDelivery?: Delivery[];
  afterPayment?: boolean;
  effect: { type: string; [key: string]: unknown };
}

export interface MissionItem {
  item: string;
  priority: "core" | "nice";
  itemCapUsd: number;
}

export interface Mission {
  id: string;
  title: string;
  goal: string;
  budgetUsd: number;
  askAboveUsd: number;
  allowedGroups: GroupId[];
  suggested: MissionItem[];
  reserveShare: number;
}

/** What a seller remembers about this buyer across deals, keyed by seller name. */
export type SellerMemory = Record<string, { lowballs: number; deals: number }>;

export interface Seller {
  id: string;
  name: string;
  archetype: Archetype;
  /** Hidden lowest price. Never shown to the buyer during the deal. */
  floor: number;
  ask: number;
  reliability: number;
  active: boolean;
  final: boolean;
  concessionBoost: number;
  mood: number;
  insulted: boolean;
  fee: Lever | null;
  feeRevealed: boolean;
  levers: Lever[];
  leverAsked: boolean;
  upsellPrice: number | null;
  usedTactics: string[];
  /** Price this seller has agreed to, if they accepted an offer. */
  agreedAt: number | null;
}

export interface BuyerPlan {
  anchor: number;
  target: number;
  walkAway: number;
  /** Planned offers, rising in shrinking steps from anchor to walkAway. */
  offers: number[];
}

export type Beat =
  | {
      kind: "agent";
      round: number;
      to: string[];
      move: "anchor" | "offer" | "leverage" | "ask-fees" | "ask-lever" | "accept" | "walk-away" | "accept-upsell" | "reject-fee" | "absorb-fee" | "decline" | "explain" | "priced-out";
      price?: number;
      refPrice?: number;
      text: string;
    }
  | {
      kind: "seller";
      round: number;
      sellerId: string;
      move: "counter" | "final" | "accept" | "reveal-fee" | "no-fee" | "grant-lever" | "tactic" | "exit" | "surprise-fee" | "absorb-fee" | "lost";
      price?: number;
      tactic?: string;
      lever?: Lever;
      text: string;
    }
  | { kind: "detect"; round: number; sellerId: string; tactic: string; text: string }
  | { kind: "event"; round: number; eventId: string; sellerId: string; text: string }
  | { kind: "commentary"; round: number; text: string };

export interface DealOutcome {
  status: "deal" | "walk-away";
  rounds: number;
  sellerId?: string;
  sellerName?: string;
  price?: number;
  /** Hidden fee charged at checkout, added to the payment. */
  fee: number;
  /** Hidden fee that comes later, such as a renewal. Not paid now. */
  futureFee: number;
  /** True when the fee was only found at checkout. */
  surpriseFee?: boolean;
  /** Extras won instead of a lower price. */
  levers: Lever[];
  /** price + fee now + later fee: what the deal really costs. */
  effectiveCost?: number;
  /** Amount PayPal is asked to move: price + fee. */
  amountToPay?: number;
  savedVsTypical?: number;
  /** True when the agent was talked into an upsell (rogue demo). */
  rogue?: boolean;
  /** An event that happens after payment, such as a failed delivery. */
  afterPayment: { eventId: string; text: string } | null;
}

export interface DealResult {
  itemId: string;
  seed: number;
  plan: BuyerPlan;
  sellers: { id: string; name: string; archetype: string; floor: number; openAsk: number; finalAsk: number; active: boolean }[];
  beats: Beat[];
  outcome: DealOutcome;
  memory: SellerMemory;
}
