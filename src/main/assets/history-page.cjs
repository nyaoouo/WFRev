"use strict"

const { randomBytes } = require("node:crypto")

const escape = value => String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character])
const date = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
})
const labels = { character: "角色", equipment: "装备", crazy: "乐享", box: "宝箱" }
const yen = value => `¥${value.toFixed(2)}`

function metric(label, value) {
    return `<div><span>${label}</span><strong>${value}</strong></div>`
}

function paging({ pages, page }, link) {
    if (pages === 1 && page === 1) return ""
    return `<nav class="paging" aria-label="翻页">
      ${page > 1 ? `<a href="${link(Math.min(page - 1, pages))}">上一页</a>` : "<span></span>"}
      <span>${page} / ${pages}</span>
      ${page < pages ? `<a href="${link(page + 1)}">下一页</a>` : "<span></span>"}
    </nav>`
}

function paymentHistory(view) {
    const rows = view.rows.map(row => `<li><div><b>${escape(row.name)}</b><time>${date.format(row.paid_at)}</time></div><strong>${yen(row.price)}</strong></li>`)
    return `<div class="metrics">${metric("充值总额", yen(view.summary.total))}${metric("已完成订单", view.summary.count)}</div>
      <section aria-labelledby="entries"><h2 id="entries">已完成订单</h2>
      ${rows.length ? `<ul>${rows.join("")}</ul>` : '<p class="empty">暂无已完成的充值订单</p>'}
      ${paging(view, page => `?page=${page}`)}</section>`
}

function gachaHistory(view) {
    const { kind, pool, pools, stats } = view
    const kindLink = (type, page = 1, poolId = "") => `?kind=${type}&amp;pool=${poolId}&amp;page=${page}`
    const tabs = Object.entries(labels).map(([type, label]) => `<a href="${kindLink(type)}" ${type === kind ? 'aria-current="page"' : ""}>${label}</a>`).join("")
    const options = pools.map(row => `<option value="${row.pool_id}" ${row.pool_id === pool ? "selected" : ""}>${escape(row.pool_name)}</option>`).join("")
    const distribution = stats.total && view.stars.some(row => row.rarity !== null)
        ? `<section aria-labelledby="distribution"><h2 id="distribution">星级分布</h2><ul class="distribution">${view.stars.map(row => {
            const share = Math.round(row.total * 100 / stats.total)
            return `<li><b>${row.rarity === null ? "其他" : `${row.rarity}★`}</b><meter min="0" max="${stats.total}" value="${row.total}">${share}%</meter><span>${row.total} 抽 · ${share}%</span></li>`
        }).join("")}</ul></section>` : ""
    const statsCards = kind === "box" ? "" : [
        metric("5★ 数量 · 实得率", stats.total ? `${stats.fives} · ${(stats.fives * 100 / stats.total).toFixed(1)}%` : `${stats.fives} · —`),
        metric("距上次 5★", stats.last_five === null ? "—" : `${stats.total - stats.last_five} 抽`),
        metric("平均 5★ 间隔", stats.fives > 1 ? `${((stats.last_five - stats.first_five) / (stats.fives - 1)).toFixed(1)} 抽` : "—"),
    ].join("")
    const rows = view.rows.map(row => `<li><div><b>${escape(row.item_name)}</b><small>${escape(row.pool_name)}${row.gap === null ? "" : ` · 距上一 5★ ${row.gap} 抽`}</small><time>${date.format(row.drawn_at)}</time></div>
      ${row.rarity === null ? `<strong>×${row.amount}</strong>` : `<strong class="rarity" data-stars="${row.rarity}">${row.rarity}★</strong>`}</li>`)

    return `<nav class="tabs" aria-label="扭蛋类型">${tabs}</nav>
      ${pools.length ? `<form class="filter" method="get"><input type="hidden" name="kind" value="${kind}"><label for="pool">卡池</label><select id="pool" name="pool"><option value="">全部卡池</option>${options}</select><button>查看</button></form>` : ""}
      <div class="metrics">${metric("总抽数", stats.total)}${statsCards}</div>${distribution}
      <section aria-labelledby="entries"><h2 id="entries">抽取明细</h2>
      ${rows.length ? `<ul>${rows.join("")}</ul>` : '<p class="empty">暂无记录。完成扭蛋后会自动记录。</p>'}
      ${paging(view, page => kindLink(kind, page, pool ?? ""))}</section>`
}

