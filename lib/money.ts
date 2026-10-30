// Money in integer cents. The engine negotiates in whole dollars; everything
// that touches a payment converts here, once.

export type Cents = number & { readonly __brand: "cents" };

export const toCents = (usd: number): Cents => Math.round(usd * 100) as Cents;
export const toUsd = (c: Cents): number => c / 100;
/** PayPal's amount format: a string with two decimals. */
export const toValue = (c: Cents): string => (c / 100).toFixed(2);
export const fmt = (c: Cents): string => `$${toValue(c)}`;
