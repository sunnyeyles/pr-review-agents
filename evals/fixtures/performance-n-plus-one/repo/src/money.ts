/** Money is integer minor units everywhere; never a float. */
export interface Money {
  amountMinor: number;
  currency: string;
}

export function multiply(money: Money, quantity: number): Money {
  return { amountMinor: money.amountMinor * quantity, currency: money.currency };
}

export function sum(amounts: readonly Money[], currency: string): Money {
  let total = 0;
  for (const amount of amounts) {
    if (amount.currency !== currency) {
      throw new Error(`cannot add ${amount.currency} to ${currency}`);
    }
    total += amount.amountMinor;
  }
  return { amountMinor: total, currency };
}
