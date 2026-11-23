"use strict"

const path = require("node:path")
const { createRequire } = require("node:module")
const elementIds = { Red: 0, Blue: 1, Yellow: 2, Green: 3, White: 4, Black: 5 }
const instantKinds = { 32: "attack", 33: "direct", 34: "skill", 35: "gauge", 50: "fever", 55: "flip",
    211: "gauge", 212: "gauge", 213: "fever", 521: "multiHit", 529: "combo" }
const duringKinds = { 0: "attack", 1: "direct", 2: "skill", 3: "gauge", 18: "fever", 23: "flip", 252: "multiHit", 256: "combo" }
const conditionKinds = { 8: "hpHigh", 9: "hpLow", 10: "combo", 12: "fever", 13: "multiball", 204: "hpHigh", 205: "hpLow" }
const readers = new Map()
const sources = {
    leader: "ability/leader_ability",
    abilities: "ability/ability",
    souls: "ability/ability_soul",
    equipment: "item/equipment",
    skills: "skill/action_skill",
    gates: "game_system_unlock/game_system_unlock_condition",
    bossNodes: "quest/boss_battle_stage_node",
}

function parseEffectRows(rows, parseCsv, shift) {
    return new Map(rows.map(({ key, text }) => {
        const effects = []
        for (const line of text.split(/\r?\n/)) {
            if (line.length < 80) continue
            const fields = parseCsv(line, `ability ${key}`)
            const triggerKind = fields[3 + shift]
            if (triggerKind !== "0" && triggerKind !== "1") continue
            const during = triggerKind === "1"
            const index = (during ? 107 : 45) + shift
            const effectCode = fields[index]
            const kind = (during ? duringKinds : instantKinds)[effectCode]
            if (!kind) continue
            const groups = (fields[index + 2] ?? "").split(",").filter(group => group && group !== "(None)")
            const minimum = Number(fields[index + 4])
            const maximum = Number(fields[index + 5])
            if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) continue
            const conditions = [4, 11, 18].map(column => fields[column + shift])
                .filter(value => value !== "0" && value !== "(None)" && value !== "")
                .map(value => conditionKinds[value] ?? "other")
            const target = fields[index + 1] === "" ? -1 : Number(fields[index + 1])
            const timed = during ? fields[83 + shift] !== "0" || fields[95 + shift] !== "0" : fields[25 + shift] !== "0"
            effects.push({
                kind, target, elements: groups.flatMap(group => Object.hasOwn(elementIds, group) ? [elementIds[group]] : []),
                uncertainTarget: groups.some(group => !Object.hasOwn(elementIds, group)),
                conditions, trigger: timed ? 0.56 : 1, minimum, maximum,
                addsFever: !during && effectCode === "213",
                awakeKind: Number(fields[1 + shift]), awakeLevel: Number(fields[2 + shift]),
                unisonable: shift === 2 && fields[1] === "true",
            })
        }
        return [key, effects]
    }))
}

function scaledEffects(effects, fraction, awakeLevel, sub = false, maxVariant = 1) {
    const rows = (effects ?? []).filter(effect => effect.awakeKind !== 1 || effect.awakeLevel <= maxVariant)
    const switched = Math.max(-1, ...rows.filter(effect => effect.awakeKind === 1 && effect.awakeLevel <= awakeLevel)
        .map(effect => effect.awakeLevel))
    return rows.filter(effect => (!sub || effect.unisonable)
        && (effect.awakeKind === 0 || effect.awakeKind === 1 && effect.awakeLevel === switched
            || effect.awakeKind === 2 && effect.awakeLevel <= awakeLevel)).map(effect => ({
        ...effect,
        value: Math.max(0, (effect.minimum + (effect.maximum - effect.minimum) * fraction) / 100000),
    }))
}

