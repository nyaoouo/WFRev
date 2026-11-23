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
            payment.failPurchase(PlatformPurchaseFailureReason.Msg("无法打开付款页。" + error.message));
         }
      }

      `)
    replace("if(int(param1.status) != 3)", "".concat(
    "if (int(param1.status) == 4) {\n",
    "            curPurchargeInfo = null;\n",
    "            payment.failPurchase(PlatformPurchaseFailureReason.UserCancel(\"订单已取消或过期。\"));\n",
    "            return;\n",
    "         }\n",
    "         if(int(param1.status) != 3)",
    ))
})

const receipt = path.join(work, "payment-receipt.swf")
patchClass(handoff, receipt, "pinball.remote.payment.finish.PaymentFinishRealRemote", (script, replace) => {
    const deviceStart = script.indexOf('var _loc6_:String = "none";')
    const requestStart = script.indexOf('startUserRequestDetail("payment/finish"', deviceStart)
    if (deviceStart < 0 || requestStart < 0) throw new Error("Payment SDK device lookup was not found")
    // The offline SDK returns no device JSON. The authenticated order is sufficient.
    replace(script.slice(deviceStart, requestStart), "var _loc16_:Object = {};\n         ")
    replace('"signature":param2.signature,', '"product_id":param2.itemId,\n               "signature":param2.signature,')
})

const menu = path.join(work, "history-menu.swf")
patchClass(receipt, menu, "pinball.scene.menuTop.MenuTopScene", (_script, replace) => {
    replace("import flash.net.URLRequest;", `import flash.net.URLRequest;
   import flash.net.URLRequestMethod;
   import flash.net.URLLoader;
   import flash.events.Event;
   import flash.events.IOErrorEvent;
   import flash.events.SecurityErrorEvent;`)
    replace("switch(param1.kind.index)", `if(param1.kind.index == 16 || param1.kind.index == 17)
         {
            openLocalHistory(param1.kind.index == 16 ? "payments" : "gacha");
            return;
         }
         switch(param1.kind.index)`)
    replace("public function createMenuListData()", `public function openLocalHistory(section:String) : void
      {
         var owner:MenuTopScene = this;
         var request:URLRequest = new URLRequest("http://127.0.0.1:8001/api/index.php/payment/local/history/session");
         request.method = URLRequestMethod.POST;
         request.contentType = "application/json";
         request.data = JSON.stringify({viewer_id:globalLogic.get_player().get_viewerId()});
         var loader:URLLoader = new URLLoader();
         var failed:Function = function(event:Event):void {
            owner.showInstantMessage("暂时无法打开记录",InstantMessagePosition.Center);
         };
         loader.addEventListener(IOErrorEvent.IO_ERROR,failed);
         loader.addEventListener(SecurityErrorEvent.SECURITY_ERROR,failed);
         loader.addEventListener(Event.COMPLETE,function(event:Event):void {
            var token:String = String(loader.data);
            if(gear.isDisposed()) return;
            if(!/^[a-f0-9]{48}$/.test(token)) {
               failed(event);
               return;
            }
            Lib.getURL(new URLRequest("starpoint-history://open/" + section + "/" + token));
         });
         try { loader.load(request); } catch(error:Error) { failed(null); }
      }

      public function createMenuListData()`)
    // Place both records beside the existing receipt/history entry.
    replace('"kind":MenuTopListItemKind.Item,', `"kind":{"index":16},
            "content":MenuListContentKind.IconAndText("scene/general/sprite_sheet/vector_icon-assets/stone_large","local_payment_history")
         },{
            "kind":{"index":17},
            "content":MenuListContentKind.IconAndText("scene/general/sprite_sheet/vector_icon-assets/history","local_gacha_history")
         },{
            "kind":MenuTopListItemKind.Item,`)
})

const menuLabels = path.join(work, "history-menu-labels.swf")
patchClass(menu, menuLabels, "pinball.ui.component.list.menu.cell.MenuListCellContentView", (_script, replace) => {
    replace(".set_text(view.asset.getUiString(param1));", `.set_text(param1 == "local_payment_history" ? "充值记录" :
            param1 == "local_gacha_history" ? "扭蛋记录" : view.asset.getUiString(param1));`)
})

patchClass(menuLabels, destination, "pinball.ui.component.list.recentOtherPlayerParty.RecentOtherPlayerPartyListCellContentView", (_script, replace) => {
    replace('view.asset.getUiString("recent_other_player_party_party_power_label")', '"推荐顺序"')
})
