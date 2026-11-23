"use strict"

const path = require("node:path")
const { createRequire } = require("node:module")
const absent = "(None)"
const encyclopediaTable = "master/encyclopedia/encyclopedia.orderedmap"
const tagQuestTable = "master/encyclopedia/encyclopedia_tag_quest_relation.orderedmap"

function positiveId(value, subject) {
    const id = Number(value)
    if (!Number.isSafeInteger(id) || id < 1) throw new Error(`Invalid encyclopedia ID for ${subject}: ${value}`)
    return id
}

function parseRules(keywordRows, tagRows, parseCsvLine, calendar, QuestCategory) {
    // QuestReferenceIdKind in the client and QuestCategory in the save use different indices.
    const categories = [
        QuestCategory.MAIN, QuestCategory.EX, QuestCategory.BOSS_BATTLE,
        QuestCategory.DAILY_WEEK_EVENT, QuestCategory.RANKING_EVENT_SINGLE, QuestCategory.STORY_EVENT_SINGLE,
        QuestCategory.ADVENT_EVENT_SINGLE, QuestCategory.CHALLENGE_DUNGEON_EVENT, QuestCategory.DAILY_EXP_MANA_EVENT,
        QuestCategory.WORLD_STORY_EVENT, QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE, QuestCategory.TOWER_DUNGEON_EVENT,
        QuestCategory.EXPERT_SINGLE_EVENT, QuestCategory.CARNIVAL_EVENT, QuestCategory.CHARACTER, QuestCategory.RAID_EVENT,
        QuestCategory.RUSH_EVENT, QuestCategory.SOLO_TIME_ATTACK_EVENT, QuestCategory.HARD_MULTI_EVENT, QuestCategory.SCORE_ATTACK_EVENT,
    ]
    const sections = new Set()

    function parseQuest(kind, multipliedIds, subject) {
        const section = categories[kind]
        if (section === undefined) throw new Error(`Unknown encyclopedia quest kind ${kind} for ${subject}`)
        const ids = multipliedIds.split(",").map(value => positiveId(value, subject))
        sections.add(section)
        return { section, ids }
    }

    const tagQuests = new Map()
    for (const { key, text } of tagRows) {
        const [tag, kind, , , , multipliedIds] = parseCsvLine(text, `encyclopedia tag quest ${key}`)
        const quests = tagQuests.get(tag) ?? []
        quests.push(parseQuest(kind, multipliedIds, `tag ${tag}`))
        tagQuests.set(tag, quests)
    }

    const entries = new Map()
    for (const keyword of keywordRows) {
        for (const row of keyword.rows) {
            const subject = `${keyword.key}/${row.key}`
            const fields = parseCsvLine(row.text, `encyclopedia ${subject}`)
            const id = 100 * positiveId(keyword.key, subject) + positiveId(row.key, subject)
            if (fields.length !== 40 || Number(fields[0]) !== id || entries.has(id)
                || (fields[2] !== "true" && fields[2] !== "false")) {
                throw new Error(`Invalid encyclopedia record ${subject}`)
            }
            const characters = fields.slice(21, 23).filter(value => value !== absent)
                .map(value => positiveId(value, subject))
            const quests = [23, 28].filter(column => fields[column] !== absent)
                .map(column => parseQuest(fields[column], fields[column + 4], subject))
            const tags = fields.slice(33, 35).filter(value => value !== absent).map(tag => {
                const relatedQuests = tagQuests.get(tag)
                if (!relatedQuests) throw new Error(`Missing encyclopedia tag ${tag} for ${subject}`)
                return relatedQuests
            })
            const prerequisites = [35, 37].filter(column => fields[column] !== absent).map(column =>
                100 * positiveId(fields[column], subject) + positiveId(fields[column + 1], subject))
            if (!characters.length && !quests.length && !tags.length && !prerequisites.length) {
                throw new Error(`Missing encyclopedia conditions for ${subject}`)
            }
            entries.set(id, {
                id, characters, quests, tags, prerequisites,
                visibleAfter: fields[2] === "true" ? calendar.parseMasterTimestamp(fields[3]) : -Infinity,
            })
        }
    }
    for (const entry of entries.values()) {
        if (entry.prerequisites.some(id => !entries.has(id))) {
            throw new Error(`Missing prerequisite for encyclopedia entry ${entry.id}`)
        }
    }
    return { entries, sections: [...sections] }
}

