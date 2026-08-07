import { useState } from 'react';
import { CartSummary } from './components/CartSummary';
import type { CartLine } from './lib/pricing';

const LINES: CartLine[] = [
  { sku: 'A-1', name: '机械键盘', unitPrice: 499, quantity: 1 },
  { sku: 'B-2', name: '桌垫', unitPrice: 89, quantity: 2 },
];

export function App() {
  const [code, setCode] = useState<string | null>(null);

  return (
    <main>
      <h1>购物车</h1>
      <ul>
        {LINES.map((line) => (
          <li key={line.sku}>
            {line.name} × {line.quantity}
          </li>
        ))}
      </ul>
      <input
        placeholder="折扣码"
        onChange={(e) => setCode(e.target.value || null)}
        value={code ?? ''}
      />
      <CartSummary lines={LINES} discountCode={code} />
    </main>
  );
}