function renderHistory(reply, view) {
    const nonce = randomBytes(18).toString("base64")
    const title = view.section === "payments" ? "充值记录" : "扭蛋记录"
    const body = view.expired ? '<p class="empty">记录页已过期，请返回游戏重新打开。</p>'
        : view.section === "payments" ? paymentHistory(view) : gachaHistory(view)
    return reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer")
        .header("content-security-policy", `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`)
        .type("text/html; charset=utf-8")
        .send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style nonce="${nonce}">
  :root { color-scheme: light; font:16px/1.45 system-ui,sans-serif; color:#243744; background:#edf6f7; }
  * { box-sizing:border-box; } body { margin:0; } h1,h2,p,ul { margin:0; } a { color:inherit; text-decoration:none; }
  header { background:linear-gradient(115deg,#15364d,#275d6b); color:white; border-bottom:4px solid #f0ad47; }
  .bar { max-width:43rem; margin:auto; min-height:3.5rem; padding:.5rem 1rem; display:flex; align-items:center; gap:.9rem; }
  .back { min-width:3.75rem; min-height:2.75rem; display:grid; place-items:center; background:#ffffff21; border:1px solid #ffffff59; border-radius:.6rem; }
  h1 { font-size:1.2rem; } main { max-width:43rem; margin:auto; padding:1rem 1rem 2rem; }
  .metrics { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.6rem; margin-bottom:1rem; }
  .metrics div,section,.filter { background:white; border:1px solid #d6e5e7; border-radius:.72rem; }
  .metrics div { padding:.68rem .75rem; border-top:3px solid #338c92; }
  .metrics span,time,small { display:block; color:#526573; font-size:.8rem; overflow-wrap:anywhere; }
  .metrics strong { display:block; margin-top:.15rem; font-size:1.25rem; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
  .tabs { display:grid; grid-template-columns:repeat(4,1fr); background:white; border:1px solid #d6e5e7; border-radius:.7rem; margin-bottom:.75rem; padding:.15rem; }
  .tabs a { min-height:2.65rem; display:grid; place-items:center; font-weight:600; border-bottom:3px solid transparent; }
  .tabs a[aria-current] { color:#176568; border-color:#e9972a; background:#eff9f8; }
  .filter { display:flex; gap:.5rem; align-items:center; padding:.45rem .55rem; margin-bottom:.75rem; }
  .filter label { font-size:.875rem; white-space:nowrap; }
  select,button { font:inherit; min-height:2.75rem; border-radius:.45rem; }
  select { flex:1; min-width:0; background:#f3f8fa; border:1px solid #c7dce1; color:inherit; padding:0 .35rem; }
  button { background:#217a7e; color:white; border:0; padding:0 .65rem; }
  section { overflow:hidden; margin-bottom:1rem; } h2 { background:#f6fafb; font-size:1rem; padding:.75rem .8rem; border-bottom:1px solid #dbe9eb; }
  ul { list-style:none; padding:0; } li { display:flex; justify-content:space-between; align-items:center; gap:.6rem; padding:.65rem .8rem; }
  li + li { border-top:1px solid #edf2f4; } li b { overflow-wrap:anywhere; } li strong { white-space:nowrap; }
  .rarity { background:#eaf3fb; color:#315e92; border-radius:.4rem; padding:.2rem .45rem; }
  .rarity[data-stars="4"] { background:#f2ebfb; color:#643887; } .rarity[data-stars="5"] { background:#fff3da; color:#744900; }
  .distribution li { display:grid; grid-template-columns:2.5rem minmax(2rem,1fr) max-content; font-size:.84rem; } meter { width:100%; accent-color:#258187; }
  .empty { text-align:center; padding:1.6rem .7rem; color:#526573; } .paging { border-top:1px solid #dbe9eb; padding:.45rem .8rem; display:grid; grid-template-columns:1fr 1fr 1fr; text-align:center; align-items:center; }
  .paging a { min-height:2.75rem; display:grid; place-items:center; color:#15666d; font-weight:650; }
  :focus-visible { outline:2px solid #236d90; outline-offset:2px; }
</style></head><body><header><div class="bar"><a class="back" href="starpoint-history://close">返回</a><h1>${title}</h1></div></header><main>${body}</main></body></html>`)
}

module.exports = { renderHistory }
