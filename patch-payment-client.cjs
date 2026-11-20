"use strict"

const { execFileSync } = require("node:child_process")
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs")
const path = require("node:path")

const [java, ffdec, source, destination, work] = process.argv.slice(2)
const run = (...args) => execFileSync(java, ["-Djava.awt.headless=true", "-Xmx3g", "-jar", ffdec, ...args], {
    stdio: "inherit",
})

mkdirSync(work, { recursive: true })
function patchClass(input, output, className, edit) {
    const classFile = path.join(work, "scripts", ...className.split(".")) + ".as"
    run("-selectclass", className, "-export", "script", work, input)
    let script = readFileSync(classFile, "utf8")
    function replace(original, replacement) {
        if (!original || script.split(original).length !== 2) throw new Error(`Unexpected ${className}: ${original}`)
        script = script.replace(original, replacement)
    }
    edit(script, replace)
    writeFileSync(classFile, script)
    run("-replace", input, output, className, classFile)
}

const localLogin = path.join(work, "local-login.swf")
patchClass(source, localLogin, "pinball.config.core.DevConfig", (_script, replace) => {
    replace("public static var sdkDummy:Boolean = false;", "public static var sdkDummy:Boolean = true;")
})

const localServer = path.join(work, "local-server.swf")
patchClass(localLogin, localServer, "pinball.config.gbits.DevConfig_gf_android", (_script, replace) => {
    replace('ApiServerKind.Custom("https","shijtswygamegf.leiting.com")', 'ApiServerKind.Custom("http","127.0.0.1:8001")')
})

const handoff = path.join(work, "payment-handoff.swf")
patchClass(localServer, handoff, "pinball.payment.gbits.GbitsAndroidRealPayment", (script, replace) => {
    replace("import flash.Boot;", "import flash.Boot;\n   import flash.Lib;\n   import flash.net.URLRequest;")
    replace("MAX_QUEST_TIMES = 10;", "MAX_QUEST_TIMES = 900;")
    replace("DELAY_FRAME = 396;", "DELAY_FRAME = 120;")
    const purchaseStart = script.indexOf("public function purchase(")
    const purchaseEnd = script.indexOf("public function onSDKInstanceReset(", purchaseStart)
    if (purchaseStart < 0 || purchaseEnd < 0) throw new Error("Payment handoff was not found")
    replace(script.slice(purchaseStart, purchaseEnd), `public function purchase(param1:PaymentProductLogic, param2:Object) : void
      {
         if (!param2 || !param2.orderId || String(param2.checkoutUrl).indexOf("http://127.0.0.1:8001/") != 0) {
            payment.failPurchase(PlatformPurchaseFailureReason.Msg("商品暂不可购买，请刷新商城。"));
            return;
         }
         curPurchargeInfo = new GbitsPayParamInfo();
         curPurchargeInfo.orderId = param2.orderId;
         curPurchargeInfo.productId = param1.get_id();
         curPurchargeInfo.money = Std.string(param1.get_price());
         cur_quest_times = 0;
         try {
            Lib.getURL(new URLRequest("starpoint-checkout://order/" + String(param2.orderId)));
            Delay.delay(waitQuestPurchargeResult,1);
         } catch (error:Error) {
            curPurchargeInfo = null;
            payment.failPurchase(PlatformPurchaseFailureReason.Msg("无法打开本地付款页。" + error.message));
         }
      }

      `)
    replace("if(int(param1.status) != 3)", "".concat(
    "if (int(param1.status) == 4) {\n",
    "            curPurchargeInfo = null;\n",
    "            payment.failPurchase(PlatformPurchaseFailureReason.UserCancel(\"本地订单已取消或过期。\"));\n",
    "            return;\n",
    "         }\n",
    "         if(int(param1.status) != 3)",
    ))
})

patchClass(handoff, destination, "pinball.remote.payment.finish.PaymentFinishRealRemote", (script, replace) => {
    const deviceStart = script.indexOf('var _loc6_:String = "none";')
    const requestStart = script.indexOf('startUserRequestDetail("payment/finish"', deviceStart)
    if (deviceStart < 0 || requestStart < 0) throw new Error("Payment SDK device lookup was not found")
    // The offline SDK returns no device JSON. The authenticated order is sufficient.
    replace(script.slice(deviceStart, requestStart), "var _loc16_:Object = {};\n         ")
    replace('"signature":param2.signature,', '"product_id":param2.itemId,\n               "signature":param2.signature,')
})
