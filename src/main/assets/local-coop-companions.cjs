"use strict"

const { AsyncLocalStorage } = require("node:async_hooks")
const path = require("node:path")
const { createTeamContent } = require("./team-content.cjs")

const slots = [0, 1, 2]
const mainRoles = [
    [["Attacker"], ["Attacker", "Balance"], ["Supporter", "Jammer"]],
    [["Healer"], ["Supporter", "Tank"], ["Jammer", "Balance"]],
]
const weaponTypes = new Set(["剑", "杖", "盾", "斧", "枪", "弓", "书", "拳", "饰品", "铳", "CN专属"])
const installations = new Map()

function clamp(value, min, max) {
    return Number.isFinite(value) ? Math.max(min, Math.min(value, max)) : min
}

function seedOrder(seed, id) {
    let hash = 2166136261
    const key = `${seed}:${id}`
    for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619)
    hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b)
    return ((hash ^ (hash >>> 16)) >>> 0) / 0x100000000
}

function pickBest(pool, score) {
    let best = null
    let bestScore = -Infinity
    for (const item of pool) {
        const value = score(item)
        if (value > bestScore) {
            best = item
            bestScore = value
        }
    }
    return best
}

function buildCatalog(repository, equipmentCatalog, teamContent) {
    const metadata = repository.table("character.json")
    const master = repository.table("cdndata/character.json")
    const skills = repository.table("cdndata/active_mission_skill_effects.json").characters
    const manaNodes = repository.table("mana_node.json")
    const characters = Object.entries(metadata).flatMap(([key, info]) => {
        const row = master[key]?.[0]
        if (!row || !manaNodes[key]?.[1] || !info.skill_count || info.rarity < 1 || info.rarity > 5) return []
        const effects = skills[key]?.effects ?? []
        const skill = teamContent?.skills.get(row[8])
        return [{
            id: Number(key),
            identity: Number(row[27]) || Number(key),
            element: info.element,
            rarity: info.rarity,
            role: row[26],
            heals: effects.some(effect => effect.endsWith("Heal") || effect === "ACRegeneration")
                || /(?:回复|恢复).{0,10}(?:生命|HP)|再生效果/.test(skill?.base?.[1] ?? ""),
            unisonable: skill ? skill.base?.[3] === "true" && (skill.evolved?.[3] ?? "true") === "true"
                : skills[key]?.unisonable === true,
        }]
    })
    const equipment = equipmentCatalog.ids.flatMap(id => {
        const info = equipmentCatalog.lookup[id]
        const maxLevel = equipmentCatalog.dissolveById[id]?.max_level
        if (!info || !weaponTypes.has(info.category) || !Number.isInteger(maxLevel) || maxLevel < 1) return []
        return [{ id, rarity: Number(info.rarity), maxLevel }]
    })
    return {
        characters,
        equipment,
        characterById: new Map(characters.map(unit => [unit.id, unit])),
        levels: repository.table("character_level.json"),
        manaNodes,
        manaBoards: repository.table("mana_board.json"),
        manaRequirements: repository.table("level_required_mana_node.json"),
    }
}

function pickCharacter(catalog, used, element, ceiling, roles, seed, unison = false) {
    const available = catalog.characters.filter(unit => !used.has(unit.identity)
        && unit.rarity <= ceiling && (!unison || unit.unisonable))
    const unit = pickBest(available, candidate => (
        (candidate.element === element ? 12 : 0)
        + (roles.includes(candidate.role) ? 5 : 0)
        + (roles.includes("Healer") && candidate.heals ? 2 : 0)
        + (candidate.rarity - ceiling) * 0.55
        + seedOrder(seed, candidate.id) * 2
    ))
    if (unit) used.add(unit.identity)
    return unit
}

function buildCharacter(unit, targetLevel, nodeBudget, catalog, rules) {
    if (unit === null) return null
    const levels = catalog.levels[unit.rarity]
    const caps = rules.characterExpCaps[unit.rarity]
    const exp = Math.min(levels[targetLevel], caps.at(-1))
    const overLimitStep = caps.findIndex(cap => cap >= exp)
    const nodes = catalog.manaNodes[unit.id][1]
    const board = catalog.manaBoards[unit.id]?.[1] ?? {}
    const learned = new Set()
    // The first board's display order follows parent links. A denied parent also denies descendants.
    for (const [fields] of Object.values(board)) {
        if (learned.size >= nodeBudget) break
        const id = Number(fields[0])
        const parent = fields[5]
        if (!nodes[id] || (parent !== "(None)" && !learned.has(Number(parent)))) continue
        const required = rules.getManaNodeRequiredLevel(catalog.manaRequirements, unit.rarity, nodes[id])
        if (required === null || required <= targetLevel) learned.add(id)
    }
    const evolutionLevel = rules.computeCharacterEvolutionLevel({
        nodes: rules.buildCharacterEvolutionNodes(nodes),
        learnedNodeIds: learned,
        awakeLevels: new Map(),
    })
    return {
        id: unit.id,
        evolution_level: evolutionLevel,
        exp,
        over_limit_step: overLimitStep,
        mana_node_ids: [...learned],
        ex_boost: null,
    }
}

