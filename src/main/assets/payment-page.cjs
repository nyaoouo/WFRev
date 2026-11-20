"use strict"

const { randomBytes } = require("node:crypto")

const escapeHtml = text => String(text).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char])

const titles = {
    paid: "付款完成",
    canceled: "订单已取消",
    expired: "订单已过期",
    missing: "订单不存在",
}

const walletDetails = `<dl class="details">
    <div class="detail"><dt>付款方式</dt><dd>零钱</dd></div>
    <div class="detail"><dt>零钱余额</dt><dd>¥114,514.00</dd></div>
  </dl>`

function showCheckout(reply, product, state, returnUrl) {
    const nonce = randomBytes(18).toString("base64")
    const pending = state === "pending"
    const name = product ? escapeHtml(product.name) : ""
    const amount = product ? `<p class="total"><span class="currency">¥</span>${product.price.toFixed(2)}</p>` : ""
    const slots = '<span class="slot"></span>'.repeat(6)
    const keypad = [..."123456789", "clear", "0", "delete"].map(key => {
        const label = { clear: "清除", delete: "退格" }[key]
        return `<button type="button" class="key${label ? " utility" : ""}" data-key="${key}">${label ?? key}</button>`
    }).join("")

    reply.header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .header("content-security-policy", `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`)
        .type("text/html; charset=utf-8")
        .send(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>游戏收银台</title>
<style nonce="${nonce}">
    :root {
      color-scheme: light;
      font: 16px/1.5 system-ui, "PingFang TC", "Microsoft JhengHei", sans-serif;
      color: #221d33;
      background: #eeedf5;
      --accent: #5439ae;
      --accent-hover: #46308f;
      --muted: #625b70;
      --line: #e4e0ed;
      --tint: #f1ecfc;
    }

    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; }
    h1, h2, p, dl, dd { margin: 0; }
    button { font: inherit; cursor: pointer; }
    :focus-visible { outline: 3px solid #7655da; outline-offset: 3px; }
    [hidden] { display: none !important; }

    .checkout {
      display: flex;
      flex-direction: column;
      width: min(100%, 27rem);
      min-height: 100vh;
      min-height: 100svh;
      margin: auto;
      background: #faf9fd;
    }

    .topbar {
      padding: 1rem 1.25rem;
      background: #251c42;
      color: #fff;
      text-align: center;
    }

    .topbar h1 { font-size: 1.0625rem; font-weight: 680; }
    .view { display: flex; flex: 1; flex-direction: column; padding: 0 1.25rem 1rem; }

    .summary {
      padding: 1.875rem 0 1.375rem;
      text-align: center;
    }

    .game { color: var(--muted); font-size: .8125rem; }
    .product { margin-top: .375rem; font-size: 1.0625rem; font-weight: 650; }
    .total-label { margin-top: 1.375rem; color: var(--muted); font-size: .8125rem; }
    .total { font-size: 3rem; font-weight: 750; line-height: 1.12; font-variant-numeric: tabular-nums; }
    .currency { margin-right: .1em; font-size: .53em; }

    .details {
      background: #fff;
      padding: .125rem .875rem;
      border: 1px solid var(--line);
      border-radius: .875rem;
    }

    .detail {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: .75rem;
      padding: .75rem 0;
      font-size: .875rem;
    }

    .detail + .detail { border-top: 1px solid var(--line); }
    .detail dt { color: var(--muted); }
    .detail dd { font-weight: 650; text-align: right; }
    .actions { margin-top: auto; padding-top: 2.375rem; padding-bottom: env(safe-area-inset-bottom, 0px); }
    #checkoutView .actions { margin-top: 0; padding-top: .875rem; }
    .primary, .secondary {
      display: block;
      width: 100%;
      min-height: 2.875rem;
      border-radius: .625rem;
      border: 1px solid transparent;
      padding: .625rem 1rem;
      font-weight: 650;
    }

    .primary { background: var(--accent); color: #fff; }
    .primary:hover { background: var(--accent-hover); }
    .primary:active, .key:not(:disabled):active { transform: translateY(1px); }
    .secondary { margin-top: .375rem; background: transparent; color: var(--muted); }
    .secondary:hover { background: var(--tint); }

    dialog {
      width: min(calc(100% - 1.5rem), 23rem);
      max-height: calc(100dvh - 1.5rem);
      border: 1px solid var(--line);
      border-radius: 1rem;
      padding: 0;
      color: inherit;
      background: #fff;
      box-shadow: 0 16px 42px #1b123c28;
    }

    dialog::backdrop { background: #22183499; }
    @media (prefers-reduced-motion: no-preference) {
      dialog[open] { animation: dialog-enter .16s ease-out; }
      @keyframes dialog-enter {
        from { opacity: 0; transform: translateY(.375rem); }
        to { opacity: 1; transform: translateY(0); }
      }
    }
    .dialog-content { padding: 0 1.125rem 1.125rem; }
    .dialog-head {
      display: grid;
      grid-template-columns: 2.75rem minmax(0, 1fr) 2.75rem;
      align-items: center;
      gap: .5rem;
      padding: .5rem 0;
      border-bottom: 1px solid var(--line);
    }
    .dialog-head h2 { font-size: 1rem; text-align: center; }
    .close {
      flex-shrink: 0;
      width: 2.75rem;
      height: 2.75rem;
      background: var(--tint);
      color: var(--accent);
      border: 0;
      border-radius: .625rem;
      font-size: 1.5rem;
      line-height: 1;
    }
    .dialog-order { text-align: center; padding-top: .875rem; }
    .dialog-order .total { margin: .125rem 0 .25rem; font-size: 1.875rem; }
    .dialog-order .details { margin: .75rem 0; text-align: left; }
    .dialog-order .detail { padding: .5rem 0; }
    #authorize { margin-top: .875rem; }
    .slots, .keypad { display: grid; gap: .375rem; }
    .slots { grid-template-columns: repeat(6, minmax(0, 1fr)); margin: .875rem 0; }
    .slot {
      display: grid;
      place-items: center;
      min-height: 2.625rem;
      border: 1px solid var(--line);
      border-radius: .5rem;
      background: #faf8ff;
      font-size: 1.375rem;
      color: var(--accent);
    }
    .slot.current { border-color: var(--accent); background: var(--tint); }
    .keypad { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .key {
      min-height: 2.75rem;
      border: 1px solid var(--line);
      border-radius: .5rem;
      background: #f8f6fc;
      color: inherit;
      font-size: 1.125rem;
      font-weight: 650;
    }
    .key:hover, .close:hover { background: #e8defb; }
    .key:not(:disabled):active { border-color: var(--accent); background: #e3d7ff; }
    .key.utility { font-size: .8125rem; color: var(--accent); }
    .key:disabled { opacity: .48; cursor: default; }

    .result .summary { padding-top: 2.75rem; }
    .result-mark {
      display: grid;
      place-items: center;
      width: 3rem;
      height: 3rem;
      margin: 0 auto .875rem;
      border-radius: .9375rem;
      background: var(--tint);
      color: var(--accent);
      font-size: 1.5rem;
      font-weight: 750;
    }
    .result h2 { font-size: 1.25rem; }
    .result .primary {
      width: min(100%, 12rem);
      margin: 0 auto;
      border-color: var(--accent);
      background: transparent;
      color: var(--accent);
    }
    .result .primary:hover { background: var(--tint); }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }

    @media (min-width: 36rem) and (min-height: 36rem) {
      body { padding: 1.25rem; }
      .checkout {
        min-height: min(100svh - 2.5rem, 39rem);
        border: 1px solid var(--line);
        border-radius: 1rem;
        overflow: hidden;
        box-shadow: 0 14px 40px #1f153214;
      }
    }
    a.primary { text-align: center; text-decoration: none; }
    .error { margin-top: .75rem; color: #942748; font-size: .875rem; }
    .primary:disabled { opacity: .6; cursor: wait; }
</style>
</head>
<body>
<main class="checkout">
  <header class="topbar"><h1>游戏收银台</h1></header>
  ${pending ? `<section id="checkoutView" class="view" aria-label="确认订单">
    <div class="summary">
      <p class="game">世界弹射物语</p>
      <h2 class="product">${name}</h2>
      <p class="total-label">订单金额</p>
      ${amount}
    </div>
    ${walletDetails}
    <div class="actions">
      <button class="primary" id="start" type="button">立即付款</button>
      <button class="secondary" id="cancelOrder" type="button">取消订单</button>
      <p id="orderError" class="error" role="alert" hidden></p>
    </div>
  </section>` : ""}
  <section id="resultView" class="view result" aria-labelledby="resultTitle" ${pending ? "hidden" : ""}>
    <div class="summary">
      <div id="resultMark" class="result-mark" aria-hidden="true">${state === "paid" ? "✓" : "×"}</div>
      <h2 id="resultTitle" tabindex="-1">${titles[state] ?? ""}</h2>
      ${product ? `<p class="total-label">订单金额</p>${amount}` : ""}
    </div>
    ${product ? `<dl class="details">
      <div class="detail"><dt>商品</dt><dd>${name}</dd></div>
    </dl>` : ""}
    ${returnUrl ? `<div class="actions">
      <a id="return" class="primary" href="${escapeHtml(returnUrl)}">返回游戏</a>
    </div>` : ""}
  </section>
</main>
${pending ? `<dialog id="codeDialog" aria-labelledby="codeTitle">
  <div class="dialog-content">
    <header class="dialog-head">
      <button id="closeDialog" class="close" type="button" aria-label="返回订单" autofocus>×</button>
      <h2 id="codeTitle">支付</h2>
    </header>
    <div class="dialog-order">
      <p class="game">${name}</p>
      ${amount}
      ${walletDetails}
    </div>
    <button id="authorize" class="primary" type="button">确认支付</button>
    <div id="codeEntry" hidden>
      <p class="sr-only" id="codeProgress" role="status"></p>
      <div class="slots" aria-hidden="true">${slots}</div>
      <div class="keypad" id="keypad" role="group" aria-label="数字键盘">${keypad}</div>
      <p id="codeError" class="error" role="alert" hidden></p>
    </div>
  </div>
</dialog>
<script nonce="${nonce}">
  const review = document.querySelector('#checkoutView');
  const resultView = document.querySelector('#resultView');
  const resultTitle = document.querySelector('#resultTitle');
  const resultMark = document.querySelector('#resultMark');
  const returnLink = document.querySelector('#return');
  const start = document.querySelector('#start');
  const cancel = document.querySelector('#cancelOrder');
  const dialog = document.querySelector('#codeDialog');
  const close = document.querySelector('#closeDialog');
  const title = document.querySelector('#codeTitle');
  const authorize = document.querySelector('#authorize');
  const codeEntry = document.querySelector('#codeEntry');
  const progress = document.querySelector('#codeProgress');
  const slots = [...document.querySelectorAll('.slot')];
  const keypad = document.querySelector('#keypad');
  const buttons = [...document.querySelectorAll('button')];
  const embedded = new URLSearchParams(location.search).get('embedded') === '1';
  const messages = {
    paid: '付款完成',
    canceled: '订单已取消',
    expired: '订单已过期',
    missing: '订单不存在',
  };
  let code = '';
  let submitting = false;

  function renderCode() {
    slots.forEach((slot, index) => {
      slot.textContent = index < code.length ? '•' : '';
      slot.classList.toggle('current', index === code.length);
    });
    progress.textContent = submitting ? '正在确认订单' : '已输入 ' + code.length + ' 位数字';
    buttons.forEach(button => {
      button.disabled = submitting || (button.classList.contains('utility') && !code);
    });
  }

  function setError(element, message) {
    element.textContent = message;
    element.hidden = !message;
  }

  async function submit(action, closeAfter = false) {
    if (submitting) return;
    submitting = true;
    renderCode();
    const notice = document.querySelector(action === 'confirm' ? '#codeError' : '#orderError');
    setError(notice, '');
    try {
      const response = await fetch(location.pathname + '/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'confirm' ? { code } : {}),
      });
      const result = await response.json();
      if (result.state === 'pending') {
        setError(notice, result.message);
        return;
      }
      if (!Object.hasOwn(messages, result.state)) throw new Error('Unknown order state');

      if (dialog.open) dialog.close();
      review.hidden = true;
      resultTitle.textContent = messages[result.state];
      resultMark.textContent = result.state === 'paid' ? '✓' : '×';
      resultView.hidden = false;
      resultTitle.focus();

      // The backend checks settlement before it redirects to the app.
      if (closeAfter || (result.state === 'paid' && (embedded || navigator.userActivation?.isActive))) {
        location.assign(returnLink.href);
      }
    } catch {
      setError(notice, '暂时无法确认订单，请重试。');
    } finally {
      code = '';
      submitting = false;
      renderCode();
    }
  }

  function handleKey(key) {
    if (submitting) return;
    if (key === 'delete') code = code.slice(0, -1);
    else if (key === 'clear') code = '';
    else code += key;
    renderCode();
    if (code.length === slots.length) submit('confirm');
  }

  start.addEventListener('click', () => {
    code = '';
    title.textContent = '支付';
    authorize.hidden = false;
    codeEntry.hidden = true;
    setError(document.querySelector('#codeError'), '');
    renderCode();
    dialog.showModal();
  });
  authorize.addEventListener('click', () => {
    title.textContent = '输入六位测试码';
    authorize.hidden = true;
    codeEntry.hidden = false;
    keypad.querySelector('button').focus();
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => {
    if (submitting) event.preventDefault();
  });
  dialog.addEventListener('close', () => { code = ''; });
  keypad.addEventListener('click', event => {
    const button = event.target.closest('button[data-key]');
    if (button) handleKey(button.dataset.key);
  });
  dialog.addEventListener('keydown', event => {
    if (codeEntry.hidden || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Backspace' || /^[0-9]$/.test(event.key)) {
      event.preventDefault();
      if (!event.repeat) handleKey(event.key === 'Backspace' ? 'delete' : event.key);
    }
  });
  cancel.addEventListener('click', () => submit('cancel'));
  window.addEventListener('starpointcheckoutback', event => {
    if (submitting) {
      event.preventDefault();
    } else if (dialog.open) {
      event.preventDefault();
      dialog.close();
    } else if (!review.hidden) {
      event.preventDefault();
      submit('cancel', true);
    }
  });
</script>` : state === "paid" && returnUrl ? `<script nonce="${nonce}">
  if (new URLSearchParams(location.search).get('embedded') === '1') {
    location.assign(document.querySelector('#return').href);
  }
</script>` : ""}
</body>
</html>`)
}

module.exports = { showCheckout }
