"use strict"

const path = require("node:path")
const { randomBytes } = require("node:crypto")
const { AsyncLocalStorage } = require("node:async_hooks")
const { renderHistory } = require("./history-page.cjs")

const routes = "/local/history"
const kinds = ["character", "equipment", "crazy", "box"]
const pageSize = 30
const ticketMs = 15 * 60000

function installHistory(root, db, identity, products) {
    const load = relative => require(path.join(root, "out", relative))
    const { getContentSnapshot } = load("content/runtime/content-snapshot.js")
    const { getGachaCatalog } = load("lib/gacha-catalog/index.js")
    const { buildCharacterLookup } = load("lib/character-content.js")
    const { getEquipmentLookupSync } = load("lib/equipment-content.js")
    const { getItemLookupSync } = load("lib/item-content.js")
    const { getBoxGachaContentCatalog, getBoxGachaContent } = load("lib/box-gacha-content.js")
    const { getPlayerCrazyGachaResultsSync } = load("data/domains/gacha-lifecycle-state.js")
    const { getRealNowMs } = load("runtime/time/game-time.js")
    const tickets = new Map()
    const characterLookups = new WeakMap()
    let database

    function historyDb() {
        const current = db()
        if (current !== database) {
            current.exec(`CREATE TABLE IF NOT EXISTS local_gacha_draw_history (
                id INTEGER PRIMARY KEY,
                player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
                kind TEXT NOT NULL, pool_id INTEGER NOT NULL, pool_name TEXT NOT NULL,
                item_id INTEGER NOT NULL, item_name TEXT NOT NULL,
                rarity INTEGER, amount INTEGER NOT NULL, drawn_at INTEGER NOT NULL,
                rarity_verified INTEGER NOT NULL DEFAULT 1
            ); CREATE INDEX IF NOT EXISTS local_gacha_draw_player_pool
                ON local_gacha_draw_history (player_id, kind, pool_id, id);`)
            if (!current.pragma("table_info(local_gacha_draw_history)").some(column => column.name === "rarity_verified")) {
                current.exec("ALTER TABLE local_gacha_draw_history ADD COLUMN rarity_verified INTEGER NOT NULL DEFAULT 0")
            }
            current.transaction(() => {
                const update = current.prepare("UPDATE local_gacha_draw_history SET rarity = ?, rarity_verified = 1 WHERE id = ?")
                for (const row of current.prepare("SELECT id, kind, item_id FROM local_gacha_draw_history WHERE rarity_verified = 0").all()) {
                    const unit = row.kind === "box" ? null : lookup(row.kind)[String(row.item_id)]
                    update.run(starsOf(unit), row.id)
                }
            })()
            database = current
        }
        return current
    }

    function record(playerId, kind, poolId, poolName, entries, at = getRealNowMs()) {
        const insert = historyDb().prepare(`INSERT INTO local_gacha_draw_history
            (player_id, kind, pool_id, pool_name, item_id, item_name, rarity, amount, drawn_at, rarity_verified)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
        for (const entry of entries) {
            insert.run(playerId, kind, poolId, poolName, entry.id, entry.name, entry.rarity, entry.amount, at)
        }
    }

    function characters() {
        const repository = getContentSnapshot().repository
        if (!characterLookups.has(repository)) characterLookups.set(repository, buildCharacterLookup(repository))
        return characterLookups.get(repository)
    }

    function lookup(kind) {
        return kind === "equipment" ? getEquipmentLookupSync() : characters()
    }

    function starsOf(item) {
        const value = Number(String(item?.rarity ?? "").replace("★", ""))
        return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null
    }

    function recordBanner(command, kind, ids) {
        const banner = getGachaCatalog().banners[String(command.gachaId)]
        const table = lookup(kind)
        record(command.playerId, kind, command.gachaId, banner.definition.name, ids.map(id => ({
            id, name: table[String(id)]?.name || `${kind === "equipment" ? "装备" : "角色"} #${id}`,
            rarity: starsOf(table[String(id)]), amount: 1,
        })))
    }

    // Use the same outer transaction for acquisition and its history entry.
    const ordinary = load("lib/gacha-owner/execute.js")
    const execute = ordinary.executeGachaDrawSync
    ordinary.executeGachaDrawSync = command => historyDb().transaction(() => {
        const result = execute(command)
        if (result.ok) recordBanner(command, result.kind, result.draw.map(draw => draw.character_id ?? draw.equipment_id))
        return result
    })()

    const crazy = load("lib/gacha-owner/crazy.js")
    const select = crazy.selectCrazyGachaCandidateSync
    crazy.selectCrazyGachaCandidateSync = command => historyDb().transaction(() => {
        const chosen = getPlayerCrazyGachaResultsSync(command.playerId, command.gachaId)
            .filter(row => row.slotIndex === command.slot)
        const result = select(command)
        if (result.ok && chosen.length) recordBanner(command, "crazy", chosen.map(row => row.characterId))
        return result
    })()

    const boxRequest = new AsyncLocalStorage()
    const boxRoutes = load("routes/api/boxGacha.js")
    const registerBox = boxRoutes.default
    boxRoutes.default = async (fastify, options) => {
        fastify.addHook("onRoute", route => {
            if (route.method !== "POST" || route.url !== `${fastify.prefix}/exec`) return
            const handle = route.handler
            route.handler = function (request, reply) {
                const poolId = Number(request.body?.box_gacha_id)
                const boxId = Number(request.body?.box_id)
                return boxRequest.run({ poolId, boxId }, () => handle.call(this, request, reply))
            }
        })
        return registerBox(fastify, options)
    }
    const boxRewards = load("lib/box-gacha-reward-grant.js")
    const grant = boxRewards.grantBoxGachaDrawInTransactionOwnerWithInventorySync
    boxRewards.grantBoxGachaDrawInTransactionOwnerWithInventorySync = (playerId, draw, ...args) => {
        const result = grant(playerId, draw, ...args)
        const context = boxRequest.getStore()
        if (context) {
            const { poolId, boxId } = context
            const box = getBoxGachaContent(getBoxGachaContentCatalog(), poolId).boxes[String(boxId)]
            const items = getItemLookupSync()
            const equipment = getEquipmentLookupSync()
            const units = characters()
            record(playerId, "box", poolId, `活动宝箱 #${poolId}`, draw.rewards.map(reward => {
                const definition = box[String(reward.id)]
                const { id, type, count } = definition
                const name = type === 0 ? items[String(id)] : type === 1 ? equipment[String(id)]?.name
                    : type === 6 ? units[String(id)]?.name : { 2: "星导石", 3: "玛纳", 4: "经验", 5: "修行点数", 7: "称号" }[type]
                return { id: id ?? reward.id, name: `${name || `奖品 #${reward.id}`} ×${count}`, rarity: null, amount: reward.number }
            }))
        }
        return result
    }

    function readOrders(playerId, page) {
        const current = historyDb()
        const summary = current.prepare(`SELECT count(*) AS count, coalesce(sum(price), 0) AS total
            FROM local_payment_orders WHERE player_id = ? AND paid_at IS NOT NULL`).get(playerId)
        const rows = current.prepare(`SELECT product_id, price, paid_at
            FROM local_payment_orders WHERE player_id = ? AND paid_at IS NOT NULL
            ORDER BY paid_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(playerId, pageSize, (page - 1) * pageSize)
            .map(row => ({ ...row, name: products.get(row.product_id)?.name ?? row.product_id }))
        return { summary, rows, pages: Math.max(1, Math.ceil(summary.count / pageSize)) }
    }

    function readDraws(playerId, kind, pool, page) {
        const current = historyDb()
        const pools = current.prepare(`SELECT pool_id, max(pool_name) AS pool_name FROM local_gacha_draw_history
            WHERE player_id = ? AND kind = ? GROUP BY pool_id ORDER BY max(id) DESC`).all(playerId, kind)
        const filter = pool ? "player_id = ? AND kind = ? AND pool_id = ?" : "player_id = ? AND kind = ?"
        const args = pool ? [playerId, kind, pool] : [playerId, kind]
        const stats = current.prepare(`WITH pulls AS (
            SELECT rarity, amount, row_number() OVER (ORDER BY id) AS position
            FROM local_gacha_draw_history WHERE ${filter}
        ) SELECT count(*) AS count, coalesce(sum(amount), 0) AS total,
            count(*) FILTER (WHERE rarity = 5) as fives,
            min(position) FILTER (WHERE rarity = 5) AS first_five,
            max(position) FILTER (WHERE rarity = 5) AS last_five FROM pulls`).get(...args)
        const stars = current.prepare(`SELECT rarity, sum(amount) AS total FROM local_gacha_draw_history
            WHERE ${filter} GROUP BY rarity ORDER BY rarity DESC`).all(...args)
        const rows = current.prepare(`WITH entries AS (
            SELECT *, row_number() OVER (ORDER BY id) AS position FROM local_gacha_draw_history WHERE ${filter}
        ), intervals AS (
            SELECT id, position - lag(position) OVER (ORDER BY position) AS gap FROM entries WHERE rarity = 5
        ) SELECT entries.*, intervals.gap FROM entries LEFT JOIN intervals USING (id)
            ORDER BY entries.id DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize)
        return { stats, stars, rows, pools, pages: Math.max(1, Math.ceil(stats.count / pageSize)) }
    }

    return function register(fastify) {
        fastify.post(`${routes}/session`, { bodyLimit: 256 }, async (request, reply) => {
            const actor = identity(request.body)
            if (!actor) return reply.code(403).send("记录不可用")
            const now = getRealNowMs()
            for (const [token, ticket] of tickets) if (ticket.expires <= now) tickets.delete(token)
            if (tickets.size >= 128) tickets.delete(tickets.keys().next().value)
            const token = randomBytes(24).toString("hex")
            tickets.set(token, { playerId: actor.playerId, expires: now + ticketMs })
            return reply.header("cache-control", "no-store").type("text/plain").send(token)
        })
        fastify.get(`${routes}/view/:token/:section`, async (request, reply) => {
            const { token, section } = request.params
            const ticket = tickets.get(token)
            const page = Math.min(100000, Math.max(1, Math.trunc(Number(request.query.page)) || 1))
            const kind = kinds.includes(request.query.kind) ? request.query.kind : kinds[0]
            const pool = /^[1-9]\d{0,9}$/.test(request.query.pool ?? "") ? Number(request.query.pool) : null
            if (!["payments", "gacha"].includes(section)) return reply.code(404).send("记录页不存在")
            if (!ticket || ticket.expires <= getRealNowMs()) return renderHistory(reply.code(403), { section, expired: true })
            const data = section === "payments" ? readOrders(ticket.playerId, page) : readDraws(ticket.playerId, kind, pool, page)
            return renderHistory(reply, { section, page, kind, pool, ...data })
        })
    }
}

module.exports = { installHistory }
