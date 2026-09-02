# relay

一個**只講 NIP-01 子集**的 WebSocket 廣播器，跑在 Cloudflare Durable Object 上，
給自架的 P2P 應用當 WebRTC 訊令用。收到事件就轉發給訂閱得上的人，**什麼都不存**。

約 400 行程式、**零 runtime 依賴**、64 個測試。

正式站：`wss://relay.arc.idv.tw`（作者自用；要用請自己架一份，見下面）

## 為什麼會有這個東西

[柴米帳](https://github.com/arc119226/accounting) 是一個兩個人共用的記帳 PWA，
兩支手機面對面掃 QR 之後用 WebRTC 直接同步，沒有伺服器。可是 WebRTC 需要有人
幫兩端交換第一封信（SDP），那件事叫**訊令**，而訊令需要一個雙方都連得到的地方。

它原本用 [Trystero](https://github.com/dmotz/trystero) 的 Nostr strategy 解決：
去借公共的 Nostr relay，自己零基礎設施。查清單的時候發現兩件事：

1. Trystero 從烤在套件裡的 47 個公共 relay **依 appId 決定性洗牌後取 5 個**。
   決定性是必要的（兩機得在同一批 relay 上碰頭），可是**清單增刪任何一個，
   洗出來的 5 個就可能與舊版毫無交集**——升級套件就可能讓兩支手機永遠配不上對，
   而畫面只會說「等不到對方」。
2. 那 5 個裡有一台叫 `staging.yabu.me`。家裡的帳本配對，押在陌生人的 staging 機器上。

第一個問題**不需要自架**就能修（明寫 `relayConfig.urls` 釘住清單即可）。
自架的理由是第二個：**那條依賴的性質不對。**

然後讀了 Trystero 的原始碼，發現它對 relay 的要求小到有點好笑——三種訊息、
一種 filter 形狀、事件全在 ephemeral 區段（規格明說不該存）、而且連 `EOSE` 都不看。
這種東西在 Durable Object 上就是幾百行。

## 這是什麼、不是什麼

**是**：一個照 NIP-01 說話的訊令廣播器。
**不是**：Nostr relay。它不存事件、不做歷史查詢、不驗簽章、只認一種 filter 形狀。

要完整的 Nostr relay 請看 `strfry` 或 `nostr-rs-relay`。

用得上這個的情境是：**你有一個自己的 P2P 應用，想要一台自己控制的訊令，
而且不想為此接手維護一個資料庫。**

### 混搭，不是取代

自架一台**不該**變成新的單點故障。建議的用法是把它跟幾個公共 relay 並列：

```js
joinRoom(
  { appId: 'your-app', relayConfig: { urls: [
      'wss://relay.your-domain.example',   // 自己的:兩端必定相遇的錨點
      'wss://relay.damus.io',              // 公共的:自己那台掛了還有這些
      'wss://nos.lol',
  ] } },
  roomId,
)
```

這樣一次拿到三件事：

- 多一台自己控制的
- 公共的當備援（Trystero 的每個 relay 各自 `await`，**沒有** `Promise.all` 把整個房間
  卡在全部連上——自架那台掛了，它只是永遠不訂閱，其他照走）
- **順便關掉開頭那個洗牌地雷**：明寫 `urls` 之後，套件改版動到那 47 個的陣列長度
  就再也影響不到你

錨點那一台最好永遠留在清單裡：只要兩端都有它，公共清單各自不同也碰得到面。

## 協定

完整的子集說明在 **[docs/spec.md](docs/spec.md)**——那份是逐行讀
`@trystero-p2p/nostr@0.25.3` 的原始碼推導出來的，每一條都對得到那 6 KB 裡的某幾行。

摘要：

| 客戶端 → relay | 支援 |
| --- | --- |
| `["EVENT", <event>]` | kind 限 20000–29999（ephemeral），驗 `id` 的 SHA-256，**不驗 `sig`** |
| `["REQ", <subId>, <filter>]` | filter 只認 `kinds`、`since`、`#x`；一個 REQ 一個 filter |
| `["CLOSE", <subId>]` | 有 |

| relay → 客戶端 | 說明 |
| --- | --- |
| `["EVENT", <subId>, <event>]` | **包含發送者自己**（標準 Nostr 行為） |
| `["OK", <id>, <bool>, <msg>]` | 拒收時帶 `invalid:` / `rate-limited:` 前綴 |
| `["EOSE", <subId>]` | 沒有歷史，REQ 之後立刻送 |
| `["NOTICE", <msg>]` | 形狀壞、訂閱過量 |

filter 的其他欄位（`authors`、`ids`、`until`、`limit`、`#e`、`#p`）**靜默忽略**，
不當錯誤——未來的客戶端多送也不會壞，只是那些條件不生效。

### 能力宣告（NIP-11）

上面那張表也有機器可讀的版本：

```bash
curl -H 'Accept: application/nostr+json' https://relay.example.com/
```

回一份 NIP-11 relay information document，`limitation` 裡的每個數字都**直接來自
`src/limits.ts`**（不是另外手打一份）——一份會說謊的能力宣告比沒有更糟，客戶端會照它
調參數然後在真正的閘門上撞牆。`tools/check-nip11.mjs` 會對跑起來的服務逐項驗這件事。

有三個欄位**刻意不填**，理由在 `docs/spec.md` §7.5：`retention`（規格裡沒有這個欄位）、
`created_at_lower_limit` / `_upper_limit`（規格沒定義是絕對時戳還是相對偏移，填了會被誤讀）、
`pubkey` / `contact`（沒有穩定身分）。那三件事改用 `description` 的散文講。

`OPTIONS /` 也回 NIP-11 要求的三個 `Access-Control-Allow-*`。

## 開發

需要 Node 22（`.node-version`）與 pnpm。

```bash
pnpm install
pnpm check      # lint → typecheck → test
pnpm dev        # wrangler dev,port 8787
```

跑起來之後可以打兩種冒煙測試：

```bash
# 1. 手打 NIP-01:14 條即時檢查(REQ→EOSE、扇出、竄改 id、限流…)
node tools/smoke-nip01.mjs                       # 打本機
node tools/smoke-nip01.mjs wss://your-relay.example   # 打線上

# 1b. NIP-11 的宣告有沒有跟實際的閘門對上(比對 src/limits.ts)
node tools/check-nip11.mjs                       # 打本機
node tools/check-nip11.mjs https://your-relay.example

# 2. 真的 Trystero 兩端配對——這是這個專案真正的驗收
#    (Node 沒有 RTCPeerConnection,onPeerJoin 要 WebRTC 握手完成才會觸發,
#     所以這支必須跑在瀏覽器裡)
#    打包與跑法見 docs/plan.md 階段 3
```

`docs/plan.md` 是施工紀錄：六個階段，每一階段結尾都有一個「怎麼證明它是對的」，
包含實測到的數字與踩過的坑。要改這個 repo 的話那份比 README 有用。

## 自己部署

```bash
npx wrangler deploy
```

部署前把 `wrangler.jsonc` 改成你自己的：

```jsonc
"name": "relay",                                        // ← 你的 Worker 名字
"routes": [{ "pattern": "relay.example.com",            // ← 你的網域
             "custom_domain": true }],
```

⚠️ **`name` 要跟 Cloudflare 儀表板上的 Worker 名字一字不差**，
不一樣會長出第二顆 Worker，而網域還掛在空的那顆上。

免費方案的 Durable Object **一律**得走 `new_sqlite_classes`（`new_classes` 要到
deploy 期才炸），即使這顆 DO 根本不用 storage。migration tag 套用後單向不可改寫。

要走 Git 自動部署（Workers Builds）的話：build command 留空、deploy 填
`npx wrangler deploy`、**build branches 只設 production 分支**——
非 production 分支跑 `wrangler deploy` 會紅，而且對 PR 沒有意義。

部署完的證明不是儀表板顯示綠色，是這兩支對正式站全過：
`node tools/smoke-nip01.mjs wss://你的網域` 與 `node tools/check-nip11.mjs https://你的網域`。

## 隱私

一個訊令 relay 天生站在使用者的信任邊界**之外**。營運者看得到什麼、看不到什麼、
以及「什麼都不存」為什麼是結構性事實而不是承諾——全部寫在
**[SECURITY.md](SECURITY.md)**。

一句話版本：看得到 IP、連線時間、topic 的雜湊值、約 2 KB 的密文；
看不到 SDP 明文、房間碼、配對成功之後的任何東西。

## 這是什麼樣的專案

**這是為一個特定用途做的，不是通用產品。** 目前只有一個客戶端（柴米帳），
一個月大概用幾次配對。取捨一律偏向「那個用途對」而不是「大多數 Nostr 使用者可能會想要」。

功能請求之前請先讀 [CONTRIBUTING.md](CONTRIBUTING.md)——有一張「已經被否決」的清單，
理由都寫在 `docs/spec.md` §7。

程式碼的紀律（零第三方 import、純函式葉檔禁時間與隨機、零 storage、順序即契約）
寫在 `CLAUDE.md`，而且大部分有 ESLint 或原始碼比對測試機器強制著。

## 授權

程式碼 Apache-2.0（見 [LICENSE](LICENSE) 與 [NOTICE](NOTICE)）。
`docs/` 底下的文件 CC BY-SA 4.0（見 [docs/LICENSE.md](docs/LICENSE.md)）。
