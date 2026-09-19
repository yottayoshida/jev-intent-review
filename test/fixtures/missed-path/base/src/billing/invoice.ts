export interface LineItem {
  description: string;
  quantity: number;
  unitPrice: number;
}

export function invoiceTotal(items: LineItem[], taxRate: number): number {
  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  return Math.round(subtotal * (1 + taxRate) * 100) / 100;
}
