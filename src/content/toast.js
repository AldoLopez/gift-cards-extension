// Corner reminder on merchant sites. Injected as a classic script, so it can't
// import modules. It only ever receives card numbers after a Copy click.

(async () => {
  if (window.top !== window) return;

  const send = async (message) => {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error ?? 'unexpected');
    return response.data;
  };

  let visit;
  try {
    visit = await send({ type: 'page/visit' });
  } catch {
    return;
  }
  if (!visit.show) return;

  const money = (cents) => `$${Math.floor(cents / 100).toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`;
  const parseDollars = (value) => {
    const text = value.trim().replace(/^\$/, '').replace(/,/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
    const [whole, fraction = ''] = text.split('.');
    return Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  };
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });

  const style = el('style');
  style.textContent = `
    :host { color-scheme: light; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .toast { width: 300px; max-width: calc(100vw - 40px); background: #1d2a8f; color: #fff; border-radius: 14px;
      padding: 16px; font: 14px/1.4 system-ui, sans-serif; box-shadow: 0 12px 32px rgb(16 22 80 / .35); }
    .head { display: flex; justify-content: space-between; align-items: start; gap: 8px; }
    .lead { margin: 0; font-size: 15px; }
    .amount { display: block; font-size: 28px; font-weight: 700; line-height: 1.15; font-variant-numeric: tabular-nums; }
    .close { all: unset; cursor: pointer; width: 24px; height: 24px; text-align: center; border-radius: 6px; font-size: 18px; line-height: 24px; flex: none; }
    .row { margin-top: 12px; padding-top: 10px; border-top: 1px solid rgb(255 255 255 / .22); }
    .row-top { display: flex; justify-content: space-between; gap: 8px; }
    .age { color: #c9d0ff; font-size: 12px; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; align-items: center; }
    button.act, a.act { all: unset; cursor: pointer; font-size: 13px; padding: 4px 10px; border-radius: 7px; background: #c3c8d6; color: #161d5e; }
    a.act { background: transparent; color: #fff; text-decoration: underline; padding: 4px 2px; }
    input { width: 86px; padding: 4px 6px; border-radius: 6px; border: 0; font: inherit; font-size: 13px; }
    .msg { font-size: 12px; color: #ffe08a; margin-top: 6px; }
    .close:focus-visible, button.act:focus-visible, a.act:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  `;

  const toast = el('section', 'toast');
  toast.setAttribute('aria-label', 'Gift card reminder');

  const head = el('div', 'head');
  const lead = el('p', 'lead', `You have gift card money at ${visit.merchantName}`);
  const close = el('button', 'close', '×');
  close.setAttribute('aria-label', 'Dismiss');
  close.addEventListener('click', () => host.remove());
  head.append(lead, close);
  toast.append(head, el('span', 'amount', money(visit.totalCents)));

  const ageText = (days) => {
    if (days === 0) return 'Balance confirmed today';
    return `Balance confirmed ${days} day${days === 1 ? '' : 's'} ago`;
  };
  const errorText = (error) =>
    error.message === 'locked' ? 'Unlock your codes from the extension icon first.' : 'That didn\'t work. Try it from the extension icon.';

  const visible = visit.cards.slice(0, 3);
  for (const card of visible) {
    const row = el('div', 'row');
    const top = el('div', 'row-top');
    const name = card.label || (card.last4 ? `Ending ${card.last4}` : 'Gift card');
    const balance = el('strong', '', money(card.balanceCents));
    top.append(el('span', '', name), balance);
    const actions = el('div', 'actions');
    const message = el('div', 'msg');
    message.hidden = true;
    const say = (text) => {
      message.textContent = text;
      message.hidden = false;
    };

    if (card.hasCode) {
      const copy = el('button', 'act', 'Copy code');
      copy.addEventListener('click', async (event) => {
        if (!event.isTrusted) return;
        try {
          const code = await send({ type: 'page/getCode', cardId: card.id });
          await navigator.clipboard.writeText(code.number || code.pin);
          say('Code copied.');
          if (code.number && code.pin && !actions.querySelector('[data-pin]')) {
            const pin = el('button', 'act', 'Copy PIN');
            pin.dataset.pin = '1';
            pin.addEventListener('click', async () => {
              await navigator.clipboard.writeText(code.pin);
              say('PIN copied.');
            });
            actions.insertBefore(pin, copy.nextSibling);
          }
        } catch (error) {
          say(errorText(error));
        }
      });
      actions.append(copy);
    }

    const update = el('button', 'act', 'Update balance');
    update.addEventListener('click', () => {
      const input = el('input');
      input.inputMode = 'decimal';
      input.setAttribute('aria-label', 'New balance in dollars');
      input.value = (card.balanceCents / 100).toFixed(2);
      const save = el('button', 'act', 'Save');
      save.addEventListener('click', async () => {
        const cents = parseDollars(input.value);
        if (cents === null) return say('Enter an amount like 25.00.');
        try {
          await send({ type: 'page/setBalance', cardId: card.id, cents });
          balance.textContent = money(cents);
          say('Balance saved.');
          input.remove();
          save.remove();
          update.hidden = false;
        } catch (error) {
          say(errorText(error));
        }
      });
      update.hidden = true;
      actions.append(input, save);
      input.focus();
    });
    actions.append(update);

    row.append(top, el('div', 'age', ageText(card.confirmedDaysAgo)), actions, message);
    toast.append(row);
  }

  if (visit.cards.length > visible.length) {
    const more = visit.cards.length - visible.length;
    toast.append(el('div', 'age', `${more} more in the extension`));
  }

  if (visit.balanceUrl) {
    const actions = el('div', 'actions');
    const link = el('a', 'act', 'Check balance on their site');
    link.href = visit.balanceUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    actions.append(link);
    toast.append(actions);
  }

  root.append(style, toast);
  document.documentElement.append(host);
})();
