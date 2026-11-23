"use strict"

const path = require("node:path")
const { randomInt, randomUUID } = require("node:crypto")
const { Writable } = require("node:stream")
const { createTeamContent } = require("./team-content.cjs")

const OFFER_INTERVAL_MS = 90_000
const OFFER_LIFETIME_MS = 30_000
const LOBBY_LIFETIME_MS = 120_000
const BATTLE_LIFETIME_MS = 900_000
const FINISHED_LIFETIME_MS = 5_000
const START_DELAY_MS = 2_000
const ROOM_LIMIT = 8
const HOST_NAMES = ["离线伙伴·星灯", "离线伙伴·铃兰", "离线伙伴·小满"]
const installedRoots = new Set()

const option = value => value == null ? [1] : [0, value]

function lobbyParty(party) {
    const character = value => value == null ? null : {
        id: value.id,
        evolution_level: value.evolution_level,
        exp: value.exp,
        over_limit_step: value.over_limit_step,
        mana_node_ids: Object.fromEntries((value.mana_node_ids ?? []).map(id => [id, 0])),
        ex_boost: option(value.ex_boost),
        illustration_settings: [1],
    }
    return {
        characters: party.characters.map(value => option(character(value))),
        unison_characters: party.unison_characters.map(value => option(character(value))),
        equipments: party.equipments.map(value => option(value == null ? null : {
            equipmentId: value.equipment_id,
            level: value.level,
            enhancementLevel: value.enhancement_level,
        })),
        abilitySoulIds: party.ability_soul_ids.map(option),
    }
}

function virtualSocket() {
    return new Writable({ write(_frame, _encoding, callback) { callback() } })
}

