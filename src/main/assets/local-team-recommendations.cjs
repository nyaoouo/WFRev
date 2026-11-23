"use strict"

const path = require("node:path")
const { createTeamContent, buildOwnedPartyData } = require("./team-content.cjs")
const { recommendTeams } = require("./team-planner.cjs")

function projectTeam(team, index) {
    const result = { party_name: team.label, power: index + 1 }
    for (let slot = 0; slot < 3; slot++) {
        const suffix = slot + 1
        result[`character_id_${suffix}`] = team.main[slot]?.id ?? null
        result[`evolution_img_level_${suffix}`] = team.main[slot]?.evolution ?? null
        result[`unison_character_id_${suffix}`] = team.unison[slot]?.id ?? null
        result[`unison_evolution_img_level_${suffix}`] = team.unison[slot]?.evolution ?? null
        result[`equipment_id_${suffix}`] = team.equipment[slot]?.id ?? null
        result[`ability_soul_id_${suffix}`] = null
    }
    return result
}

function install(root) {
    const load = file => require(path.join(root, "out", file))
    const { getContentSnapshot } = load("content/runtime/content-snapshot.js")
    const { getSessionSync } = load("data/domains/session.js")
    const { resolvePlayerIdSync } = load("data/activeAccount.js")
    const { SessionType } = load("data/types.js")
    const { getPlayerCharactersSync, getPlayerCharactersManaNodeAwakeLevelsByIdsSync } = load("data/domains/character.js")
    const { getPlayerEquipmentListSync } = load("data/domains/equipment.js")
    const { getPlayerSingleQuestProgressSync } = load("data/domains/quest.js")
    const { getPlayerSync } = load("data/domains/player.js")
    const { getDb } = load("data/db.js")
    const { getQuestFromCategorySync } = load("lib/quest-content.js")
    const { QuestCategory } = load("lib/types/quest.js")
    const { characterLevelFromContent } = load("lib/character-growth/node-command-support.js")
    const { generateDataHeaders } = load("utils.js")
    const getTeamContent = createTeamContent(root)
    const questModule = load("routes/api/questUnlock.js")
    const registerQuest = questModule.default

    async function getRecommendations(request, reply) {
        const { viewer_id: viewerId, category, quest_id: questId } = request.body ?? {}
        if (!Number.isSafeInteger(viewerId) || viewerId <= 0
            || !Number.isSafeInteger(category) || !Number.isSafeInteger(questId) || questId <= 0) {
            return reply.code(400).send({ message: "Invalid quest recommendation request." })
        }
        const session = getSessionSync(String(viewerId))
        const playerId = session?.type === SessionType.VIEWER ? resolvePlayerIdSync(session.accountId) : null
        if (playerId === null) return reply.code(400).send({ message: "Invalid viewer id." })

        const quest = getQuestFromCategorySync(category, questId)
        let teams = []
        if (quest?.enemyLevel > 0 && quest.fixedParty == null) {
            const snapshot = getContentSnapshot()
            const content = await getTeamContent(snapshot)
            const options = {
                targetElement: Number.isInteger(quest.element) && quest.element >= 0 && quest.element <= 5
                    ? quest.element : undefined,
                allowUnison: false,
            }
            const roster = getDb().transaction(() => {
                const player = getPlayerSync(playerId)
                if (!player) return null
                const gate = content.gates.get("condition_unison")?.[0]
                if (player.tutorialStep == null && gate?.[0] === "0") {
                    options.allowUnison = getPlayerSingleQuestProgressSync(playerId, QuestCategory.MAIN, Number(gate[4]))
                        ?.finished === true
                }
                const owned = getPlayerCharactersSync(playerId)
                const mana = getPlayerCharactersManaNodeAwakeLevelsByIdsSync(playerId, Object.keys(owned).map(Number))
                return { owned, mana, inventory: getPlayerEquipmentListSync(playerId) }
            })()
            if (roster) {
                const { characters, equipment } = buildOwnedPartyData(content, snapshot.repository,
                    roster.owned, roster.mana, roster.inventory, characterLevelFromContent)
                teams = recommendTeams(characters, equipment, options).map(projectTeam)
            }
        }
        return reply.type("application/x-msgpack").send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: { recent_other_player_party: teams },
        })
    }

    questModule.default = async (fastify, options) => {
        fastify.addHook("onRoute", route => {
            if (route.method === "POST" && route.url === `${fastify.prefix}/get_recent_other_player_party`) {
                route.handler = getRecommendations
            }
        })
        return registerQuest(fastify, options)
    }
}

module.exports = { install, projectTeam }
