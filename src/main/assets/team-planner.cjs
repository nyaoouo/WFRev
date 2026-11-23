"use strict"

const elements = ["火", "水", "雷", "风", "光", "暗"]
const profiles = [
    { key: "balanced", label: "稳健推图", weights: { attack: 1, skill: 0.6, direct: 0.55, flip: 0.65, gauge: 0.85, combo: 0.35 }, sustain: 15 },
    { key: "skill", label: "技能伤害", weights: { attack: 0.9, skill: 1.45, gauge: 1.15, combo: 0.2 }, sustain: 8 },
    { key: "flip", label: "强化弹射", weights: { attack: 1, flip: 1.5, combo: 1, gauge: 0.35 }, sustain: 9 },
    { key: "direct", label: "直接攻击", weights: { attack: 1, direct: 1.45, multiHit: 1.2, gauge: 0.35 }, sustain: 10 },
]
const allSlots = [0, 1, 2]

function compatibleEffect(effect, target) {
    if (effect.elements.length && !effect.elements.includes(target.element)) return 0
    return effect.uncertainTarget ? 0.2 : 1
}

function affectedSlots(effect, slot) {
    switch (effect.target) {
        case 0: return [slot]
        case 1: return allSlots.filter(index => index !== slot)
        case 2: return [0]
        case 3: return [1]
        case 4: return [2]
        case 5:
        case 6: return allSlots
        default: return effect.kind === "flip" || effect.kind === "combo" ? [0] : []
    }
}

function uptime(effect, flags) {
    let weight = effect.trigger
    for (const condition of effect.conditions) {
        switch (condition) {
            case "fever": weight *= flags.fever ? 0.62 : 0; break
            case "multiball": weight *= flags.multiball ? 0.72 : 0; break
            case "piercing": weight *= flags.piercing ? 0.72 : 0; break
            case "floating": weight *= flags.floating ? 0.72 : 0; break
            case "combo": weight *= flags.combo ? 0.65 : 0.22; break
            case "hpHigh": weight *= flags.heal || flags.guard ? 0.8 : 0.42; break
            case "hpLow": weight *= flags.lowHp ? 0.55 : 0.16; break
            default: weight *= 0.27
        }
    }
    return weight
}

function partyEffects(party) {
    return [
        ...party.main[0].leader,
        ...party.main.flatMap(unit => unit.mainEffects.concat(unit.active)),
        ...party.unison.filter(Boolean).flatMap(unit => unit.unisonEffects.concat(unit.active)),
        ...party.equipment.filter(Boolean).flatMap(item => item.effects),
    ]
}

function partyFlags(party) {
    const flags = Object.assign({}, ...party.main.concat(party.unison.filter(Boolean)).map(unit => unit.tags))
    for (const effect of partyEffects(party)) {
        if (effect.conditions.includes("fever")) flags.feverPayoff = true
        else if (effect.addsFever && effect.value > 0) flags.fever = true
    }
    return flags
}

function partyScore(party, profile, targetElement) {
    const { main, unison, equipment } = party
    const totals = main.map(() => ({}))
    const flags = partyFlags(party)
    let score = 0
    function addEffects(effects, owner) {
        for (const effect of effects) {
            const value = effect.value * uptime(effect, flags)
            if (value <= 0) continue
            for (const slot of affectedSlots(effect, owner)) {
                if (!main[slot]) continue
                const strength = value * compatibleEffect(effect, main[slot])
                totals[slot][effect.kind] = (totals[slot][effect.kind] ?? 0) + strength
            }
        }
    }
    for (const [slot, unit] of main.entries()) {
        const companion = unison[slot]
        score += 65 + unit.growth + (targetElement === unit.element ? 17 : 0)
        if (slot === 0) {
            score += targetElement === unit.element ? 12 : 0
            addEffects(unit.leader, 0)
        }
        addEffects(unit.mainEffects, slot)
        addEffects(unit.active, slot)
        if (companion) {
            score += 15 + companion.growth * 0.29 + (unit.element === companion.element ? 3 : 0)
            addEffects(companion.unisonEffects, slot)
            addEffects(companion.active, slot)
            if (profile.key === "skill" && unit.skillWeight && companion.skillWeight) {
                score -= Math.max(0, (unit.skillWeight + companion.skillWeight) / 2 - 480) / 38
            }
        }
        if (equipment[slot]) {
            score += equipment[slot].base
            addEffects(equipment[slot].effects, slot)
        }
    }

    for (const [slot, boosts] of totals.entries()) {
        for (const [kind, weight] of Object.entries(profile.weights)) {
            // A second multiplier has more value than repeatedly stacking one already saturated multiplier.
            const focus = slot === 0 && (kind === "flip" || profile.key === "skill") ? 1.4 : 1
            score += 21 * weight * Math.log1p(boosts[kind] ?? 0) * focus
        }
        if (main[slot].tags.damage && profile.key === "skill") score += slot === 0 ? 6 : 3
        if (unison[slot]?.tags.damage && profile.key === "skill") score += slot === 0 ? 3 : 1
    }
    const healer = main.some(unit => unit.tags.heal) || unison.some((unit, i) =>
        unit?.tags.heal && (unit.element === main[i].element || !unit.tags.elementHeal))
    if (healer) score += profile.sustain
    if (flags.guard) score += profile.sustain * 0.4
    if (flags.cleanse) score += 2
    if (flags.dispel) score += 2
    if (flags.multiball && (profile.key === "flip" || flags.combo)) score += 4
    if (flags.fever && flags.feverPayoff) score += 4
    if (profile.key === "direct") score += 4 * (Number(Boolean(flags.piercing)) + Number(Boolean(flags.floating)))
    return score
}