function loadTags(text, structured, icon) {
    return Object.fromEntries([
        ["damage", /(?:造成|给予).{0,18}伤害/.test(text) || /(?:^|\/)atk_/.test(icon)],
        ["heal", structured?.effects?.some(effect => /Heal|Regeneration/.test(effect)) === true
            || /回复.{0,10}(?:生命值|生命|HP)|恢复.{0,10}(?:生命值|生命|HP)|(?:生命值|生命|HP).{0,10}(?:回复|恢复)|再生效果/.test(text)],
        ["elementHeal", /(?:火|水|雷|风|光|暗)属性.{0,12}(?:回复|恢复|再生)|(?:回复|恢复).{0,12}(?:火|水|雷|风|光|暗)属性/.test(text)],
        ["guard", /护盾|伤害减免|伤害降低|代替.{0,5}承受|抗性提升|无敌效果/.test(text)],
        ["cleanse", /解除.{0,12}(?:弱化|异常)|净化/.test(text)],
        ["dispel", /解除.{0,12}(?:强化|增益)|消除.{0,12}(?:强化|增益)|驱散/.test(text)],
        ["combo", /连击|连续攻击|多段/.test(text) || /mult(i|iple)|continuous/.test(icon)],
        ["fever", /FEVER.{0,10}(?:增加|积攒|提升)|(?:增加|提升|积攒).{0,10}FEVER/i.test(text)],
        ["multiball", /协力球|协同球|召唤.{0,14}参战/.test(text) || /multi_ball/.test(icon)],
        ["piercing", /贯通效果|贯穿效果/.test(text)],
        ["floating", /浮游效果/.test(text)],
        ["lowHp", /(?:消耗|失去|减少).{0,14}(?:自身|己方).{0,12}(?:生命|HP)|牺牲.{0,14}生命/.test(text)],
    ].filter(([, present]) => present))
}

function activeEffects(text) {
    const result = []
    const allyTarget = /全体参战者|全体队员|队伍全体|所有参战者|全队/.test(text) ? 5 : 0
    const targets = [...new Set([...text.matchAll(/([火水雷风光暗])属性(?:的)?角色/g)]
        .map(match => "火水雷风光暗".indexOf(match[1])))]
    const skills = [
        ["attack", /攻击力.{0,5}(?:提升|增加)|(?:提升|增加).{0,12}攻击力/, 0.3],
        ["skill", /技能伤害.{0,5}(?:提升|增加)|(?:提升|增加).{0,12}技能伤害/, 0.35],
        ["flip", /强化弹射.{0,8}(?:增加|提升)|(?:提升|增加).{0,12}强化弹射/, 0.35],
        ["direct", /直接攻击.{0,8}(?:增加|提升)|(?:提升|增加).{0,12}直接攻击/, 0.35],
        ["gauge", /技能槽.{0,6}(?:提升|增加|回复)|(?:提升|增加|回复|提升至).{0,12}技能槽|技能充能/, 0.28],
        ["combo", /增加.{0,10}连击|连击数.{0,5}增加/, 0.24],
        ["multiHit", /直接攻击.{0,8}多段|攻击变为.{0,7}段/, 0.34],
    ]
    for (const [kind, pattern, value] of skills) {
        if (!pattern.test(text)) continue
        result.push({ kind, value, target: /队长.{0,14}技能槽/.test(text) && kind === "gauge" ? 2 : allyTarget,
            elements: targets, conditions: [], trigger: 0.85, uncertainTarget: false })
    }
    return result
}

function learnedSlots(rawNodes, characterId, ownedNodes) {
    const slots = new Map()
    for (const [nodeIdText, awake] of Object.entries(ownedNodes ?? {})) {
        const id = Number(nodeIdText)
        const board = Math.floor(id / 200) % 10
        const row = rawNodes[characterId]?.[board]?.[id % 200]?.[0]
        if (row?.[1] !== "0" || row[5] !== "0") continue
        const slot = Number(row[6])
        const count = slots.get(slot) ?? { level: 0, awake: 0 }
        slots.set(slot, { level: count.level + 1, awake: Math.max(count.awake, Number(awake)) })
    }
    return slots
}

