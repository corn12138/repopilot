import { applyDiscount, formatMoney, subtotalOf, type CartLine } from '../lib/pricing';

interface Props {
  lines: CartLine[];
  discountCode: string | null;
}

export function CartSummary({ lines, discountCode }: Props) {
  const subtotal = subtotalOf(lines);
  const total = applyDiscount(subtotal, discountCode);

  return (
    <section className="cart-summary">
      <h2>订单摘要</h2>
      <dl>
        <dt>小计</dt>
        <dd>{formatMoney(subtotal)}</dd>
        <dt>合计</dt>
        <dd>{formatMoney(total)}</dd>
      </dl>
    </section>
  );
}