function buildMate(comId, setup, usedCharacters, usedEquipment) {
    const { catalog, rules, readiness, targetLevel, element, seed, equipped, ownedEquipment, allowUnison } = setup
    const ceiling = readiness >= 0.62 ? 5 : readiness >= 0.28 ? 4 : 3
    const nodeBudget = Math.round(readiness * 24)
    const unisonCount = readiness >= 0.62 ? 3 : readiness >= 0.38 ? 2 : readiness >= 0.20 ? 1 : 0
    const roles = mainRoles[comId - 1]
    const characters = slots.map(slot => {
        const unit = pickCharacter(catalog, usedCharacters, element, ceiling, roles[slot], `${seed}:${comId}:main:${slot}`)
        return buildCharacter(unit, targetLevel, nodeBudget, catalog, rules)
    })
    const unisonCharacters = slots.map(slot => {
        if (!allowUnison || !characters[slot] || slot >= unisonCount) return null
        const unisonRoles = comId === 1 ? ["Attacker", "Supporter"] : ["Supporter", "Jammer"]
        const unit = pickCharacter(catalog, usedCharacters, element, ceiling, unisonRoles, `${seed}:${comId}:unison:${slot}`, true)
        return buildCharacter(unit, Math.max(1, targetLevel - 6), Math.floor(nodeBudget / 2), catalog, rules)
    })
    const equipments = slots.map(slot => {
        if (!characters[slot]) return null
        const weapon = pickBest(catalog.equipment, item => {
            if (usedEquipment.has(item.id) || item.rarity > ceiling) return -Infinity
            return (equipped.has(item.id) ? 3 : 0) + (ownedEquipment[item.id] ? 1 : 0)
                + (item.rarity - ceiling) * 0.85 + seedOrder(`${seed}:${comId}:weapon:${slot}`, item.id)
        })
        if (!weapon) return null
        usedEquipment.add(weapon.id)
        return {
            equipment_id: weapon.id,
            level: Math.round(clamp(1 + readiness * (weapon.maxLevel - 1), 1, weapon.maxLevel)),
            enhancement_level: 0,
        }
    })
    return {
        com_id: comId,
        degree_id: comId === 1 ? 1 : 2000,
        rank: Math.round(clamp(1 + readiness * 150, 1, 250)),
        party: { characters, unison_characters: unisonCharacters, equipments, ability_soul_ids: [null, null, null] },
    }
}

function lobbyParty(mate) {
    const option = (value, project) => value === null ? [1] : [0, project(value)]
    const character = ({ id, evolution_level, exp, over_limit_step, mana_node_ids }) => ({
        id,
        evolution_level,
        exp,
        over_limit_step,
        mana_node_ids: Object.fromEntries(mana_node_ids.map(id => [id, 0])),
        ex_boost: [1],
        illustration_settings: [1],
    })
    return {
        characters: mate.party.characters.map(value => option(value, character)),
        unison_characters: mate.party.unison_characters.map(value => option(value, character)),
        equipments: mate.party.equipments.map(value => option(value, item => ({
            equipmentId: item.equipment_id,
            level: item.level,
            enhancementLevel: item.enhancement_level,
        }))),
        abilitySoulIds: [[1], [1], [1]],
    }
}

