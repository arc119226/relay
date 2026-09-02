# relay

`wss://relay.arc.idv.tw`。一個**只講 NIP-01 子集**的 WebSocket 廣播器，給自己的 P2P 專案當 WebRTC 訊令用。

它不是一個 Nostr relay。它是一個照 Nostr 說話的轉發器，什麼都不存。

## 為什麼會有這個 repo

事情的順序是這樣：

1. **柴米帳**（[accounting](https://github.com/arc119226/accounting)）是兩個人的記帳本，兩支手機面對面掃 QR 之後用 WebRTC 直接同步，沒有伺服器。
2. WebRTC 需要有人幫兩支手機交換第一封信（SDP）。柴米帳用 [Trystero](https://github.com/dmotz/trystero) 的 Nostr strategy 做這件事：**去借公共的 Nostr relay**，自己零基礎設施，SDP 是加密過的，relay 看不到內容。
3. 2026 年 9 月查 relay 清單的時候發現兩件事：
   - Trystero 從烤在套件裡的 47 個公共 relay **依 appId 洗牌取 5 個**。洗牌是確定性的（兩支手機要在同一批 relay 碰頭），可是清單增刪任何一個，洗出來的 5 個就可能跟舊版毫無交集。加上柴米帳有 Service Worker，一支手機更新、一支沒更新，兩邊就各自在不同的 relay 上等，畫面只顯示「等不到對方」。
   - 那 5 個裡有一台叫 `staging.yabu.me`。家裡的帳本配對，押在陌生人的 staging 機器上。
4. 修那個洗牌地雷不需要自建 relay，明寫 `relayConfig.urls` 就好。**自建的理由是第二件事**：那條依賴的性質不對。
5. 讀了 Trystero 的原始碼之後發現它對 relay 的要求小到有點好笑：三種訊息、一種 filter 形狀、事件全在 ephemeral 區段（規格明說不該存）、而且連 `EOSE` 都不看。這種東西在 Cloudflare 的 Durable Object 上就是幾百行。
6. 而且那幾百行的骨架已經寫過一次了：[super-reversi2](https://github.com/arc119226/super-reversi2) 的 `packages/signal/src/chat.ts` 是一顆 WebSocket Hibernation、零儲存、有限流的廣播 DO。這個 repo 是把它換一層協定外殼。

所以這個 repo 的定位是：**把柴米帳的訊令從「借別人的、然後加密」改成「自己的一台混在公共的裡面」**。不取代公共 relay，混進去。自己那台掛了，公共的接手，因為大家講同一種話。

## 現在的狀態

**階段 0–3 完成，驗收通過，等部署。** 46 個測試、14 條 NIP-01 即時檢查、真的 Trystero 兩端 `onPeerJoin`，全綠。文件：

| 檔案 | 內容 |
| --- | --- |
| [docs/spec.md](docs/spec.md) | 協定子集。逐行讀 `@trystero-p2p/nostr@0.25.3` 寫出來的，每一條都對得到那 6KB 裡的某幾行。 |
| [docs/plan.md](docs/plan.md) | 六個階段、每階段怎麼證明、不做的清單、機器鎖。 |

下一步是 plan 的**階段 4**：部署到 `relay.arc.idv.tw`。repo 這一側備妥了，剩下的是 Cloudflare 儀表板，見下面「部署」。

## 幾個已經定案、不要重新討論的決定

這些在 spec 跟 plan 裡都有理由，這裡只列結論：

- **不驗 schnorr 簽章。** Trystero 的金鑰是每次開網頁隨機產的，pubkey 不是身分，驗了擋不到任何人。Workers 的 WebCrypto 也沒有 secp256k1。`id` 的 SHA-256 要驗，那是免費的。
- **零儲存。** 事件全在 ephemeral 區段，`since` 永遠是 `now()`，沒有歷史要查。零儲存是整件事便宜的原因，用原始碼比對的測試守著。
- **回送給發送者自己。** 標準 Nostr relay 就是這樣，Trystero 現在跑在公共 relay 上是好的，那個行為是它被驗證過的前提。**這跟 super-reversi2 的 ChatDO 相反**，所以 DO 要重寫不能抄。
- **不做公共 relay。** 存事件、索引查詢、保留策略、垃圾訊息，那是另一個專案。
- **super-reversi2 不搬過來。** 它自己那套撮合（房間狀態機、槽位、讀完即焚）解得更好，這個 relay 比它弱。
- **不動柴米帳 README 的「沒有伺服器」那句。** relay 在別的 repo，帳本從來不經過它；柴米帳只是把它列在 relay 清單裡，跟列 `relay.damus.io` 是同一件事。

## 參照的實作

寫程式的時候照抄這兩處的紀律，不要自己發明第二套：

- `super-reversi2/packages/signal/src/chat.ts`、`chatLogic.ts`、`test/chatStorageFree.test.ts`
  DO 外殼、純函式葉檔、token bucket、原始碼比對機器鎖。**但 fan-out 那段反過來**。
- `super-reversi2/eslint.config.js` 的 signal 那兩個 block
  禁 `fetch`、禁第三方 import、純函式檔禁 `Date.now` / `Math.random`。
- `accounting/packages/client/src/sync/trystero.ts`
  客戶端那一側；最後階段要改的是它的 `joinRoom` 呼叫，加一個 `relayConfig.urls`。

## 網域

`relay.arc.idv.tw`。只影響 `wrangler.jsonc` 一行跟柴米帳那一行，要換很便宜。

## 部署

Workers Builds（儀表板上連 GitHub 的 Worker），跟 super-reversi2、柴米帳、dev-blog 同一套。
CI 只擋壞掉的 PR，**不 deploy**；合進 `main` 就是 Cloudflare 自己 deploy。

儀表板要設的，照抄就好：

| 欄位 | 值 | 為什麼 |
| --- | --- | --- |
| Worker 名稱 | `relay` | **要跟 `wrangler.jsonc` 的 `name` 一字不差。** 不一樣會長出第二顆 Worker，網域掛在空的那顆上（柴米帳踩過） |
| Build command | 留空 | 沒有東西要 build，wrangler 自己打包 |
| Deploy command | `npx wrangler deploy` | `npx` 會撿 devDependencies pin 的 wrangler 版本 |
| Build branches | 只建 `main` | 非 production 分支跑 `wrangler deploy` 會紅（dev-blog 踩過），而且對 PR 沒意義 |
| Root directory | `/` | 單一套件 |

自訂網域 `relay.arc.idv.tw` 在 `wrangler.jsonc` 的 `routes` 裡，deploy 時會自動建 DNS 跟憑證，
前提是 `arc.idv.tw` 這個 zone 已經在同一個 Cloudflare 帳號底下（其他三個站都是這樣，所以是）。

免費方案的 DO **一律** `new_sqlite_classes`，即使零儲存 —— `new_classes` 要到 deploy 期才炸。
migration tag 套用後單向不可改寫，所以第一天就用正式類別名 `RelayDO` 燒 v1。

手動 deploy（不走儀表板）：`pnpm deploy`，需要本機有 Cloudflare 憑證。

**部署後的證明**（plan 階段 4）：把 `tools/trystero-smoke/entry.mjs` 的 `RELAY` 改成
`wss://relay.arc.idv.tw`，重打包，兩邊 `onPeerJoin` 要觸發。