function unlockedEntries(rules, player, now) {
    const unlocked = new Map()
    const cleared = ({ section, ids }) => ids.some(id => player.cleared[section]?.has(id))
    let pending = []
    for (const entry of rules.entries.values()) {
        if (entry.visibleAfter > now) continue
        if (player.recorded.has(entry.id)) {
            unlocked.set(entry.id, { read: player.recorded.get(entry.id) })
        } else if (entry.characters.every(id => player.characters.has(id))
            && entry.quests.every(cleared)
            && entry.tags.every(quests => quests.some(cleared))) {
            pending.push(entry)
        }
    }
    // Prerequisite keywords can occur anywhere in the master table, including after their dependants.
    while (pending.length) {
        const waiting = []
        for (const entry of pending) {
            if (entry.prerequisites.every(id => unlocked.has(id))) {
                unlocked.set(entry.id, { read: false })
            } else {
                waiting.push(entry)
            }
        }
        if (waiting.length === pending.length) break
        pending = waiting
    }
    return unlocked
}

function requestIds(body) {
    const ids = body?.encyclopedia_ids
    if (!Array.isArray(ids) || ids.length > 2000
        || !ids.every(id => Number.isSafeInteger(id) && id > 0)) return null
    return [...new Set(ids)]
}

function install(root) {
    const load = relative => require(path.join(root, "out", relative))
    const { getDb } = load("data/db.js")
    const { resolvePlayerIdSync } = load("data/activeAccount.js")
    const { getSessionSync } = load("data/domains/session.js")
    const { SessionType } = load("data/types.js")
    const { getFinishedPlayerQuestIdsBySectionsSync } = load("data/domains/quest.js")
    const { getPlayerItemSync } = load("data/domains/item.js")
    const { deductInventoryItemWithinTransactionSync } = load("lib/inventory/index.js")
    const { getMailArrivedSync } = load("lib/mail-notification.js")
    const { mergeCommonResponseFragments } = load("lib/common-response/merge.js")
    const { generateDataHeaders, getServerTime } = load("utils.js")
    const { getGameCalendar } = load("time/game-calendar-provider.js")
    const { getContentSnapshot } = load("content/runtime/content-snapshot.js")
    const { resolveContentPaths } = load("content/paths.js")
    const { hashContentResourcePath } = load("content/resource-path.js")
    const { ArchiveIndex } = load("content/sync/archive-index.js")
    const { parseTextOrderedMap, parseNestedTextOrderedMaps } = load("content/sync/ordered-map.js")
    const { parseCsvLine } = load("content/converters/csv.js")
    const { QuestCategory } = load("lib/types/quest.js")
    const { Open } = createRequire(path.join(root, "out/content/sync/archive-index.js"))("unzipper")

    const physical = logical => `production/upload/${hashContentResourcePath(logical).relativePath}`
    const keywordPath = physical(encyclopediaTable)
    const tagPath = physical(tagQuestTable)
    let cachedSnapshot
    let rulesPromise
    let statements

    async function loadRules(snapshot) {
        const paths = resolveContentPaths({ projectRoot: root })
        // Use the same full/diff order and archive roots as content sync, indexing only these two entries.
        const index = await ArchiveIndex.build(snapshot.cdn, paths, snapshot.archiveSources, {
            openArchive: async file => {
                const { files } = await Open.file(file)
                return { files: files.filter(entry => entry.path === keywordPath || entry.path === tagPath) }
            },
        })
        const [keywordBytes, tagBytes] = await Promise.all([index.read(keywordPath), index.read(tagPath)])
        return parseRules(parseNestedTextOrderedMaps(keywordBytes), parseTextOrderedMap(tagBytes),
            parseCsvLine, getGameCalendar(), QuestCategory)
    }

    async function getRules() {
        const snapshot = getContentSnapshot()
        if (cachedSnapshot !== snapshot || !rulesPromise) {
            cachedSnapshot = snapshot
            rulesPromise = loadRules(snapshot)
        }
        const pending = rulesPromise
        try {
            return await pending
        } catch (error) {
            if (rulesPromise === pending) rulesPromise = undefined
            throw error
        }
    }

    function storage() {
        const db = getDb()
        if (statements?.db !== db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS local_encyclopedia_progress (
                    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
                    info_id INTEGER NOT NULL,
                    is_read INTEGER NOT NULL DEFAULT 0,
                    used_key INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (player_id, info_id)
                )
            `)
            statements = {
                db,
                characters: db.prepare("SELECT id FROM players_characters WHERE player_id = ?").pluck(),
                recorded: db.prepare("SELECT info_id, is_read FROM local_encyclopedia_progress WHERE player_id = ?"),
                rememberUnlock: db.prepare(`
                    INSERT INTO local_encyclopedia_progress (player_id, info_id) VALUES (?, ?)
                    ON CONFLICT (player_id, info_id) DO NOTHING
                `),
                markRead: db.prepare(`
                    INSERT INTO local_encyclopedia_progress (player_id, info_id, is_read) VALUES (?, ?, 1)
                    ON CONFLICT (player_id, info_id) DO UPDATE SET is_read = 1
                `),
                useKey: db.prepare(`
                    INSERT INTO local_encyclopedia_progress (player_id, info_id, used_key) VALUES (?, ?, 1)
                    ON CONFLICT (player_id, info_id) DO UPDATE SET used_key = 1
                `),
            }
        }
        return statements
    }

    function progress(rules, playerId, store) {
        return {
            characters: new Set(store.characters.all(playerId)),
            cleared: getFinishedPlayerQuestIdsBySectionsSync(playerId, rules.sections),
            recorded: new Map(store.recorded.all(playerId).map(row => [row.info_id, Boolean(row.is_read)])),
        }
    }

    function rememberUnlocks(store, playerId, recorded, entries) {
        for (const id of entries.keys()) {
            if (!recorded.has(id)) store.rememberUnlock.run(playerId, id)
        }
    }

    function response(reply, viewerId, encyclopediaList, fragments = []) {
        return reply.type("application/x-msgpack").send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: { encyclopedia_list: Object.fromEntries(encyclopediaList), ...mergeCommonResponseFragments(fragments) },
        })
    }

    const routes = load("routes/api/encyclopedia.js")
    routes.default = async fastify => {
        function post(route, handler) {
            fastify.post(route, async (request, reply) => {
                const viewerId = request.body?.viewer_id
                const session = Number.isSafeInteger(viewerId) && viewerId > 0
                    ? getSessionSync(String(viewerId)) : null
                if (session?.type !== SessionType.VIEWER) return reply.code(400).send({ message: "Invalid viewer id." })
                const playerId = resolvePlayerIdSync(session.accountId)
                if (playerId === null) return reply.code(500).send({ message: "No player bound to account." })

                const ids = route === "/index" ? [] : requestIds(request.body)
                if (ids === null) return reply.code(400).send({ message: "Invalid encyclopedia IDs." })
                const rules = await getRules()
                const store = storage()
                const now = getServerTime() * 1000
                const result = store.db.transaction(() => {
                    const player = progress(rules, playerId, store)
                    return handler({ rules, store, now, player, playerId, ids, unlocked: unlockedEntries(rules, player, now) })
                })()
                if (!result) return reply.code(400).send({ message: "Cannot unlock the requested encyclopedia entries." })
                return response(reply, viewerId, result.entries, result.fragments)
            })
        }

        post("/index", ({ store, playerId, player, unlocked }) => {
            // Save unlocks proven by existing player data, including on the first visit after an upgrade.
            rememberUnlocks(store, playerId, player.recorded, unlocked)
            return { entries: unlocked, fragments: [{ mail_arrived: getMailArrivedSync(playerId) }] }
        })

        post("/read_keyword", ({ store, playerId, ids, unlocked }) => {
            const entries = new Map()
            for (const id of ids) {
                if (!unlocked.has(id)) continue
                store.markRead.run(playerId, id)
                entries.set(id, { read: true })
            }
            return { entries }
        })

        post("/unlock_keyword", ({ rules, store, now, player, playerId, ids, unlocked }) => {
            if (ids.some(id => !rules.entries.has(id) || rules.entries.get(id).visibleAfter > now)) return null
            const requested = ids.filter(id => !unlocked.has(id))
            if (!requested.length) return { entries: new Map() }
            const config = getContentSnapshot().repository.table("config.json")
            const itemId = positiveId(config.encyclopedia_point_item_id, "record key")
            if ((getPlayerItemSync(playerId, itemId) ?? 0) < requested.length) return null
            const { afterAmount } = deductInventoryItemWithinTransactionSync({
                playerId, itemId, amount: requested.length,
            })
            const entries = new Map()
            for (const id of requested) {
                store.useKey.run(playerId, id)
                player.recorded.set(id, false)
            }
            const after = unlockedEntries(rules, player, now)
            for (const id of requested) entries.set(id, after.get(id))
            for (const [id, state] of after) {
                if (!unlocked.has(id)) entries.set(id, state)
            }
            rememberUnlocks(store, playerId, player.recorded, entries)
            return { entries, fragments: [{ item_list: { [itemId]: afterAmount } }] }
        })
    }
}

module.exports = { install, parseRules, unlockedEntries }
