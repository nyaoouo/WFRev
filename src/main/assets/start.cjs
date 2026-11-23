"use strict"

const path = require("node:path")
const fs = require("node:fs")

// Opaque 16x16 black PNG. The client can decode it like a real comic image.
const blackComic = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAQSURBVDhPY2AYBaNgFMAAAAMQAAHAMaPmAAAAAElFTkSuQmCC",
    "base64",
)

function installComicPlaceholder(root) {
    const comic = require(path.join(root, "out/routes/api/comic.js"))
    const register = comic.default
    comic.default = async (fastify, options) => {
        const imageRoute = fastify.prefix + "/image"
        const selection = options.comicDir && path.join(options.comicDir, "selected")
        fastify.addHook("onRequest", async (request, reply) => {
            if (request.routeOptions.url === imageRoute
                && (!selection || !fs.existsSync(selection))) {
                return reply.type("image/png").header("cache-control", "no-store").send(blackComic)
            }
        })
        return register(fastify, options)
    }
}

async function main() {
    const root = path.join(__dirname, "server-bundle")
    process.chdir(root)
    console.info("后端：校验 CDN 并同步游戏数据")
    const { runContentSyncEntry } = require(path.join(root, "out/content/sync/entry.js"))
    if (await runContentSyncEntry([])) {
        throw new Error("Content preparation failed")
    }
    console.info("后端：启动 HTTP 服务")
    installComicPlaceholder(root)
    require("./local-hub-endpoint.cjs").install(root)
    require("./local-payment.cjs").install(root)
    require("./local-encyclopedia.cjs").install(root)
    require("./local-team-recommendations.cjs").install(root)
    const { buildCompanions } = require("./local-coop-companions.cjs").install(root)
    require("./local-coop-requests.cjs").install(root, { buildCompanions })
    require(path.join(root, "out/cn-server.js"))
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