function buildOwnedPartyData(content, repository, owned, mana, inventory, levelOf) {
    const characterRows = repository.table("cdndata/character.json")
    const rawNodes = repository.table("mana_node_raw.json")
    const healingFacts = repository.table("cdndata/active_mission_skill_effects.json").characters
    const characters = []
    for (const [key, entry] of Object.entries(owned)) {
        const id = Number(key)
        const row = characterRows[id]?.[0]
        if (!row) continue
        const rarity = Number(row[2])
        const element = Number(row[3])
        if (!Number.isInteger(rarity) || element < 0 || element > 5 || !Number.isInteger(element)) continue
        const level = levelOf(id, rarity, entry.exp)
        const skill = content.skills.get(row[8])
        const skillLevel = entry.evolutionLevel > 0 ? skill?.evolved ?? skill?.base : skill?.base
        const tags = loadTags(skillLevel?.[1] ?? "", healingFacts[id], skillLevel?.[2] ?? "")
        const growth = level * 0.47 + rarity * 2.35 + 1.5 * entry.evolutionLevel + 0.7 * entry.overLimitStep
            + 0.5 * Math.min(Object.keys(mana[id] ?? {}).length, 35)
        const slots = learnedSlots(rawNodes, id, mana[id])
        const maxPowers = String(row[36] ?? "").split(",").map(Number)
        const mainEffects = []
        const unisonEffects = []
        for (const [slot, learned] of slots) {
            if (slot < 1 || slot > 6) continue
            const power = Math.max(1, maxPowers[slot - 1] || 1)
            const ratio = learned.awake > 0 ? 1 : Math.max(0, learned.level - 1) / Math.max(1, power - 1)
            const effects = content.abilities.get(row[18 + slot])
            mainEffects.push(...scaledEffects(effects, Math.min(ratio, 1), learned.awake, false, Infinity))
            unisonEffects.push(...scaledEffects(effects, Math.min(ratio, 1), learned.awake, true, Infinity))
        }
        const leader = scaledEffects(content.leader.get(row[17]), entry.evolutionLevel > 0 ? 1 : 0, entry.evolutionLevel)
        characters.push({
            id, element, growth, tags, leader, mainEffects, unisonEffects,
            identity: Number(row[27]) || id,
            evolution: Math.max(0, entry.evolutionLevel),
            unisonable: skillLevel?.[3] !== "false",
            skillWeight: Number(entry.evolutionLevel > 0 ? skillLevel?.[5] : skillLevel?.[4]) || 0,
            active: activeEffects(skillLevel?.[1] ?? ""),
        })
    }
    const equipment = []
    for (const [key, entry] of Object.entries(inventory)) {
        const row = content.equipment.get(key)
        if (!row) continue
        const maxLevel = Math.max(1, Number(row[8]))
        const ratio = Math.max(0, Math.min(1, (entry.level - 1) / Math.max(1, maxLevel - 1)))
        equipment.push({
            id: Number(key), base: 1 + 1.1 * Number(row[11]) + 3.7 * ratio + 0.22 * entry.enhancementLevel,
            effects: scaledEffects(content.souls.get(row[10]), ratio, entry.enhancementLevel),
        })
    }
    return { characters, equipment }
}

function createTeamContent(root) {
    root = path.resolve(root)
    if (readers.has(root)) return readers.get(root)
    const load = file => require(path.join(root, "out", file))
    const { resolveContentPaths } = load("content/paths.js")
    const { hashContentResourcePath } = load("content/resource-path.js")
    const { ArchiveIndex } = load("content/sync/archive-index.js")
    const { parseTextOrderedMap, parseNestedTextOrderedMaps } = load("content/sync/ordered-map.js")
    const { parseCsvLine } = load("content/converters/csv.js")
    const { Open } = createRequire(path.join(root, "out/content/sync/archive-index.js"))("unzipper")
    const paths = Object.fromEntries(Object.entries(sources).map(([key, name]) => [
        key, "production/upload/" + hashContentResourcePath(`master/${name}.orderedmap`).relativePath,
    ]))
    const wanted = new Set(Object.values(paths))
    const cache = new WeakMap()

    async function loadCatalog(snapshot) {
        const index = await ArchiveIndex.build(snapshot.cdn, resolveContentPaths({ projectRoot: root }), snapshot.archiveSources, {
            openArchive: async file => {
                const { files } = await Open.file(file)
                return { files: files.filter(entry => wanted.has(entry.path)) }
            },
        })
        const raw = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, file]) =>
            [key, await index.read(file)])))
        const fields = ({ key, text }) => parseCsvLine(text, `team content ${key}`)
        const skills = new Map(parseNestedTextOrderedMaps(raw.skills).map(entry => {
            const levels = new Map(entry.rows.map(row => [row.key, fields(row)]))
            return [entry.key, { base: levels.get("1") ?? levels.values().next().value, evolved: levels.get("2") }]
        }))
        const gates = new Map(parseNestedTextOrderedMaps(raw.gates).map(entry =>
            [entry.key, entry.rows.map(fields)]))
        const bossNodes = new Map(parseNestedTextOrderedMaps(raw.bossNodes).flatMap(entry =>
            entry.rows.map(row => [1000 * Number(entry.key) + Number(row.key), Number(fields(row)[2])])))
        return {
            leader: parseEffectRows(parseTextOrderedMap(raw.leader), parseCsvLine, 0),
            abilities: parseEffectRows(parseTextOrderedMap(raw.abilities), parseCsvLine, 2),
            souls: parseEffectRows(parseTextOrderedMap(raw.souls), parseCsvLine, -1),
            equipment: new Map(parseTextOrderedMap(raw.equipment).map(row => [row.key, fields(row)])),
            skills, gates, bossNodes,
        }
    }

    const read = snapshot => {
        if (!cache.has(snapshot)) {
            cache.set(snapshot, loadCatalog(snapshot).catch(error => {
                cache.delete(snapshot)
                throw error
            }))
        }
        return cache.get(snapshot)
    }
    readers.set(root, read)
    return read
}

module.exports = { buildOwnedPartyData, createTeamContent }