function install(root) {
    const directory = path.resolve(root)
    if (installations.has(directory)) return installations.get(directory)

    const load = file => require(path.join(directory, "out", file))
    const content = load("content/runtime/content-snapshot.js")
    const { getQuestFromCategorySync } = load("lib/quest-content.js")
    const { QuestCategory } = load("lib/types/quest.js")
    const { PartyCategory } = load("data/types.js")
    const { getPlayerSync } = load("data/domains/player.js")
    const { getPlayerCharactersSync } = load("data/domains/character.js")
    const { getPlayerEquipmentListSync } = load("data/domains/equipment.js")
    const { getPlayerPartyGroupListSync } = load("data/domains/party.js")
    const { getFinishedPlayerQuestIdsBySectionsSync } = load("data/domains/quest.js")
    const { getPlayerRankLevel } = load("lib/player-rank-content.js")
    const { getEquipmentContentCatalog } = load("lib/equipment-content.js")
    const rules = {
        ...load("content/character-mana-admission.js"),
        ...load("lib/character-growth/exp-caps.js"),
        ...load("lib/character-evolution.js"),
    }
    const catalogs = new WeakMap()
    const teamCatalogs = new WeakMap()
    const startedCatalogLoads = new WeakSet()
    const cached = new Map()
    const nativeRooms = new WeakMap()
    const summonScope = new AsyncLocalStorage()
    const getTeamContent = createTeamContent(directory)
    const clearTables = new Map([
        [QuestCategory.MAIN, "main_quest.json"],
        [QuestCategory.BOSS_BATTLE, "boss_battle_quest.json"],
        [QuestCategory.ADVENT_EVENT_MULTI, "advent_event_quest.json"],
        [QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE, "world_story_event_boss_battle_quest.json"],
        [QuestCategory.HARD_MULTI_EVENT, "hard_multi_event_quest.json"],
    ])

    async function warmTeamCatalog(snapshot) {
        if (startedCatalogLoads.has(snapshot)) return
        startedCatalogLoads.add(snapshot)
        try {
            teamCatalogs.set(snapshot, await getTeamContent(snapshot))
            catalogs.delete(snapshot.repository)
        } catch (error) {
            console.warn("[MULTI] Companion skill catalog unavailable:", error)
        }
    }

    // Start loading after publication. TCP and virtual hosts use a synchronous builder.
    const initializeSnapshot = content.initializeContentSnapshot
    content.initializeContentSnapshot = async function (...args) {
        const snapshot = await initializeSnapshot.apply(this, args)
        void warmTeamCatalog(snapshot)
        return snapshot
    }
    const reloadSnapshot = content.reloadContentSnapshot
    content.reloadContentSnapshot = async function (...args) {
        const result = await reloadSnapshot.apply(this, args)
        void warmTeamCatalog(result.current)
        return result
    }

    function generate({ playerId, questId, category, roomSeed }) {
        const snapshot = content.getContentSnapshot()
        void warmTeamCatalog(snapshot)
        const { repository } = snapshot
        const teamContent = teamCatalogs.get(snapshot)
        const quest = getQuestFromCategorySync(category, questId)
        const player = getPlayerSync(playerId)
        if (!player || !quest || !("enemyLevel" in quest)) return null
        let catalog = catalogs.get(repository)
        if (!catalog) {
            catalog = buildCatalog(repository, getEquipmentContentCatalog(repository), teamContent)
            catalogs.set(repository, catalog)
        }

        const owned = getPlayerCharactersSync(playerId)
        const ownedEquipment = getPlayerEquipmentListSync(playerId)
        const groups = getPlayerPartyGroupListSync(playerId, PartyCategory.NORMAL)
        const parties = Object.values(groups).flatMap(group => Object.values(group.list))
        const strongest = pickBest(parties, party => {
            const members = [...party.characterIds, ...party.unisonCharacterIds]
            if (!owned[party.characterIds[0]] || members.some(id => id && !owned[id])) return -Infinity
            return clamp(party.currentBattlePower, 0, 12000)
        })
        const equipped = new Set(strongest?.equipmentIds ?? [])
        const trained = []
        for (const [id, state] of Object.entries(owned)) {
            const unit = catalog.characterById.get(Number(id))
            if (!unit) continue
            const caps = rules.characterExpCaps[unit.rarity]
            const step = Math.trunc(clamp(state.overLimitStep, 0, caps.length - 1))
            const exp = Math.trunc(clamp(state.exp, 0, caps[step]))
            const level = rules.getCharacterLevelByExperience(catalog.levels, unit.rarity, exp)
            trained.push((level - 1) * 0.85 / 99 + clamp(state.evolutionLevel, 0, 5) * 0.03)
        }
        trained.sort((left, right) => right - left)
        const growth = trained.slice(0, 6).reduce((sum, score) => sum + score, 0) / 6
        const finished = getFinishedPlayerQuestIdsBySectionsSync(playerId, [...clearTables.keys()])
        let clearScore = 0
        for (const [section, table] of clearTables) {
            const known = repository.table(table)
            const count = [...(finished[section] ?? [])].filter(id => Object.hasOwn(known, id)).length
            clearScore += count * (section === QuestCategory.MAIN ? 1 : 2)
        }
        const rank = clamp((getPlayerRankLevel(Math.trunc(clamp(player.rankPoint, 0, Number.MAX_SAFE_INTEGER)), repository) - 1) / 119, 0, 1)
        const power = clamp(strongest?.currentBattlePower / 12000, 0, 1)
        const cleared = clamp(clearScore / 120, 0, 1)
        const readiness = 0.20 * rank + 0.30 * growth + 0.30 * power + 0.20 * cleared
        const difficulty = clamp(quest.enemyLevel, 0, 100) / 100
        const targetLevel = Math.round(clamp(12 + 84 * readiness + 12 * difficulty, 1, 100))
        const gate = teamContent?.gates.get("condition_unison")?.[0]
        const allowUnison = gate?.[0] === "0" && finished[QuestCategory.MAIN]?.has(Number(gate[4]))
        const seed = `${playerId}:${category}:${questId}:${roomSeed}`
        const element = Number.isInteger(quest.element) && quest.element >= 0 && quest.element < 6
            ? quest.element : Math.floor(seedOrder(seed, "element") * 6)
        const setup = { catalog, rules, readiness, targetLevel, element, seed, equipped, ownedEquipment, allowUnison }
        const usedCharacters = new Set()
        const usedEquipment = new Set()
        const mate1 = buildMate(1, setup, usedCharacters, usedEquipment)
        const mate2 = buildMate(2, setup, usedCharacters, usedEquipment)
        return [mate1, mate2].every(mate => mate.party.characters.every(Boolean)) ? { mate1, mate2 } : null
    }

    function buildCompanions({ playerId, questId, category, roomSeed }) {
        if (![playerId, questId, category].every(id => Number.isSafeInteger(id) && id > 0)
            || (typeof roomSeed !== "string" && !Number.isSafeInteger(roomSeed)) || roomSeed === "") return null
        const key = JSON.stringify([playerId, questId, category, roomSeed])
        let mates = cached.get(key)
        if (!mates) {
            try {
                mates = generate({ playerId, questId, category, roomSeed })
            } catch (error) {
                if (error?.code !== "CONTENT_SNAPSHOT_NOT_INITIALIZED") {
                    console.warn("[MULTI] Adaptive companion loadout unavailable:", error)
                }
                return null
            }
            if (!mates) return null
        }
        cached.delete(key)
        cached.set(key, mates)
        if (cached.size > 128) cached.delete(cached.keys().next().value)
        return structuredClone(mates)
    }

    const { getRoom } = load("multi/room/manager.js")
    function forRoom(room) {
        if (!room) return null
        if (nativeRooms.has(room)) return nativeRooms.get(room)
        const mates = buildCompanions({
            playerId: room.host_player_id,
            questId: room.quest_id,
            category: room.category,
            roomSeed: room.access_token,
        })
        if (mates) nativeRooms.set(room, mates)
        return mates
    }

    const roomRoutes = load("multi/http/room.js")
    const register = roomRoutes.registerRoomRoutes
    roomRoutes.registerRoomRoutes = (fastify, context) => {
        fastify.addHook("onRoute", route => {
            if (route.method !== "POST" || route.url !== `${fastify.prefix}/summon`) return
            const handleSummon = route.handler
            route.handler = function (request, reply) {
                return summonScope.run(request.body, () => handleSummon.call(this, request, reply))
            }
        })
        return register(fastify, context)
    }

    const builder = load("multi/npc/builder.js")
    const buildOriginal = builder.buildNpcMates
    builder.buildNpcMates = function (questId, category) {
        const request = summonScope.getStore()
        if (request && typeof request.room_number === "string") {
            const room = getRoom(request.room_number)
            if (room?.host_viewer_id === request.viewer_id && room.quest_id === questId && room.category === category) {
                const mates = forRoom(room)
                if (mates) return structuredClone(mates)
            }
        }
        return buildOriginal.apply(this, arguments)
    }

    const { NpcMateProvider } = load("multi/npc/controller.js")
    const getOriginalMates = NpcMateProvider.prototype.getMates
    NpcMateProvider.prototype.getMates = function (roomNumber) {
        const mates = forRoom(getRoom(roomNumber))
        return mates ? structuredClone([mates.mate1, mates.mate2]) : getOriginalMates.call(this, roomNumber)
    }

    const { sessionManager } = load("multi/state/SessionManager.js")
    const create = sessionManager.createClient
    sessionManager.createClient = function (...args) {
        const client = create.apply(this, args)
        let explicit = client.npcPartySnapshots
        // Lobby reconstruction and direct EnterComs share this native snapshot reader.
        Object.defineProperty(client, "npcPartySnapshots", {
            get() {
                if (explicit.length) return explicit
                const mates = forRoom(getRoom(client.roomNumber))
                return mates ? [lobbyParty(mates.mate1), lobbyParty(mates.mate2)] : explicit
            },
            set(parties) { explicit = parties },
        })
        return client
    }

    const api = { buildCompanions }
    installations.set(directory, api)
    return api
}

module.exports = { install }
