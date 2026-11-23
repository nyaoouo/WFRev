"use strict"

const path = require("node:path")
const { randomBytes } = require("node:crypto")

const pagePath = "/admin/pack-limits/"
const entryPath = "/admin/pack-limits-entry.js"
const apiPath = "/pack-limits/:playerId"

const entryScript = `(() => {
    function attach() {
        const header = document.querySelector('.admin-topbar');
        if (!header || document.getElementById('pack-limits-entry')) return;
        const link = document.createElement('a');
        link.id = 'pack-limits-entry';
        link.className = 'ant-btn ant-btn-default';
        link.style.color = 'inherit';
        link.textContent = '礼包限额';
        link.href = '${pagePath}';
        const actions = header.querySelector('.ant-space');
        header.insertBefore(link, actions);
    }
    new MutationObserver(attach).observe(document.body, { childList: true, subtree: true });
    attach();
})();`

function renderQuotaAdmin(reply) {
    const nonce = randomBytes(18).toString("base64")
    return reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer")
        .header("content-security-policy", `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`)
        .type("text/html; charset=utf-8")
        .send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>礼包限额</title>
<style nonce="${nonce}">
  :root { font: 16px/1.5 system-ui,sans-serif; color: #1c2940; background: #f3f6fa; }
  * { box-sizing: border-box; } body { margin: 0; } h1 { margin: .3rem 0 1rem; font-size: 1.45rem; }
  main { margin: auto; width: min(100%, 58rem); padding: 1.25rem; }
  a { color: #175fb4; } section, form { background: white; border: 1px solid #dbe2ef; border-radius: .7rem; padding: .9rem; }
  form { display: flex; flex-wrap: wrap; align-items: center; gap: .55rem; }
  input, button { min-height: 2.65rem; font: inherit; padding: .45rem .7rem; border: 1px solid #aabbd1; border-radius: .42rem; }
  input { flex: 1; min-width: 6rem; color: inherit; background: white; }
  button { background: #135cac; color: white; border-color: #135cac; cursor: pointer; }
  button:disabled { background: #eef1f5; border-color: #e0e5ee; color: #56647a; cursor: default; }
  #status { margin: .7rem 0; color: #315277; } #status:empty { display: none; }
  #player-name { font-size: 1.1rem; margin: 0 0 .55rem; }
  ul { padding: 0; margin: 0; list-style: none; }
  li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: .65rem; padding: .65rem 0; }
  li + li { border-top: 1px solid #e7edf4; } small { display: block; color: #526277; }
  .count { font-variant-numeric: tabular-nums; white-space: nowrap; }
  li button { background: white; color: #135cac; }
  :focus-visible { outline: 2px solid #1366c1; outline-offset: 2px; }
  @media (max-width: 29rem) { main { padding: .85rem; } li { grid-template-columns: minmax(0,1fr) auto; } li button { grid-column: 2; } }
</style></head><body><main>
  <a href="/admin/">返回管理后台</a><h1>礼包限额</h1>
  <form id="choose-player"><label for="player-id">玩家编号</label><input id="player-id" required inputmode="numeric" pattern="[1-9][0-9]*" list="players"><datalist id="players"></datalist><button>查看礼包</button></form>
  <p id="status" role="status"></p>
  <section id="details" aria-labelledby="player-name" hidden><h2 id="player-name"></h2><ul id="offers"></ul></section>
</main><script nonce="${nonce}">
  const form = document.querySelector('#choose-player');
  const input = document.querySelector('#player-id');
  const playerOptions = document.querySelector('#players');
  const details = document.querySelector('#details');
  const offers = document.querySelector('#offers');
  const status = document.querySelector('#status');
  const periods = { day: '每日', month: '每月', pass: '当前活动', archive: '每个存档' };
  let busy = false;

  async function request(url, body) {
    const headers = { Accept: 'application/json' };
    let token = '';
    try { token = localStorage.getItem('adminApiToken'); } catch { /* Same fallback as the dashboard. */ }
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(url, { method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body) });
    if (response.status === 401) throw new Error('请先在管理后台设置访问令牌。');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '请求失败');
    return result;
  }

  function setBusy(value) {
    busy = value;
    input.disabled = value;
    form.querySelector('button').disabled = value;
    for (const button of offers.querySelectorAll('button')) button.disabled = value || button.dataset.inactive === 'true';
  }

  function render(data) {
    document.querySelector('#player-name').textContent = data.player.name + ' #' + data.player.id;
    offers.replaceChildren();
    for (const offer of data.offers) {
      const row = document.createElement('li');
      const info = document.createElement('div');
      const title = document.createElement('strong');
      const rule = document.createElement('small');
      title.textContent = offer.name;
      rule.textContent = periods[offer.kind] + '限购 ' + offer.limit + ' 次' + (offer.paired ? ' · 与「' + offer.paired + '」一并重置' : '');
      info.append(title, rule);
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = offer.used === null ? '未开放' : offer.used + ' / ' + offer.limit;
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.textContent = '重置限额';
      reset.setAttribute('aria-label', '重置' + offer.name + '限额');
      reset.dataset.inactive = String(offer.used === null);
      reset.addEventListener('click', () => resetOffer(data.player.id, offer));
      row.append(info, count, reset);
      offers.append(row);
    }
    details.hidden = false;
  }

  async function resetOffer(playerId, offer) {
    if (busy) return;
    setBusy(true);
    try {
      const data = await request('/api/pack-limits/' + playerId + '/reset', { product_id: offer.id, revision: offer.revision, period: offer.period });
      render(data);
      status.textContent = '已重置「' + offer.name + '」的限额。';
    } catch (error) {
      status.textContent = error.message;
    } finally { setBusy(false); }
  }

  async function loadPlayer(playerId) {
    if (busy) return;
    details.hidden = true;
    setBusy(true);
    try {
      render(await request('/api/pack-limits/' + playerId));
      status.textContent = '';
    } catch (error) {
      status.textContent = error.message;
    } finally { setBusy(false); }
  }

  input.addEventListener('input', () => { details.hidden = true; status.textContent = ''; });
  form.addEventListener('submit', event => {
    event.preventDefault();
    loadPlayer(input.value);
  });
  request('/api/player').then(players => {
    for (const player of players) {
      const option = document.createElement('option');
      option.value = String(player.id);
      option.label = player.name;
      playerOptions.append(option);
    }
    if (players.length === 1 && !input.value) {
      input.value = String(players[0].id);
      loadPlayer(input.value);
    }
  }).catch(error => { status.textContent = error.message; });
</script></body></html>`)
}

function installQuotaAdmin(root, listQuotas, resetQuota) {
    const load = relative => require(path.join(root, "out", relative))
    const api = load("routes/web_api/index.js")
    const registerApi = api.default
    api.default = async (fastify, options) => {
        await registerApi(fastify, options)
        fastify.get(apiPath, async (request, reply) => {
            const id = Number(request.params.playerId)
            if (!Number.isSafeInteger(id) || id < 1) return reply.code(400).send({ error: "玩家编号无效。" })
            const quotas = listQuotas(id)
            if (!quotas) return reply.code(404).send({ error: "找不到此玩家。" })
            return quotas
        })
        fastify.post(`${apiPath}/reset`, { bodyLimit: 512 }, async (request, reply) => {
            const id = Number(request.params.playerId)
            const { product_id: product, revision, period } = request.body ?? {}
            if (!Number.isSafeInteger(id) || id < 1 || typeof product !== "string"
                || !Number.isSafeInteger(revision) || revision < 0 || typeof period !== "string") {
                return reply.code(400).send({ error: "请选择玩家和礼包。" })
            }
            const result = resetQuota(id, product, revision, period)
            if (result === "missing") return reply.code(404).send({ error: "找不到此玩家。" })
            if (result === "invalid") return reply.code(400).send({ error: "该商品没有可重置的限额。" })
            if (result === "stale") return reply.code(409).send({ error: "限额或活动已变化，请重新查看礼包。" })
            return listQuotas(id)
        })
    }

    const ui = load("runtime/admin.js")
    const registerUi = ui.registerAdminUi
    ui.registerAdminUi = (fastify, options) => {
        registerUi(fastify, options)
        const { indexHtml } = ui.requireAdminBuild(options.projectRoot)
        const dashboard = indexHtml.toString("utf8").replace("</body>", `<script defer src="${entryPath}"></script></body>`)
        fastify.addHook("onRequest", async (request, reply) => {
            if (request.method !== "GET") return
            const pathname = request.url.split("?", 1)[0]
            if (!pathname.startsWith("/admin/") || pathname === pagePath
                || pathname.startsWith("/admin/assets/")) return
            const index = pathname === "/admin/" || pathname === "/admin/index.html"
            const acceptsHtml = !request.headers.accept || /(?:text\/html|text\/\*|\*\/\*)/.test(request.headers.accept)
            if (!index && (path.posix.extname(pathname) || !acceptsHtml)) return
            return reply.header("cache-control", "no-cache").type("text/html; charset=utf-8").send(dashboard)
        })
        fastify.get(entryPath, async (_request, reply) => reply.type("application/javascript").send(entryScript))
        fastify.get(pagePath, async (_request, reply) => renderQuotaAdmin(reply))
    }
}

module.exports = { installQuotaAdmin }