function install(root, { buildCompanions } = {}) {
    root = path.resolve(root)
    if (installedRoots.has(root) || (process.env.MULTI_MODE ?? "embedded") !== "embedded"
        || process.env.MULTI_SOCIAL_DB_PATH || process.env.MULTI_SOCIAL_PG_URL) return

    const load = relative => require(path.join(root, "out", relative))
    const attention = load("routes/api/attention.js")
    const multi = load("multi/http/register.js")
    const lobby = load("multi/tcp/lobby.js")
    const battle = load("multi/tcp/battle.js")
    const rooms = load("multi/room/manager.js")
    const { sessionManager } = load("multi/state/SessionManager.js")
    const { identityOf, lifecycleRegistry } = load("multi/lifecycle/index.js")
    const { npcIdentityOf } = load("multi/npc/identity.js")
    const { buildNpcMates } = load("multi/npc/builder.js")
    const { buildYourselfFromSnapshot } = load("multi/snapshot/player-snapshot.js")
    const { getSessionSync } = load("data/domains/session.js")
    const { getPlayerQuestProgressSync } = load("data/domains/quest.js")
    const { getContentSnapshot } = load("content/runtime/content-snapshot.js")
    const getTeamContent = createTeamContent(root)
    const { isQuestJoinAllowed } = load("lib/quest-join-gate.js")
    const { getQuestEntryContentCatalog } = load("lib/quest-entry-content.js")
    const { QuestCategory } = load("lib/types/quest.js")
    const { isLoopbackOnlyListenHost } = load("runtime/network-host.js")
    const { getRealNowMs } = load("runtime/time/game-time.js")
    const { realSecondsToVirtual } = load("utils.js")
    const { setCnMsgpackPendingEncoder } = load("routes/cn/msgpack.js")
    const requests = new Map()
    const nextOfferAt = new Map()
    const creatingViewers = new Set()
    let context

    function closeRequest(entry) {
        const { roomNumber, coordinator, participant, host } = entry
        if (requests.get(roomNumber) !== entry) return
        requests.delete(roomNumber)
        clearTimeout(entry.expiryTimer)
        clearTimeout(entry.startTimer)
        if (rooms.getRoom(roomNumber)?.host_viewer_id === participant.viewerId) {
            lobby.clearAutoStartingRoom(roomNumber)
            void coordinator.disbandRoom({ participant, roomNumber }).catch(error => {
                console.warn("[LOCAL COOP] Room cleanup failed", error)
            })
        }
        host.socket.destroy()
    }

    function expireAfter(entry, lifetime) {
        clearTimeout(entry.expiryTimer)
        entry.expiresAt = getRealNowMs() + lifetime
        entry.expiryTimer = setTimeout(() => closeRequest(entry), lifetime).unref()
    }

    async function chooseQuest(playerId) {
        const category = QuestCategory.BOSS_BATTLE
        const snapshot = getContentSnapshot()
        const { repository } = snapshot
        const { gates, bossNodes } = await getTeamContent(snapshot)
        const { entries, unlocks, prerequisites } = getQuestEntryContentCatalog(repository)
        const progress = new Map(Object.entries(getPlayerQuestProgressSync(playerId)).flatMap(([section, quests]) => (
            quests.map(quest => [`${section}_${quest.questId}`, quest])
        )))
        const readProgress = (section, questId) => progress.get(`${section}_${questId}`)
        for (const name of ["condition_attention", "condition_boss_battle"]) {
            const gate = gates.get(name)?.[0]
            if (gate?.[0] !== "0" || !readProgress(QuestCategory.MAIN, Number(gate[4]))?.finished) return null
        }
        const quests = repository.table("boss_battle_quest.json")
        const difficulty = quest => quest.enemyLevel > 0 ? quest.enemyLevel : Math.max(0, quest.rankPointReward ?? 0)
        const candidates = Object.keys(quests).map(Number).filter(questId => {
            const key = `${category}_${questId}`
            const entry = entries[key]
            if (!entry || entry.itemId > 0) return false
            const saved = readProgress(category, questId)
            const group = bossNodes.get(Math.floor(questId / 1000))
            if (group !== 1 && (group !== 2 || !saved?.finished)) return false
            // First stages have the normal visibility gates. Later stages also have
            // client selection rules, so require a prior clear before offering them.
            if (questId % 1000 !== 1 && !saved?.finished) return false
            if (unlocks[questId]?.itemIds.length && !saved?.unlocked && !saved?.finished) return false
            return context.questAvailability.check(category, questId).available
                && isQuestJoinAllowed(category, questId, readProgress, repository)
                && (prerequisites[key] ?? []).every(ref => readProgress(ref.category, ref.questId)?.finished)
        })
        if (!candidates.length) return null
        candidates.sort((left, right) => difficulty(quests[left]) - difficulty(quests[right]) || left - right)
        const cleared = candidates.filter(questId => readProgress(category, questId)?.finished)
        if (!cleared.length) return candidates[0]
        const reachable = Math.max(...cleared.map(questId => difficulty(quests[questId]))) + 10
        const pool = candidates.filter(questId => difficulty(quests[questId]) <= reachable)
        return pool[randomInt(pool.length)]
    }

    function dispatch(entry, event) {
        const decision = lifecycleRegistry.dispatch(entry.roomNumber, generation => ({ ...event, generation }))
        if (!decision || decision.rejected) throw new Error(`Virtual room ${event.type} was rejected`)
    }

    async function createRequest(viewerId, playerId, compatibility, questId) {
        const category = QuestCategory.BOSS_BATTLE
        const roomSeed = randomUUID()
        const fallback = buildNpcMates(questId, category)
        const companions = buildCompanions?.({ playerId, questId, category, roomSeed }) ?? fallback
        const hostMate = companions.mate1 ?? fallback.mate1
        const secondMate = companions.mate2
        const leader = hostMate?.party.characters[0]
        if (!leader) return null

        // The native viewer ID generator uses nine digits. Keep virtual viewers
        // outside that range and out of the session and player tables.
        let hostViewerId
        do {
            hostViewerId = randomInt(500_000_000, 1_000_000_000) * 2
        } while (getSessionSync(String(hostViewerId)) || getSessionSync(String(hostViewerId + 1)) || rooms.listActiveRooms()
            .some(room => room.host_viewer_id === hostViewerId))

        const { coordinator, snapshotProvider } = context
        const participant = snapshotProvider.getParticipant(hostViewerId)
        const created = await coordinator.createRoom({
            requestId: `local-coop:${roomSeed}`,
            participant,
            partyId: 1,
            category,
            questId,
            leaderCharacterId: leader.id,
            compatibility,
        })
        if (!created.ok) return null

        const { roomNumber, accessToken } = created.value
        const host = sessionManager.createClient(virtualSocket(), hostViewerId, roomNumber, `${roomNumber}-virtual-host`)
        host.participant = participant
        host.isHost = true
        host.lifecycleGeneration = lifecycleRegistry.get(roomNumber)?.generation
        host.yourself = buildYourselfFromSnapshot({
            viewerId: hostViewerId,
            name: HOST_NAMES[randomInt(HOST_NAMES.length)],
            rank: hostMate.rank,
            degreeId: hostMate.degree_id,
            mainCharacterId: leader.id,
            playerRoleKind: 99,
            isNewbie: false,
            currentPartyId: 1,
            party: lobbyParty(hostMate.party),
        }, host.connectionId, true)

        const entry = { roomNumber, accessToken, viewerId, playerId, coordinator, participant, host, secondMate, delivered: false }
        requests.set(roomNumber, entry)
        try {
            if (!sessionManager.claimRoomHostParticipant(roomNumber, participant) || !sessionManager.addClientToRoom(host).ok) {
                throw new Error("Virtual host could not claim the lobby seat")
            }
            lobby.handleMessage(host.socket, [0, [0, { party: host.yourself.party }]])
            const room = rooms.getRoom(roomNumber)
            if (room?.raising_state !== 1) throw new Error("Virtual host did not enter the lobby")

            if (secondMate) {
                const identity = npcIdentityOf(roomNumber, 2)
                room.npc_roster.push({ com_id: 2, name: "离线伙伴·风铃", viewer_id: hostViewerId + 1, ready: true })
                room.npc_count = 1
                host.npcPartySnapshots = [undefined, lobbyParty(secondMate.party)]
                dispatch(entry, { type: "admit", identity })
                dispatch(entry, { type: "handshake", identity })
                dispatch(entry, { type: "enter", identity, nowMs: getRealNowMs() })
                dispatch(entry, { type: "ready", identity, ready: true })
                lobby.commitRoomMates(host, room, lobby.projectRoomMatesFromKernel(roomNumber, host))
            }

            entry.bell = {
                attention_key: `attention_${roomSeed}`,
                quest_info: {
                    category_id: category,
                    establisher_character: leader.id,
                    establisher_character_evolution_img_level: leader.evolution_level,
                    establisher_follow: 0,
                    establisher_rank: hostMate.rank,
                    host_entry_time: realSecondsToVirtual(room.host_entry_time),
                    is_newbie: false,
                    quest_id: questId,
                    room_number: roomNumber,
                },
            }
            expireAfter(entry, OFFER_LIFETIME_MS)
            return entry
        } catch (error) {
            closeRequest(entry)
            throw error
        }
    }

    const registerAttention = attention.default
    attention.default = async (fastify, options) => {
        fastify.addHook("preHandler", async (request, reply) => {
            if (request.routeOptions.url !== `${fastify.prefix}/check`) return
            const tcpHost = context?.tcpEndpoint?.()?.host
            if (!tcpHost || !isLoopbackOnlyListenHost(tcpHost)) return
            const now = getRealNowMs()
            for (const entry of requests.values()) {
                if (entry.expiresAt <= now || rooms.getRoom(entry.roomNumber)?.host_viewer_id !== entry.participant.viewerId) {
                    closeRequest(entry)
                }
            }
            for (const [playerId, nextAt] of nextOfferAt) {
                if (nextAt <= now) nextOfferAt.delete(playerId)
            }
            const viewerId = request.body?.viewer_id
            if (!Number.isSafeInteger(viewerId) || viewerId <= 0) return
            try {
                const player = await context.resolvePlayerContext(viewerId)
                if (!player || player.player.tutorialStep != null
                    || rooms.listActiveRooms().some(room => room.member_participants.some(member => member.viewerId === viewerId))) return
                let entry = [...requests.values()].find(item => item.viewerId === viewerId || item.playerId === player.playerId)
                if (!entry) {
                    if (nextOfferAt.has(player.playerId) || creatingViewers.has(viewerId)
                        || requests.size + creatingViewers.size >= ROOM_LIMIT) return
                    const compatibility = context.snapshotProvider.getCompatibility(request.headers)
                    if (!compatibility.ok) return
                    nextOfferAt.set(player.playerId, now + OFFER_INTERVAL_MS)
                    creatingViewers.add(viewerId)
                    try {
                        const questId = await chooseQuest(player.playerId)
                        if (questId === null) return
                        entry = await createRequest(viewerId, player.playerId, compatibility.value, questId)
                    } finally {
                        creatingViewers.delete(viewerId)
                    }
                }
                if (!entry || entry.delivered || entry.viewerId !== viewerId || entry.playerId !== player.playerId) return

                // CN MsgPack replies skip Fastify's preSerialization hooks.
                setCnMsgpackPendingEncoder(reply, (payload, encode) => {
                    const bells = payload?.data?.multi
                    const limit = payload?.data?.config?.return_attention_max_num
                    if (entry.delivered || entry.expiresAt <= getRealNowMs() || requests.get(entry.roomNumber) !== entry
                        || !Array.isArray(bells) || !Number.isSafeInteger(limit) || bells.length >= limit) return encode(payload)
                    const encoded = encode({ ...payload, data: { ...payload.data, multi: [...bells, entry.bell] } })
                    entry.delivered = true
                    return encoded
                })
            } catch (error) {
                request.log.warn({ err: error }, "Offline help request could not be created")
            }
        })
        return registerAttention(fastify, options)
    }

    const registerMulti = multi.multiBattleRoutes
    multi.multiBattleRoutes = async (fastify, options) => {
        context = options.context
        fastify.addHook("preHandler", async (request, reply) => {
            const { room_number: roomNumber, access_token: accessToken, viewer_id: viewerId } = request.body ?? {}
            const entry = requests.get(roomNumber) ?? (accessToken && [...requests.values()]
                .find(candidate => candidate.accessToken === accessToken))
            if (!entry) return
            const player = viewerId === entry.viewerId ? await context.resolvePlayerContext(viewerId) : null
            if (!entry.delivered || player?.playerId !== entry.playerId) {
                return reply.code(404).send({ error: "Not Found", message: "Room is unavailable." })
            }
            if (entry.expiresAt <= getRealNowMs() || (entry.battleEnded
                && request.routeOptions.url === `${fastify.prefix}/restore_room`)) closeRequest(entry)
        })
        fastify.addHook("onResponse", async (request, reply) => {
            const route = request.routeOptions.url
            if (reply.statusCode !== 200 || (route !== `${fastify.prefix}/finish` && route !== `${fastify.prefix}/abort`)) return
            const entry = [...requests.values()].find(item => item.viewerId === request.body?.viewer_id)
            if (!entry?.battleStarted || entry.battleEnded) return
            const battleEnded = sessionManager.getActiveBattleSessionId(entry.roomNumber) === null
                || !sessionManager.getBattleParticipantsForRoom(entry.roomNumber).some(participant => participant.viewerId === entry.viewerId)
            if (battleEnded) {
                entry.battleEnded = true
                expireAfter(entry, FINISHED_LIFETIME_MS)
            }
        })
        return registerMulti(fastify, options)
    }

    // The host anchors native room/battle facts. On the client it plays
    // as a COM, so it needs neither a game client nor game inputs.
    function projectCompanions(entry, mates) {
        return mates.map(mate => {
            if (mate === entry.host.yourself) return { ...mate, comId: 1 }
            if (entry.secondMate && mate.comId === 2) {
                return { ...mate, rank: entry.secondMate.rank, degreeId: entry.secondMate.degree_id }
            }
            return mate
        })
    }
    const projectMates = sessionManager.projectMateListForClient.bind(sessionManager)
    sessionManager.projectMateListForClient = (client, mates) => {
        const projected = projectMates(client, mates)
        const entry = requests.get(client.roomNumber)
        return entry ? projectCompanions(entry, projected) : projected
    }
    const broadcast = sessionManager.broadcastToRoom.bind(sessionManager)
    sessionManager.broadcastToRoom = (roomNumber, packet, excludeClient) => {
        const entry = requests.get(roomNumber)
        const message = packet?.[0] === 1 ? packet[1] : null
        if (entry && message?.[0] === 5 && Array.isArray(message[1])) {
            packet = [1, [5, projectCompanions(entry, message[1])]]
        }
        return broadcast(roomNumber, packet, excludeClient)
    }

    const handleLobby = lobby.handleMessage
    lobby.handleMessage = (socket, packet) => {
        const client = sessionManager.getLobbyClientBySocket(socket)
        const entry = client && requests.get(client.roomNumber)
        handleLobby(socket, packet)
        if (!entry || client.viewerId !== entry.viewerId || packet?.[0] !== 0) return
        const tag = packet[1]?.[0]
        if (tag === 0 && client.enterData) {
            if (!entry.joined) {
                entry.joined = true
                expireAfter(entry, LOBBY_LIFETIME_MS)
            }
            lobby.broadcastReadyFramesForSeatedNpcs(entry.roomNumber, entry.host.mates)
        }
        if (tag !== 3 || !entry.joined || entry.battleStarted) return
        clearTimeout(entry.startTimer)
        if (!client.isReady || !entry.host.mates.includes(client.yourself)) return
        entry.startTimer = setTimeout(() => {
            if (requests.get(entry.roomNumber) !== entry || !client.isReady
                || sessionManager.getLobbyClientBySocket(socket) !== client) return
            handleLobby(entry.host.socket, [0, [6]])
            if (sessionManager.getActiveBattleSessionId(entry.roomNumber) !== null) {
                entry.battleStarted = true
                expireAfter(entry, BATTLE_LIFETIME_MS)
            }
        }, START_DELAY_MS).unref()
    }

    const handleBattle = battle.handleBattleMessage
    battle.handleBattleMessage = (socket, packet) => {
        const client = sessionManager.getBattleClientBySocket(socket)
        const entry = client && requests.get(client.roomNumber)
        if (!entry?.battleStarted || entry.viewerId !== client.viewerId) return handleBattle(socket, packet)

        if (!entry.battleHost || entry.battleHost.socket.destroyed) {
            const hostSocket = virtualSocket()
            const host = sessionManager.createClient(hostSocket, entry.participant.viewerId, entry.roomNumber, entry.host.connectionId)
            host.participant = entry.participant
            host.isBattle = true
            if (!sessionManager.addBattleClient(host.connectionId, host)) return handleBattle(socket, packet)
            hostSocket.once("close", () => sessionManager.removeClient(host))
            entry.battleHost = host
        }
        const host = entry.battleHost
        if (entry.battleGuest !== client) {
            entry.battleGuest = client
            socket.once("close", () => {
                if (entry.battleGuest === client) host.socket.destroy()
            })
        }
        sessionManager.noteBattleActivity(host.connectionId)
        const tag = packet?.[0] === 0 ? packet[1]?.[0] : null
        if (tag === 0) handleBattle(host.socket, [0, [0]])
        if (tag === 2 && !entry.hostFinished) {
            handleBattle(host.socket, [0, [2]])
            if (sessionManager.hasParticipantFinalizedBattle(entry.roomNumber, entry.participant)) {
                entry.hostFinished = true
                void entry.coordinator.finalizeBattle({
                    participant: entry.participant,
                    roomNumber: entry.roomNumber,
                    battleSessionId: sessionManager.getActiveBattleSessionId(entry.roomNumber),
                }).catch(error => console.warn("[LOCAL COOP] Virtual host finalization failed", error))
            }
        }
        handleBattle(socket, packet)
        if (tag === 1) handleBattle(host.socket, [0, [1]])
    }

    installedRoots.add(root)
}

module.exports = { install }
