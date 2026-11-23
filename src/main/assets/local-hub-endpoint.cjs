"use strict"

const path = require("node:path")

function install(root) {
    if (process.env.MULTI_MODE !== "host" || process.env.LOCAL_HUB_LOOPBACK_HOST !== "1") return
    const runtime = require(path.join(root, "out/multi/runtime/service.js"))
    const create = runtime.createMultiRuntimeService
    runtime.createMultiRuntimeService = (...args) => {
        const service = create(...args)
        const getContext = service.getHttpContext.bind(service)
        const contexts = new WeakMap()
        service.getHttpContext = () => {
            const context = getContext()
            if (!contexts.has(context)) {
                contexts.set(context, Object.freeze({
                    ...context,
                    // Only this phone's game API uses loopback. Hub registration still advertises the VPN address.
                    tcpEndpoint: () => {
                        const endpoint = context.tcpEndpoint?.()
                        return endpoint ? { host: "127.0.0.1", port: endpoint.port } : null
                    },
                }))
            }
            return contexts.get(context)
        }
        return service
    }
}

module.exports = { install }
