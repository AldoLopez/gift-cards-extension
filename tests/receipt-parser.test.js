import { describe, expect, it } from 'vitest';
import { bodyToText, parseReceipt, stripHtml } from '../src/lib/receipt-parser.js';

const receipt = (lines, subject = 'Your order confirmation') => parseReceipt({ subject, text: lines.join('\n') });

describe('gift card payments', () => {
  it('reads a negative amount on the same line', () => {
    const r = receipt(['Order #112-3345566', 'Subtotal: $40.00', 'Gift Card Amount: -$25.00', 'Order Total: $43.20']);
    expect(r.kind).toBe('purchase');
    expect(r.giftCards).toEqual([{ cents: 2500, last4: '' }]);
    expect(r.totalCents).toBe(4320);
    expect(r.orderNumber).toBe('112-3345566');
  });

  it('reads parentheses as a deduction', () => {
    expect(receipt(['Thanks for your order', 'Gift card ($12.50)', 'Total $20.00']).giftCards[0].cents).toBe(1250);
  });

  it('reads an amount on the next line', () => {
    expect(receipt(['Your order', 'Gift Card Applied', '-$10.00', 'Total', '$5.00']).giftCards[0].cents).toBe(1000);
  });

  it('captures the last 4 digits', () => {
    expect(receipt(['Order total: $30.00', 'Gift card ending in 4321: $30.00']).giftCards).toEqual([{ cents: 3000, last4: '4321' }]);
    expect(receipt(['Order total: $30.00', 'GiftCard ****9876 applied $5.00']).giftCards).toEqual([{ cents: 500, last4: '9876' }]);
  });

  it('accepts a positive amount inside a payment section', () => {
    expect(receipt(['Your receipt', 'Payment method', 'Gift Card $15.00', 'Total $15.00']).giftCards[0].cents).toBe(1500);
  });

  it('collapses a payment repeated in two sections', () => {
    const r = receipt(['Order total $30.00', 'Gift card applied -$30.00', 'Payment details', 'Gift card ending 1111 -$30.00']);
    expect(r.giftCards).toEqual([{ cents: 3000, last4: '1111' }]);
  });

  it('keeps two different cards', () => {
    const r = receipt(['Order total $30.00', 'Gift card ending 1111 -$10.00', 'Gift card ending 2222 -$20.00']);
    expect(r.giftCards).toHaveLength(2);
  });

  it('does not count a remaining balance as spending', () => {
    const r = receipt(['Order total $30.00', 'Remaining gift card balance: $12.00']);
    expect(r.giftCards).toEqual([]);
  });

  it('does not count buying a gift card as paying with one', () => {
    const r = receipt(['Your order', 'Target Gift Card - $50.00', 'Qty 1', 'Order total: $50.00']);
    expect(r.giftCards).toEqual([]);
  });

  it('does not count gift card marketing lines', () => {
    expect(receipt(['Your order', 'Order total: $50.00', 'Buy a gift card and get $10 off']).giftCards).toEqual([]);
  });
});

describe('order totals', () => {
  it('prefers order total over subtotal and savings', () => {
    expect(receipt(['Your order', 'Subtotal $40.00', 'Total savings $5.00', 'Grand Total $1,043.20']).totalCents).toBe(104320);
  });

  it('ignores a zero amount due and finds the real total', () => {
    expect(receipt(['Your receipt', 'Amount due $0.00', 'Total $18.00']).totalCents).toBe(1800);
  });
});

describe('emails that are not purchases', () => {
  it.each(['Your order has shipped', 'Your package was delivered', 'Your refund for order 12345', '25% off this weekend', 'You received a gift card', 'Your order is on its way'])(
    'ignores subject: %s',
    (subject) => {
      expect(receipt(['Order total: $30.00', 'Gift card applied -$5.00'], subject).kind).toBe('ignore');
    },
  );

  it('ignores an email with no amounts', () => {
    expect(receipt(['Your order was received']).kind).toBe('ignore');
  });

  it('ignores a total with no sign of a purchase', () => {
    expect(parseReceipt({ subject: 'Hello there', text: 'Total $5.00' }).kind).toBe('ignore');
  });
});

describe('order numbers', () => {
  it('skips words after "order" and requires a digit', () => {
    expect(receipt(['Order confirmation', 'Order number: W123456789', 'Total $5.00']).orderNumber).toBe('W123456789');
  });

  it('returns null when none is present', () => {
    expect(receipt(['Order confirmation', 'Total $5.00']).orderNumber).toBeNull();
  });
});

describe('HTML receipts', () => {
  const html = `<html><head><style>.a{color:red}</style></head><body>
    <table><tr><td>Gift Card</td><td>&minus;&#36;25.00</td></tr>
    <tr><td>Order&nbsp;Total</td><td>$40.00</td></tr></table><script>var total = "$999.00";</script></body></html>`;

  it('keeps table rows on one line and drops scripts and styles', () => {
    const text = stripHtml(html);
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('999');
    const r = parseReceipt({ subject: 'Your receipt', text });
    expect(r.giftCards[0].cents).toBe(2500);
    expect(r.totalCents).toBe(4000);
  });

  it('prefers HTML when the plain part has no amounts', () => {
    expect(bodyToText({ plain: 'View this email in a browser', html: '<p>Total $5.00</p>' })).toContain('$5.00');
    expect(bodyToText({ plain: 'Total $7.00', html: '<p>Total $5.00</p>' })).toBe('Total $7.00');
  });
});
