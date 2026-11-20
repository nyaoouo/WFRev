"use strict"

// Android master table 1.4.46. Selected historical offers are kept available
// offline. Reward tuples are mailbox type, amount, and optional item ID.
const products = new Map()
function add(id, name, price, paid, options = {}) {
    products.set(`com.leiting.wf.${id}`, { name, price, paid, ...options })
}

for (const [tier, price, paid] of [
    [50, 6, 50], [150, 18, 160], [350, 40, 320], [850, 98, 850],
    [1500, 163, 1500], [2450, 258, 2450], [5100, 518, 5100],
]) {
    add(`stone_${tier}`, `星导石 × ${paid}`, price, paid)
}
add("stonepack_Daily", "每日星导石礼包", 50, 500, { benefit: "month" })
add("stonepack_150", "新手应援礼包", 6, 150, { limit: 1 })
add("stonepack_850", "★4必得扭蛋券套装", 98, 850, { limit: 1, mail: [[1, 1, 20003]] })
add("stonepack_5100", "★5必得扭蛋券套装", 518, 5100, { limit: 1, mail: [[1, 1, 20004]] })
add("stonepack_GachaTicket", "豪华扭蛋券礼包", 98, 0, {
    limit: 3, mail: [[1, 1, 999001], [1, 3, 102], [7, 20]],
})
add("stonepack_500", "活动限定 每日特惠礼包", 25, 500, {
    limit: 1, period: "day", excludes: "com.leiting.wf.stonepack_500_pack",
})
add("stonepack_500_pack", "活动限定 每日特惠礼包（打包）", 198, 4000, {
    limit: 1, excludes: "com.leiting.wf.stonepack_500",
})
add("stonepack_7500", "每月特惠礼包", 518, 7500, { limit: 3, period: "month" })
add("ticket_pack_mei", "扭蛋券支援礼包A", 163, 1500, { limit: 1, mail: [[1, 1, 999001]] })
add("ticket_pack_zhu", "扭蛋券支援礼包B", 258, 2450, {
    limit: 1, mail: [[1, 1, 999001], [1, 6, 999003]],
})
add("ticket_pack_song", "扭蛋券支援礼包C", 518, 5100, {
    limit: 1, mail: [[1, 3, 999001], [1, 4, 999003], [1, 1, 10003]],
})
add("pass_card", "高阶修行礼包", 68, 0, { limit: 1, period: "pass" })

module.exports = products