function byScore(left, right) {
    return right.score - left.score
}

function trim(picks, limit, key) {
    const seen = new Set()
    return picks.sort(byScore).filter(pick => {
        const id = key(pick)
        if (seen.has(id)) return false
        seen.add(id)
        return true
    }).slice(0, limit)
}

function partyKey(party) {
    return [party.main, party.unison, party.equipment]
        .map(items => items.map(item => item?.id ?? 0).join(",")).join("/")
}

function availableCharacter(candidate, party) {
    return !party.main.concat(party.unison).some(unit => unit && unit.identity === candidate.identity)
}

function selectCharacters(characters, profile, targetElement, allowUnison) {
    const evaluate = party => ({ ...party, score: partyScore(party, profile, targetElement) })
    const ranked = characters.map(unit => evaluate({ main: [unit], unison: [], equipment: [] })).sort(byScore)
    const preferred = ranked.slice(0, 14).map(party => party.main[0])
    for (const predicate of [
        unit => unit.tags.heal,
        unit => unit.tags.guard,
        unit => unit.tags.fever || unit.tags.multiball || unit.tags.combo,
        unit => unit.active.some(effect => effect.kind === "gauge"),
        unit => unit.element === targetElement,
    ]) {
        for (const unit of ranked.map(party => party.main[0]).filter(predicate).slice(0, 4)) {
            if (!preferred.includes(unit)) preferred.push(unit)
        }
    }
    // Keep strong cross-element utility candidates when many lead candidates belong to one element.
    preferred.push(...characters.filter(unit => !preferred.includes(unit)).slice(0, 6))
    let beam = ranked.slice(0, 18)
    const mainCount = Math.min(3, new Set(characters.map(unit => unit.identity)).size)
    for (let slot = 1; slot < mainCount; slot++) {
        beam = trim(beam.flatMap(party => preferred.filter(unit => availableCharacter(unit, party)).map(unit =>
            evaluate({ ...party, main: [...party.main, unit] }))), 24, partyKey)
    }
    if (!allowUnison) return beam
    const subPool = [...new Set([...preferred, ...characters.filter(unit => unit.unisonable).slice(0, 12)])]
        .filter(unit => unit.unisonable)
    for (let slot = 0; slot < mainCount; slot++) {
        beam = trim(beam.flatMap(party => {
            const eligible = subPool.filter(unit => availableCharacter(unit, party))
            return [...eligible, null].map(unit => evaluate({ ...party, unison: [...party.unison, unit] }))
        }), 24, partyKey)
    }
    return beam
}

function selectEquipment(team, equipment, profile, targetElement) {
    let beam = [team]
    for (let slot = 0; slot < team.main.length; slot++) {
        beam = trim(beam.flatMap(party => {
            const choices = equipment.filter(item => !party.equipment.includes(item))
            return [...choices, null].map(item => {
                const candidate = { ...party, equipment: [...party.equipment, item] }
                return { ...candidate, score: partyScore(candidate, profile, targetElement) }
            })
        }), 5, partyKey)
    }
    return beam[0]
}

function hasDirection(party, profile) {
    const units = party.main.concat(party.unison.filter(Boolean))
    const mode = profile.key
    if (mode === "balanced") return true
    if (mode === "skill" && !units.some(unit => unit.tags.damage)) return false
    const flags = partyFlags(party)
    return partyEffects(party).some(effect => effect.kind === mode && effect.value >= 0.18
        && party.main.some(unit => compatibleEffect(effect, unit) === 1)
        && uptime(effect, flags) >= 0.25)
}

function recommendTeams(characters, equipment, options = {}) {
    if (!characters.length) return []
    const targetElement = options.targetElement
    const teams = profiles.flatMap(profile => {
        const parties = selectCharacters(characters, profile, targetElement, options.allowUnison)
        const best = parties.slice(0, 5).map(team => selectEquipment(team, equipment, profile, targetElement)).sort(byScore)
            .find(team => hasDirection(team, profile))
        return best ? [{ ...best, label: `${elements[best.main[0].element]} · ${profile.label}`, profile: profile.key }] : []
    })
    const seen = new Set()
    return teams.filter(team => {
        const key = partyKey(team)
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

module.exports = { recommendTeams, partyScore }
