// Not imported anywhere: a debug leftover for the action smoke test.
export function total(items: { price: number; qty: number }[]): number {
  console.log("DEBUG items", items);
  // return items.reduce((a, b) => a + b.price, 0);
  return items.reduce((a, b) => a + b.price * b.qty, 0);
}
