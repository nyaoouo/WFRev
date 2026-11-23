"use strict"

const path = require("node:path")
const { randomBytes } = require("node:crypto")
const products = require("./payment-catalog.cjs")
const { showCheckout } = require("./payment-page.cjs")
const { installHistory } = require("./local-history.cjs")
const { installQuotaAdmin } = require("./quota-admin.cjs")

const api = "/api/index.php"
const localCheckout = "/local/checkout/"
const paymentChannel = `${api}/channels/channel_leiting_pay/`
const monthProduct = "com.leiting.wf.stonepack_Daily"
const dessertName = "史黛拉的每日甜点"
const dayMs = 86400000
const resetHour = 5
const monthDays = 30
const orderMs = 15 * 60 * 1000
const orderIdPattern = /^[a-f0-9]{48}$/

function install(root) {
    const load = relative => require(path.join(root, "out", relative))
    const { getDb } = load("data/db.js")
    const { resolvePlayerIdSync } = load("data/activeAccount.js")
    const { getSessionSync } = load("data/domains/session.js")
    const { SessionType } = load("data/types.js")
    const { getPlayerSync, updatePlayerSync } = load("data/domains/player.js")
    const { insertMailSync } = load("data/domains/mail.js")
    const { deserializeClientDate } = load("data/utils/date.js")
    const { getPlayerPassCardStateSync, setPlayerPassCardPurchasedSync } = load("data/domains/pass-card.js")
    const { getActivePassCardEventDefinitionAt } = load("lib/pass-card.js")
    const { getCurrencyCapacityPolicySync } = load("lib/config-content.js")
    const { getBusinessDayKey } = load("lib/time-utils.js")
    const { getGameCalendar } = load("time/game-calendar-provider.js")
    const { getRealNow } = load("runtime/time/game-time.js")
    const { generateDataHeaders, getServerTime, realToVirtual } = load("utils.js")

    let database
    function db() {
        const current = getDb()
        if (current !== database) {
            current.exec(`
                CREATE TABLE IF NOT EXISTS local_payment_orders (
                    id TEXT PRIMARY KEY,
                    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
                    product_id TEXT NOT NULL, period TEXT NOT NULL,
                    price INTEGER NOT NULL, expires_at INTEGER NOT NULL,
                    paid_at INTEGER, business_day TEXT, canceled INTEGER NOT NULL DEFAULT 0,
                    acknowledged INTEGER NOT NULL DEFAULT 0,
                    quota_revision INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS local_payment_orders_player
                    ON local_payment_orders (player_id, product_id, period);
                CREATE TABLE IF NOT EXISTS local_payment_benefits (
                    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
                    kind TEXT NOT NULL, starts INTEGER NOT NULL, ends INTEGER NOT NULL,
                    delivered_through INTEGER NOT NULL, boost_day INTEGER,
                    activation_order_id TEXT, PRIMARY KEY(player_id, kind)
                );
                CREATE TABLE IF NOT EXISTS local_payment_quota_resets (
                    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
                    product_id TEXT NOT NULL, revision INTEGER NOT NULL, reset_period TEXT NOT NULL,
                    PRIMARY KEY (player_id, product_id)
                );
            `)
            if (!current.pragma("table_info(local_payment_orders)").some(column => column.name === "quota_revision")) {
                current.exec("ALTER TABLE local_payment_orders ADD COLUMN quota_revision INTEGER NOT NULL DEFAULT 0")
            }
            const columns = current.pragma("table_info(local_payment_benefits)")
            if (!columns.some(column => column.name === "activation_order_id")) {
                current.exec("ALTER TABLE local_payment_benefits ADD COLUMN activation_order_id TEXT")
            }
            // Preview builds wrote UTC into the payment mail's game-clock field.
            const subjects = new Set([...products.values()].map(product => product.name))
            subjects.add(dessertName)
            const mails = current.prepare(`SELECT id, subject, create_time FROM players_mails
                WHERE reason_id = 0 AND subject = description
                    AND (create_time LIKE '____-__-__T__:__:__.___Z' OR create_time LIKE '____-__-__ __:__:__')`).all()
            const fixDate = current.prepare("UPDATE players_mails SET create_time = ?, description = ? WHERE id = ?")
            current.transaction(() => {
                for (const mail of mails) {
                    if (!subjects.has(mail.subject)) continue
                    const created = mail.create_time.includes("T")
                        ? Date.parse(mail.create_time) : deserializeClientDate(mail.create_time).getTime()
                    if (Number.isFinite(created)) {
                        fixDate.run(getGameCalendar().formatMasterTimestamp(created), `${mail.subject}\n\n::item::`, mail.id)
                    }
                }
            })()
            database = current
        }
        return database
    }

    function identity(body) {
        const viewerId = body?.viewer_id || body?.keychain
        if (!Number.isSafeInteger(viewerId) || viewerId < 1) return null
        const session = getSessionSync(String(viewerId))
        if (session?.type !== SessionType.VIEWER) return null
        const playerId = resolvePlayerIdSync(session.accountId)
        return playerId ? { viewerId, playerId } : null
    }

    function response(reply, viewerId, data) {
        return reply.type("application/x-msgpack").send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }), data,
        })
    }

    function orderById(id) {
        if (typeof id !== "string" || !orderIdPattern.test(id)) return undefined
        return db().prepare("SELECT * FROM local_payment_orders WHERE id = ?").get(id)
    }

    function orderState(order, time = getRealNow().getTime()) {
        if (!order) return "missing"
        if (order.paid_at !== null) return "paid"
        if (order.canceled) return "canceled"
        return time >= order.expires_at ? "expired" : "pending"
    }

    function clock(real = getRealNow()) {
        const key = getBusinessDayKey(real, resetHour)
        return { key, day: Date.parse(`${key}T00:00:00Z`) / dayMs, real: real.getTime(), game: getServerTime() }
    }

    function periodFor(product, now) {
        if (product.period === "day") return now.key
        if (product.period === "month") return now.key.slice(0, 7)
        if (product.period === "pass") {
            const event = getActivePassCardEventDefinitionAt(new Date(now.game * 1000))
            return event ? String(event.eventId) : null
        }
        return "archive"
    }

    function quotaState(playerId, id) {
        return db().prepare(`SELECT revision, reset_period FROM local_payment_quota_resets
            WHERE player_id = ? AND product_id = ?`).get(playerId, id)
    }

    function countPaid(playerId, id, period, revision = quotaState(playerId, id)?.revision ?? 0) {
        if (period === undefined) {
            return db().prepare(`SELECT count(*) AS count FROM local_payment_orders
                WHERE player_id = ? AND product_id = ? AND paid_at IS NOT NULL AND quota_revision = ?`).get(playerId, id, revision).count
        }
        return db().prepare(`SELECT count(*) AS count FROM local_payment_orders
            WHERE player_id = ? AND product_id = ? AND period = ? AND paid_at IS NOT NULL AND quota_revision = ?`)
            .get(playerId, id, period, revision).count
    }

    function purchasedTimes(playerId, id, product, period) {
        if (product.excludes && countPaid(playerId, product.excludes) > 0) return product.limit
        const quota = quotaState(playerId, id)
        if (product.period === "pass" && quota?.reset_period !== period
            && getPlayerPassCardStateSync(playerId, Number(period)).isBuy) return 1
        return countPaid(playerId, id, period, quota?.revision ?? 0)
    }

    function listQuotas(playerId) {
        const player = getPlayerSync(playerId)
        if (!player) return null
        const now = clock()
        const offers = [...products].filter(([, product]) => product.limit).map(([id, product]) => {
            const period = periodFor(product, now)
            const used = period ? purchasedTimes(playerId, id, product, period) : null
            return {
                id, name: product.name, used, limit: product.limit, period,
                kind: product.period ?? "archive", revision: quotaState(playerId, id)?.revision ?? 0,
                paired: product.excludes ? products.get(product.excludes).name : null,
            }
        })
        return { player: { id: playerId, name: player.name }, offers }
    }

    function resetQuota(playerId, id, expectedRevision, expectedPeriod) {
        const product = products.get(id)
        if (!product?.limit) return "invalid"
        return db().transaction(() => {
            if (!getPlayerSync(playerId)) return "missing"
            const now = clock()
            const period = periodFor(product, now)
            if (!period || period !== expectedPeriod || (quotaState(playerId, id)?.revision ?? 0) !== expectedRevision) return "stale"
            const advance = db().prepare(`INSERT INTO local_payment_quota_resets (player_id, product_id, revision, reset_period)
                VALUES (?, ?, 1, ?) ON CONFLICT (player_id, product_id) DO UPDATE SET
                    revision = revision + 1, reset_period = excluded.reset_period`)
            // Orders keep their settled revision, so quota resets preserve history and benefits.
            advance.run(playerId, id, period)
            if (product.excludes) advance.run(playerId, product.excludes, periodFor(products.get(product.excludes), now))
            return "ok"
        })()
    }

    function grantMail(playerId, subject, [type, number, typeId], now) {
        insertMailSync(playerId, {
            reason_id: 0, subject, description: `${subject}\n\n::item::`, type, type_id: typeId ?? null, number,
            receive_time: "0000-00-00 00:00:00", create_time: getGameCalendar().formatMasterTimestamp(now.game * 1000),
            reward_period_limited: 0, reward_limit_time: null,
        })
    }

    function benefit(playerId, kind) {
        return db().prepare("SELECT * FROM local_payment_benefits WHERE player_id = ? AND kind = ?").get(playerId, kind)
    }

    function monthlyTotal(playerId, now) {
        return db().prepare(`SELECT coalesce(sum(price), 0) AS total FROM local_payment_orders
            WHERE player_id = ? AND paid_at IS NOT NULL AND business_day BETWEEN ? AND ?`)
            .get(playerId, `${now.key.slice(0, 7)}-01`, now.key).total
    }

    function extendBenefit(playerId, kind, now, activationOrderId = null) {
        const existing = benefit(playerId, kind)
        if (existing && now.day < existing.ends) {
            if (kind === "month") {
                db().prepare("UPDATE local_payment_benefits SET ends = ends + ? WHERE player_id = ? AND kind = ?")
                    .run(monthDays, playerId, kind)
            }
            return
        }
        db().prepare(`INSERT INTO local_payment_benefits (player_id, kind, starts, ends, delivered_through, activation_order_id)
            VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, kind) DO UPDATE SET
            starts = excluded.starts, ends = excluded.ends, delivered_through = excluded.delivered_through,
            boost_day = NULL, activation_order_id = excluded.activation_order_id`)
            .run(playerId, kind, now.day, now.day + monthDays, now.day - 1, activationOrderId)
    }

    // Run after the normal load reset so the month's extra points aren't overwritten.
    function deliverBenefits(playerId, now) {
        for (const kind of ["month", "dessert"]) {
            const record = benefit(playerId, kind)
            if (!record) continue
            const lastDue = Math.min(now.day, record.ends - 1)
            const daysDue = lastDue - record.delivered_through
            const subject = kind === "month" ? products.get(monthProduct).name : dessertName
            if (daysDue > 0) {
                grantMail(playerId, subject, [4, 50 * daysDue], now)
                if (kind === "month") grantMail(playerId, subject, [1, daysDue, 102], now)
                db().prepare("UPDATE local_payment_benefits SET delivered_through = ? WHERE player_id = ? AND kind = ?")
                    .run(lastDue, playerId, kind)
            }
            if (kind === "month" && lastDue === now.day && record.boost_day !== now.day) {
                const reset = db().prepare("SELECT last_daily_reset_real_business_day AS day FROM players WHERE id = ?").get(playerId)
                if (reset?.day === now.key) {
                    const player = getPlayerSync(playerId)
                    updatePlayerSync({ id: playerId, boostPoint: player.boostPoint + 1, bossBoostPoint: player.bossBoostPoint + 1 })
                    db().prepare("UPDATE local_payment_benefits SET boost_day = ? WHERE player_id = ? AND kind = 'month'").run(now.day, playerId)
                }
            }
        }
    }

    function paymentBenefits(playerId, now) {
        const month = benefit(playerId, "month")
        const dessert = benefit(playerId, "dessert")
        // The client treats a changed expiry as activation. Project the saved
        // business-day boundary onto the game clock, independent of request time.
        const resetOffset = (resetHour * 60 - getGameCalendar().utcOffsetMinutes) * 60000
        const atGameDay = day => realToVirtual(new Date(day * dayMs + resetOffset))
        const remain = Math.max(0, (month?.ends ?? now.day) - now.day)
        return {
            remain,
            dessertActivationOrderId: dessert?.activation_order_id,
            dessert: dessert && now.day < dessert.ends ? {
                bonus_days: dessert.ends - now.day,
                expired_time: atGameDay(dessert.ends), init_time: atGameDay(dessert.starts),
                status: 1, start_time: atGameDay(dessert.starts),
            } : null,
        }
    }

    const messages = {
        paid: "付款成功。返回游戏查看到账结果。",
        canceled: "订单已取消。请返回游戏。",
        expired: "订单已过期。请返回游戏重新下单。",
        missing: "订单不存在。请从游戏商城重新下单。",
    }

    function settle(id, cancel) {
        const now = clock()
        return db().transaction(() => {
            const order = orderById(id)
            const state = orderState(order, now.real)
            if (state !== "pending") return { state, message: messages[state] }
            if (cancel) {
                db().prepare("UPDATE local_payment_orders SET canceled = 1 WHERE id = ?").run(id)
                return { state: "canceled", message: messages.canceled }
            }
            const product = products.get(order.product_id)
            const period = product && periodFor(product, now)
            const stale = !period || (product.period === "pass" && period !== order.period)
            if (stale || purchasedTimes(order.player_id, order.product_id, product, period) >= (product.limit ?? Infinity)) {
                db().prepare("UPDATE local_payment_orders SET canceled = 1 WHERE id = ?").run(id)
                return { state: "canceled", message: "商品限购或已下架。请返回游戏刷新商城。" }
            }
            const player = getPlayerSync(order.player_id)
            if (product.paid && player.vmoney + product.paid > getCurrencyCapacityPolicySync().maxVmoney) {
                return { state: "pending", message: "付费星导石余额将超过上限，无法完成这笔订单。" }
            }
            deliverBenefits(order.player_id, now)
            const dessert = benefit(order.player_id, "dessert")
            const oldMonthlyTotal = monthlyTotal(order.player_id, now)
            if (product.paid) updatePlayerSync({ id: order.player_id, vmoney: player.vmoney + product.paid })
            for (const reward of product.mail ?? []) grantMail(order.player_id, product.name, reward, now)
            if (product.period === "pass") setPlayerPassCardPurchasedSync(order.player_id, Number(period))
            if (product.benefit === "month") extendBenefit(order.player_id, "month", now)
            if (now.day >= (dessert?.ends ?? 0)) {
                // Only purchases made after a previous dessert period can activate a new one.
                const eligible = dessert ? db().prepare(`SELECT coalesce(sum(price), 0) AS total
                    FROM local_payment_orders WHERE player_id = ? AND paid_at IS NOT NULL AND business_day BETWEEN ? AND ?`)
                    .get(order.player_id, new Date(dessert.ends * dayMs).toISOString().slice(0, 10), now.key).total
                    : oldMonthlyTotal
                if (eligible + product.price >= 30) extendBenefit(order.player_id, "dessert", now, order.id)
            }
            deliverBenefits(order.player_id, now)
            db().prepare(`UPDATE local_payment_orders SET paid_at = ?, period = ?, business_day = ?, quota_revision = ? WHERE id = ?`)
                .run(now.real, period, now.key, quotaState(order.player_id, order.product_id)?.revision ?? 0, id)
            console.info(`[LOCAL-PAYMENT] paid ${order.product_id} for player ${order.player_id}`)
            return { state: "paid", message: messages.paid }
        })()
    }

    installQuotaAdmin(root, listQuotas, resetQuota)
    const registerHistory = installHistory(root, db, identity, products)
    const payment = load("routes/api/payment.js")
    payment.default = async fastify => {
        registerHistory(fastify)
        fastify.post("/item_list", async (request, reply) => {
            const actor = identity(request.body)
            if (!actor) return reply.code(400).send({ error: "Invalid viewer ID" })
            const now = clock()
            const items = []
            for (const [id, product] of products) {
                const period = periodFor(product, now)
                if (!period) continue
                items.push({
                    store_product_id: id, age_limit: false, monthly_alert: false,
                    start_time: 1425222000, end_time: 2147483647,
                    purchased_times: purchasedTimes(actor.playerId, id, product, period),
                })
            }
            return response(reply, actor.viewerId, { payment_item_list: items })
        })

        fastify.post("/start", async (request, reply) => {
            const actor = identity(request.body)
            const productId = request.body?.payment?.product_id
            const product = products.get(productId)
            const now = clock()
            const period = product && periodFor(product, now)
            if (!actor || !period || purchasedTimes(actor.playerId, productId, product, period) >= (product.limit ?? Infinity)) {
                return response(reply, actor?.viewerId, {})
            }
            const id = randomBytes(24).toString("hex")
            db().prepare(`INSERT INTO local_payment_orders (id, player_id, product_id, period, price, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run(id, actor.playerId, productId, period, product.price, now.real + orderMs)
            console.info(`[LOCAL-PAYMENT] order opened for ${productId} by player ${actor.playerId}`)
            return response(reply, actor.viewerId, {
                orderId: id, zoneId: "0", exchangeRate: 1, notifyUrl: "", extInfo: "",
                checkoutUrl: `http://127.0.0.1:8001${api}/payment${localCheckout}${id}`,
            })
        })

        fastify.post("/finish", async (request, reply) => {
            const actor = identity(request.body)
            const { product_id: declaredProduct, original_receipt: receipt, transaction_id: transaction } = request.body?.payment ?? {}
            // The Android channel carries its product/order pair in the receipt.
            const reference = receipt || transaction
            const [productId, id, extra] = typeof reference === "string" ? reference.split(":") : []
            const order = extra === undefined ? orderById(id) : undefined
            if (!actor || orderState(order) !== "paid" || order.player_id !== actor.playerId
                || order.product_id !== productId || (declaredProduct && declaredProduct !== productId)) {
                return reply.code(400).send({ error: "No confirmed order" })
            }
            const now = clock()
            const player = getPlayerSync(actor.playerId)
            const product = products.get(productId)
            const { remain, dessert, dessertActivationOrderId } = paymentBenefits(actor.playerId, now)
            db().prepare("UPDATE local_payment_orders SET acknowledged = 1 WHERE id = ?").run(order.id)
            console.info(`[LOCAL-PAYMENT] game acknowledged ${productId} for player ${actor.playerId}`)
            return response(reply, actor.viewerId, {
                after_vmoney: player.vmoney, after_free_vmoney: player.freeVmoney,
                first_payment: false, first_time: false,
                purchased_times_list: Object.fromEntries([...products].flatMap(([id, offer]) => {
                    const period = periodFor(offer, now)
                    if (!period || (!offer.limit && id !== productId)) return []
                    return [[id, purchasedTimes(actor.playerId, id, offer, period)]]
                })),
                monthly_payment_total: monthlyTotal(actor.playerId, now),
                monthly_charge_bonus_info: !order.acknowledged && order.id === dessertActivationOrderId ? dessert : null,
                premium_bonus_list: [{ remain_days: remain, store_product_id: monthProduct }],
            })
        })

        fastify.post("/report_purchase_result", async (request, reply) => response(reply, identity(request.body)?.viewerId, {}))

        fastify.get(`${localCheckout}:id`, async (request, reply) => {
            const order = orderById(request.params.id)
            const returnUrl = order && `${fastify.prefix}${localCheckout}${order.id}/return`
            return showCheckout(reply, order && products.get(order.product_id), orderState(order), returnUrl)
        })

        fastify.get(`${localCheckout}:id/return`, async (request, reply) => {
            const order = orderById(request.params.id)
            const state = orderState(order)
            reply.header("cache-control", "no-store")
            if (state === "missing" || state === "pending") {
                return reply.code(state === "missing" ? 404 : 409).send({ state })
            }
            return reply.redirect(`worldflipperlt://return?local_order=${order.id}`, 303)
        })

        fastify.post(`${localCheckout}:id/confirm`, { bodyLimit: 256 }, async (request, reply) => {
            if (typeof request.body?.code !== "string" || !/^[0-9]{6}$/.test(request.body.code)) {
                return reply.code(400).send({ state: "pending", message: "请输入六位数字。" })
            }
            return settle(request.params.id, false)
        })

        fastify.post(`${localCheckout}:id/cancel`, { bodyLimit: 256 }, async request => settle(request.params.id, true))
    }

    const msgpack = load("routes/cn/msgpack.js")
    const setPendingEncoder = msgpack.setCnMsgpackPendingEncoder
    msgpack.setCnMsgpackPendingEncoder = (reply, pendingEncoder) => {
        if (reply.request.routeOptions.url !== `${api}/load`) return setPendingEncoder(reply, pendingEncoder)
        const actor = identity(reply.request.body)
        if (!actor) return setPendingEncoder(reply, pendingEncoder)
        // Reuse the load route's SQLite transaction and project before packing.
        setPendingEncoder(reply, (payload, encode) => pendingEncoder(payload, result => {
            if (result?.data?.user_info) {
                const now = clock()
                deliverBenefits(actor.playerId, now)
                const { remain, dessert } = paymentBenefits(actor.playerId, now)
                const player = getPlayerSync(actor.playerId)
                result.data.user_info.month_card_remain_days = remain
                result.data.user_info.boost_point = player.boostPoint
                result.data.user_info.boss_boost_point = player.bossBoostPoint
                result.data.user_info.monthly_payment_total = monthlyTotal(actor.playerId, now)
                if (dessert) result.data.monthly_charge_bonus_info = dessert
            }
            return encode(result)
        }))
    }

    const registerMsgpack = msgpack.registerCnMsgpackOnSend
    msgpack.registerCnMsgpackOnSend = (fastify, encoder) => {
        registerMsgpack(fastify, encoder)
        fastify.addHook("preHandler", async (request, reply) => {
            const url = request.routeOptions.url
            if (!url?.startsWith(paymentChannel)) return
            const actor = identity(request.body)
            const action = url.slice(paymentChannel.length)
            if (action === "query_purcharge") {
                const order = orderById(request.body?.payment?.order_id)
                const state = actor && order?.player_id === actor.playerId ? orderState(order) : "missing"
                return response(reply, actor?.viewerId, { status: state === "paid" ? 3 : state === "pending" ? 1 : 4, msg: messages[state] ?? "" })
            }
            if (action === "query_unfinish_order") {
                const order = actor && db().prepare(`SELECT * FROM local_payment_orders WHERE player_id = ?
                    AND acknowledged = 0 AND paid_at IS NOT NULL ORDER BY paid_at DESC LIMIT 1`).get(actor.playerId)
                return response(reply, actor?.viewerId, order ? {
                    order_id: order.id, product_key: order.product_id, payment_money: order.price, exchangeRate: 1,
                } : { order_id: "" })
            }
        })
    }
}

module.exports = { install }
