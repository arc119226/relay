# 實作計畫

規格在 [spec.md](spec.md)。這份講**怎麼做、做的順序、以及每一步怎麼證明它是對的**。

原則只有一條：**照抄 super-reversi2 的 `packages/signal/` 的紀律，協定換成 NIP-01。**
那套已經在線上跑、算過帳、有機器鎖守著。不要自己發明第二套。

---

## 0. 專案形狀

單一套件，不用 monorepo（只有一個 Worker，沒有 client）。

```
relay/
├── .github/workflows/ci.yml     lint → typecheck → test → wrangler deploy --dry-run
├── .node-version                22
├── package.json                 pnpm@11.9.0；devDeps：typescript、vitest、eslint、
│                                typescript-eslint、wrangler、@cloudflare/workers-types、
│                                @cloudflare/vitest-pool-workers（釘 0.12.21，見下）
├── pnpm-workspace.yaml          allowBuilds: esbuild, workerd, sharp:false
├── tsconfig.json                照抄 super-reversi2 的 tsconfig.base.json，加 workers-types
├── eslint.config.js             兩條鐵律（見 §3）
├── vitest.config.ts             兩個 project：unit（node）+ workers（workerd）
├── wrangler.jsonc               name: relay；routes: relay.arc.idv.tw；一顆 DO
├── src/
│   ├── index.ts                 router：OPTIONS / → CORS；GET|HEAD / (Accept: nostr+json) → NIP-11；
│   │                            GET / (Upgrade) → RelayDO；GET|HEAD /health；其他 404
│   ├── relay.ts                 RelayDO —— 只做 I/O + 時間；裁決全在純函式
│   ├── nip01.ts                 純函式：訊息框架的解析與驗形（EVENT/REQ/CLOSE）、event id 驗證
│   ├── nip11.ts                 純函式：relay information document（2026-09-03 補，見 spec §7.5）
│   ├── match.ts                 純函式：filter 比對（kinds ∩ since ∩ #x）
│   └── limits.ts                純函式：常數 + token bucket（從 chatLogic 搬）
├── test/
│   ├── nip01.test.ts
│   ├── match.test.ts
│   ├── limits.test.ts
│   ├── nip11.test.ts            宣告的每個數字 === limits.ts 的那個常數
│   ├── storageFree.test.ts      原始碼比對機器鎖（從 chatStorageFree 搬）
│   ├── relay.behaviour.test.ts  ⭐ 在 workerd 裡真的跑 Worker + RelayDO（完工稽核補的）
│   └── fixtures/trystero.json   真的 Trystero 產的事件，用來驗序列化一致
├── tools/
│   ├── smoke-nip01.mjs          對跑起來的 relay 做 14 條 NIP-01 即時檢查
│   ├── check-nip11.mjs          對跑起來的 relay 驗「宣告 === limits.ts」
│   └── trystero-smoke/          真 Trystero 兩端配對（?scenario=）
└── docs/
    ├── spec.md
    └── plan.md
```

⚠️ **`@cloudflare/vitest-pool-workers` 釘 0.12.21，不要升。** 0.13 起 peer 是 `vitest ^4`，
這個 repo 在 vitest 3.2.7；0.12.21 是最後一個支援 3.2.x 的。要升就得連 vitest 一起升。
另外 0.13+ 把 config helper 從 `./config` 搬走了，升上去 `vitest.config.ts` 會直接 load 失敗。

**為什麼 `relay.ts` 不叫 `chat.ts` 抄過來改**：ChatDO 的 fan-out **跳過發送者**，
NIP-01 relay **不能跳**（spec §3）。抄過來改最容易把這條抄錯，而且 `chatStorageFree.test`
裡有一條 `peer === ws` 的斷言會反過來逼你留著那個錯。所以 DO 重寫，測試也重寫，
只有 token bucket 那段是真的照搬。

---

## 1. 階段

每一階段結束都有一個「能證明」的動作。做不到證明就不算完。

### 階段 0 · 一小時 · 把未知數變成已知數

1. `pnpm init`、裝 devDeps、`wrangler.jsonc` 只放一顆空 DO。
2. 寫一支 20 行的 probe DO：`serializeAttachment` 塞 256 / 1024 / 2048 / 4096 / 8192 bytes，
   `wrangler dev` 起來用 `websocat` 或瀏覽器 console 打一下，看哪一級開始丟。
3. **證明**：記下實測上限，寫進 `limits.ts` 的註解。spec §6 那條就有了數字。

✅ **2026-09-02 完成。** 上限是 **16384 bytes**（序列化後），不是記憶中的 2KB。
runtime 的錯誤訊息直接寫著數字。16380 字元的字串序列化成 16385 bytes ⇒ 結構化複製
多 5 bytes 表頭。數字進了 `src/limits.ts`，政策上限（20 訂閱 / 16 主題）留了 3 倍餘裕。
probe 用的是 Node 22 的全域 `WebSocket` 對 `wrangler dev` 二分，不需要 websocat。

這一步可以跟階段 1 並行，但它的結果決定 `MAX_TOPICS_PER_FILTER` 是 16 還是別的數。

### 階段 1 · 半天 · 純函式層（零 Cloudflare 依賴）

`nip01.ts`：
- `parseClientMsg(raw: unknown): Verdict`（no-throw）
  → `{kind:'event', event}` | `{kind:'req', subId, filter}` | `{kind:'close', subId}` | `{ok:false, reason}`
- 驗形：型別、長度、`kind` 在 20000–29999、`tags` 只認 `["x", string]`、`created_at` 在 ±15 分鐘
- `eventId(event): Promise<string>`：`SHA-256(JSON([0,pubkey,created_at,kind,tags,content]))`
  → 這一支要 `crypto.subtle`，是純函式層裡**唯一**的 async；測試用 Node 的 WebCrypto 直接跑
- **不驗 `sig`**（spec §4，理由要寫在檔頭）

`match.ts`：
- `matches(event, filter): boolean` —— 三個條件全成立才 true
- `normalizeFilter(raw): Filter | null` —— 只留 `kinds` / `since` / `#x`，其他欄位靜默丟

`limits.ts`：
- 從 `chatLogic.ts` 搬 `Bucket` / `takeToken` / `bucketOf` / `fullBucket`，數字換成 spec §5
- 新增：`MAX_FRAME`、`MAX_SUBS_PER_SOCKET`、`MAX_TOPICS_PER_FILTER`、`MAX_KINDS_PER_FILTER`、
  `MAX_SOCKETS`、`CLOCK_SKEW_S`

**證明**：`vitest run` 全綠。每個純函式至少有「正典通過」「壞形狀永不 throw」「邊界值」三組。
`eventId` 用一個**從真實 Trystero 抓下來的事件**當 fixture —— 算出來的 id 要跟它自帶的 `id` 一樣。
這條測試等於在驗「我對 NIP-01 序列化的理解跟 Trystero 一致」。

✅ **2026-09-02 完成。** `pnpm check` 全綠：eslint 乾淨、tsc 乾淨、**30 個測試**（nip01 13、match 11、limits 6）。
fixture 是用真的 `@trystero-p2p/nostr@0.25.3` 的 `createEvent` / `subscribe` 產的（`test/fixtures/trystero.json`），
`eventId(fixture) === fixture.id` 一次過 —— 序列化跟 Trystero 一字不差。
eslint 兩條鐵律（禁 fetch/第三方 import；葉檔禁 Date.now/Math.random）也在這一階段進來，`pnpm lint` 擋。
一個小偏離：`KIND_MIN/MAX`、`SUBID_MAX`、`TOPIC_MAX` 放在 `limits.ts` 而不是 `nip01.ts`，
因為 `nip01` import `match`、`match` 又要用這些常數，放 nip01 會繞成環。

### 階段 2 · 半天 · DO 外殼

`relay.ts`（RelayDO）：
- `fetch`：426 非 WS / 503 連線滿 / 101 accept + `serializeAttachment({bucket, subs: {}})`
- `webSocketMessage`：
  1. 尺寸閘（**在 parse 之前**）
  2. `JSON.parse` → `parseClientMsg`
  3. token bucket（拒絕也寫回）
  4. 依 kind 分派：
     - `event` → 算 id 比對 → 對每一條 socket 的每一個 sub 跑 `matches` → `["EVENT", subId, event]`
       → **包含發送者自己** → 回 `["OK", id, true, ""]`
     - `req` → 檢查 subs 數與 filter 大小 → 寫回 attachment → 回 `["EOSE", subId]`
     - `close` → 從 attachment 刪 → 無回應
- `webSocketClose` / `webSocketError`：關掉，不做別的（訂閱隨 attachment 消失）

`index.ts`：
- `GET /` + `Upgrade: websocket` → `env.RELAY.get(idFromName('relay')).fetch(req)`（**單例**）
- `GET /health` → `{ok:true}`，不碰 DO
- `GET /` 沒有 Upgrade → 200，回一段純文字說這是什麼（給人看的）
- 其他 → 404

**證明**：
- `wrangler dev` 起來，用兩個瀏覽器分頁手打 NIP-01：A 送 REQ、B 送 EVENT、A 收到 EVENT 且 B 也收到（回送給自己）
- `storageFree.test.ts` 綠：零 `storage` / 零 `setAlarm` / 零 `.push(` / 尺寸閘早於 `JSON.parse` /
  **沒有 `peer === ws` 這種跳過自己的判斷**（跟 ChatDO 的鎖剛好反過來）

✅ **2026-09-02 完成。** `pnpm check` 全綠：**40 個測試**（+8 條 storageFree 結構鎖，第一次就過）。
沒有手打兩個分頁 —— 寫成 `tools/smoke-nip01.mjs`，用 Node 的 `WebSocket` 對 `wrangler dev` 跑
**14 條即時檢查**全過：REQ→EOSE、A 訂 B 發 A 收、**B 收到自己的（沒跳過發送者）**、tags 原樣、
竄改 id → `OK false invalid:`、壞 filter → `NOTICE`、壞 JSON 靜默、別的主題不扇出、
CLOSE 之後 A 收不到而 B 還有回聲、60 則爆發 → 42 收 18 擋（桶 40 + 爆發期間回補）。
跑法：`pnpm dev` 起來之後 `node tools/smoke-nip01.mjs`。
plan 之外多做的一件事：`match.ts` 加了 `isFilter` 守衛 —— attachment 讀回來不驗形狀就直接
`matches()`，遇到舊版寫的格式會在 `.includes` 上炸。

**對抗式覆核（同日）**：四個面向、12 項發現、駁回 9 項、確認 3 項，全部修掉，測試 40 → 46：
- **扇出放大**（高）：一則事件對每條 socket 的每個訂閱各 `JSON.stringify` 一次，上限 4000 次；
  改成只序列化一次、每則拼 subId；加 **DO 層總量桶**（記憶體內，爆發 200 / 穩態 50/s）；
  `MAX_FRAME` 從 64K 收到 16K code unit（原本 CJK 可以吃到 192 KB）。
- **免費鎖死**（高）：200 條閒置連線就讓所有真客戶端永遠 503。socket 用 `CF-Connecting-IP`
  當 tag，`getWebSockets(ip)` 數，**每 IP 8 條**。tag 撐得過 hibernation，零 storage。
- **`in` 走原型鏈**（低）：subId 叫 `toString` 會跳過上限、叫 `__proto__` 會換掉整張表的原型。
  訂閱表改 `Object.create(null)` + `Object.hasOwn`，上限算在合併之後。
- 順手：`since` 放 `CLOCK_SKEW_S` 容忍。發送方時鐘慢 δ 秒，嚴格比對會讓配對晚 δ 秒才成；
  relay 沒有歷史，`since` 只剩這個副作用，放寬是純收益。
駁回的 9 項裡有兩項值得記：`message.length` 數的是 UTF-16 code unit 不是 byte（已在 limits 註明）；
Trystero 對 NOTICE / OK-false 只 `console.warn`，永遠不會因為被拒而重試 —— 所以 REQ 那條路寧可寬。

### 階段 3 · 一小時 · 用真的 Trystero 打

不手打協定了，直接讓真的客戶端來：

```js
// 一個 20 行的 node 腳本或瀏覽器頁面
import {joinRoom} from 'trystero/nostr'
const room = joinRoom({appId:'relay-smoke', relayConfig:{urls:['ws://localhost:8787']}}, 'r1')
```

兩個分頁 join 同一個房間，`room.onPeerJoin` 要觸發。**這是整個專案的驗收**：
Trystero 透過我的 relay 完成了 WebRTC 握手。做到這一步，spec 就是對的。

**證明**：`onPeerJoin` 在兩邊都觸發；relay 的 `wrangler dev` log 看到 REQ → EVENT → OK 的往返。

✅ **2026-09-02 完成 —— 整個專案的驗收過了。**
不是 Node 腳本：Node 沒有 `RTCPeerConnection`，`onPeerJoin` 要 WebRTC 握手完成才會觸發。
做法是 `tools/trystero-smoke/`：用 esbuild 把**柴米帳實際裝的** `trystero/nostr@0.25.3` 打包成一頁
（`NODE_PATH` 指向 `accounting/packages/client/node_modules`），頁面自己嵌一個 iframe 當第二個 peer
（module scope 各自一個 `selfId`），兩邊 `relayConfig.urls` 都只指 `ws://127.0.0.1:8787`。
結果：host 與 guest **都收到 `onPeerJoin`**、各自透過 WebRTC 送一則並收到對方那則、
`getRelaySockets()` 兩邊都只有 `ws://127.0.0.1:8787`（沒有公共 relay 混進來）、
Trystero 零 warning、瀏覽器 console 空、relay 端 log 四次 `101 Switching Protocols` 零錯誤。
從頁面載入到配對完成約 100 ms。
（`wrangler dev` 的 log 只到 HTTP 層，看不到 WS 訊框；訊框層的往返是階段 2 那 14 條 smoke 證的。）

跑法：
```bash
pnpm smoke:build               # esbuild 打包成一頁，零外部路徑
pnpm dev                       # relay 在 8787
# 另開一個靜態伺服器把 tools/trystero-smoke/ 端在 4322（.js 要給 text/javascript，module script 認 MIME）
# 瀏覽器開 http://127.0.0.1:4322/index.html，看 window.__result 與 iframe 的 contentWindow.__result
```

情境用 query 選（預設 `solo`，打 `ws://127.0.0.1:8787`）：

| 參數 | 意思 |
| --- | --- |
| `?scenario=solo` | 只打自架那台（預設）。階段 3 的驗收 |
| `?scenario=full` | 錨點 + 五台公共 |
| `?scenario=anchor` | 只有錨點 —— 證明公共全掛也配得上 |
| `?scenario=failover` | 錨點指向連不上的位址 + 五台公共 —— 等同「把 Worker 暫停」 |
| `?anchor=wss://…` | 換掉錨點位址（**要打正式站就用這個**） |
| `?relays=a,b` | 完全自訂清單 |
| `?appId=…` | 換 appId（用 `zhangben-sync-v1` 可重現柴米帳的派生結果） |

⚠️ **這一段原本寫死作者本機的路徑**（`NODE_PATH=C:/gitcode/accounting/...`），
而且預設情境直接打作者的正式站 —— 意思是任何 fork 這個 repo 的人：打不出包，
就算打出來了，拿到的綠燈證明的也是**別人的服務還活著**，不是自己那台對。
2026-09-03 修掉：`trystero` 與 `esbuild` 進 devDependencies，預設改成 `127.0.0.1:8787`，
正式站位址改用 `?anchor=` 傳。**這個 repo 的驗收，任何人 clone 下來都跑得起來。**

⚠️ **Windows 上收 `wrangler dev` 的坑（這次踩了三輪）**：`pkill -f "wrangler dev"` 跟 `taskkill /IM workerd.exe`
都收不乾淨 —— 真正的父行程命令列是 `node ".../wrangler/bin/wrangler.js" dev --port 8787`（沒有
「wrangler dev」這個字串），殺掉 workerd 它會立刻再生一顆。四輪 smoke 留下四棵孤兒樹、8787 上四個
listener，`/health` 打到死的那顆就回空。要用 PowerShell 照命令列殺：
`Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'wrangler' -and $_.CommandLine -match '8787' } | % { Stop-Process -Id $_.ProcessId -Force }`
（記得排除 powershell 自己：那段腳本的命令列也含這些字。）

### 階段 4 · 一小時 · 部署

1. `wrangler.jsonc`：`routes: [{pattern: "relay.arc.idv.tw", custom_domain: true}]`，
   `migrations: [{tag:"v1", new_sqlite_classes:["RelayDO"]}]`（免費方案硬規定，即使零儲存）
2. Cloudflare 儀表板開 Workers Builds 連 GitHub：build 空、deploy `npx wrangler deploy`
   ⚠️ **`name` 要跟儀表板的 Worker 名字一字不差**，不然會長出第二顆 Worker 而網域掛在空的那顆上
   （柴米帳 `wrangler.jsonc` 檔頭記著這個事故）
3. **Workers Builds 對非 production 分支也會跑 `wrangler deploy` 然後紅燈** —— dev-blog 踩過。
   一開始就把 build branches 設成只建 main，或者接受 PR 上永遠有一個無意義的紅燈。

**證明**：`wss://relay.arc.idv.tw` 用階段 3 那支腳本再打一次，`onPeerJoin` 觸發。

✅ **2026-09-02 完成。** 正式站跑的是我們的程式（`/health` → `{"ok":true}`、`/nope` → 404、
`POST /` → 405、`Upgrade` → **101**，那個 101 是 `RelayDO` 回的 ⇒ DO 活著、migration v1 套用了）。
真的 Trystero 對 `wss://relay.arc.idv.tw`：host 與 guest 都 `onPeerJoin`（2786 / 2727 ms）、
互相收到訊息、兩邊 `getRelaySockets()` 只有這台、零 warning。14 條 NIP-01 檢查對正式站也全過。

🐛 **順便在正式站抓到一個真的洩漏。** 每 IP 上限寫 8，實際只開得了 6，靜置三分鐘也不回來 ——
兩格被前面測試留下的**半開 socket** 永久佔住。WebSocket 沒有內建保活，瀏覽器分頁被砍、
行程 `process.exit`、手機掉網，那條 TCP 半開的**不會**觸發 `webSocketClose`，
可是 `getWebSockets()` 照樣數得到。這是**單向洩漏**：累積到上限，真客戶端就再也連不上，
而症狀只有「配對失敗」。對抗式覆核當時預測過（那條 finding 的後半段），我只做了 IP tag 那一半。
修法見下面那個 commit：`liveCount()` —— 在達到上限時才掃，用令牌桶的 `at` 當最後活動時間，
沉默超過 `IDLE_REAP_MS`（5 分鐘）就順手 `close(1001,'idle')` 並且不計數。零額外儲存。

✅ **2026-09-02 repo 側與儀表板側都完成了。** 下面這串留著，因為它是部署設定的清單：
- `.github/workflows/ci.yml`：lint → typecheck → test → `wrangler deploy --dry-run`。不 deploy、不帶憑證。
  照抄 dev-blog 的兩條坑：`pnpm/action-setup` 不設 version（packageManager 是唯一真相）、
  Node 版本讀 `.node-version`。
- `package.json` 加 `deploy` = `wrangler deploy`（手動用）。
- README 加「部署」一節，儀表板五個欄位的值與理由列成表。
- `wrangler.jsonc` 從階段 0 起就是正式的：`name: relay`、`routes: relay.arc.idv.tw`、migration v1 `RelayDO`。
儀表板側（**已完成**）：Workers Builds 連 GitHub、Worker 名字 `relay`、build 留空、
deploy `npx wrangler deploy`、只建 `main`。`entry.mjs` 也已指向 `wss://relay.arc.idv.tw`
並重跑過 trystero-smoke —— 那就是這一階段的證明，見上面那段 ✅。

### 階段 5 · 半小時 · 接進柴米帳

柴米帳 `sync/trystero.ts` 的 `joinRoom` 加一個欄位：

```js
relayConfig: {
  urls: [
    'wss://relay.arc.idv.tw',
    'wss://relay.damus.io',
    'wss://nos.lol',
  ],
},
```

- 三台就好：一台自己的、兩台公共裡最穩的。redundancy 不用設，`urls` 給了就全用。
- 同時把 `trystero.ts` 檔頭跟 `BACKLOG.md` 那段「升級 trystero 有機會讓兩支手機永遠配不上對」
  改成已處理 —— 明寫 `urls` 之後那個洗牌地雷就拆了。
- **不動柴米帳的 README「沒有伺服器」那句**。relay 不是柴米帳的一部分，它在別的 repo、
  帳本從來不經過它；柴米帳只是把它列在 relay 清單裡，跟列 `relay.damus.io` 是同一件事。

**證明**：兩支真手機掃 QR 同步一次。然後把 `relay.arc.idv.tw` 的 Worker 暫停，**再同步一次**，
要照樣成功 —— 這一步證明公共 relay 真的在當備援、自架那台不是單點。

✅ **2026-09-03 完成，但實作比這裡寫的多一層。** 上面那段寫死三台的 `urls` 只解了洗牌地雷，
沒解「自己維護一份會腐敗的名單」那個代價 —— 而那正是當初否決釘清單的理由。
實際做法：錨點寫死在程式裡（`sync/relays.ts` 的 `ANCHOR`，遠端動不到），後段公共清單放
`public/relays.json` 同源可更新（`.json` 不進 SW precache ⇒ 永遠走網路），啟動時自動拉、
設定頁有手動更新鈕。**改一份 JSON 部署上去就換掉，不必發新版 bundle。**
柴米帳側 PR #12（`5c13ad9`），13 條測試鎖住「`relayUrls()` 恆非空且第一個恆是錨點」。

**證明**：真手機那半沒做（要兩支在手邊）。可以做的那半用真 Trystero 在瀏覽器裡跑 ——
`tools/trystero-smoke/` 加了 `?scenario=`，用柴米帳**真正的 `appId`**（`zhangben-sync-v1`），
所以派生金鑰與 topic 的算法跟正式站一致：

| 情境 | relay 清單 | host / guest 配對 |
| --- | --- | --- |
| `full` | 錨點 + `relays.json` 當時的五台 | 727 / 672 ms |
| `anchor` | 只有錨點 | 2193 / 2149 ms |
| `failover` | **錨點換成連不上的位址** + 五台公共 | 665 / 615 ms |

⚠️ 這張表原本寫「`full` ＝正式站現況」。**跑完十分鐘就不成立了** —— 下面那條 🐛 的結果
讓柴米帳把 `relays.json` 換掉了（accounting `8211406`）。`entry.mjs` 的 `PUBLIC` 是手抄的
一份快照，會腐敗；它現在的用途是「舊清單的回歸」，不是「正式站現況」。
**要驗正式站現況請去柴米帳跑 `tools/probe-relays.mjs`，不要讀這張表。**

`failover` 是「把 Worker 暫停再同步一次」的替代，而且不必真的動正式站：
socket 快照確認 `wss://suspended.relay.arc.idv.tw` 是 `closed`，配對由公共那幾台完成。
⇒ **錨點掛掉時公共 relay 真的接得住，自架那台不是單點。** 這一條證完了。

**但要說清楚它沒證到什麼**，免得日後把它讀得太滿：

1. **受測物是一頁裸 Trystero，不是柴米帳。** 階段 5 真正交付的那些程式（`relayUrls()`、
   `relays.json` 拉取與清洗、`MAX_TAIL`、localStorage 快取、離線退回 `BUNDLED_TAIL`）
   在這條情境裡一行都沒執行 —— 它們由柴米帳自己的 13 條單元測試蓋住。
   分工是刻意的（決定性邏輯進單元測試、網路配對命題進瀏覽器 smoke），但別把它說成
   「柴米帳會 failover」已經驗過了。
2. **兩端的公共清單必然相同。** iframe 繼承整串 query，所以 host 與 guest 拿到逐字一樣的
   `relays`。而錨點存在的理由之一正是「**兩支手機的公共清單可能不同**」——
   那個 hazard 是靠錨點恆在**結構性關掉**的，不是這裡測掉的；也測不掉，因為
   failover 的前提就是把錨點拿走。
3. 真手機那半沒做（要兩支在手邊）。

反過來 `anchor` 證明公共全掛也配得上，只是**慢了約三倍**（2193 對 727 ms）。
原因不只是「沒得挑最快的」—— 單一 relay 沒有備援可以並行嘗試，配對時間就是那一台的
往返時間，沒有其他台可以先到先贏。

🐛 **順手量到一件更該處理的事：`relays.json` 那五台，只有兩台是活的。**
`full` 情境的 warning 整排都是同兩台在噴。寫了一支探針逐台實測「送得進去且收得回來」
（用 Trystero 自己的 `createEvent` 產**真簽章**事件 —— 公共 relay 會驗 schnorr，
自己捏的一定被拒，所以不能自己組），23 台裡 13 台可用：

- `hornetstorage.net/relay` —— 改成允許清單制了：`Read access denied: User not in allowed list`
- `slick.mjex.me` —— 每一則都 `error: internal error`
- `communities.nos.social` —— 連不上
- 活著的只有 `staging.yabu.me`（209 ms，全場最快，諷刺）與 `relay2.angor.io`

也就是說**柴米帳這半年其實是靠兩台在配對**，其中一台叫 staging。這件事在自架之前不會有人
發現 —— 症狀是「偶爾配對比較慢」，不是錯誤。這反過來說明錨點的價值不只是「多一台」：
它是唯一一台**壞了我會知道**的。探針收進柴米帳 `tools/probe-relays.mjs`，下次換清單先跑它。

### 階段外 · NIP-11（2026-09-03）

**沒有階段編號，因為它是開源前才決定要做的**（原本在 spec §7 的「不做」表裡，
理由是「Trystero 不讀」——那在只有一個客戶端時成立，公開之後不成立）。
設計、三個被規格擋掉的欄位、以及 `OPTIONS` 那條路由的理由，全寫在 **spec §7.5**。

**證明**：`node tools/check-nip11.mjs https://relay.arc.idv.tw` —— 它把**線上回來的**
`limitation` 逐項對 `src/limits.ts` 的常數比。這一條就是整個功能的重點：
宣告與實作對不上就是在騙客戶端，而客戶端會照它調參數然後在真正的閘門上撞牆。
CI 跑不動它（要一個跑起來的服務），CI 側的等價物是 `test/nip11.test.ts` 逐項斷言。

⚠️ 這一項當初**沒有寫進 plan 也沒有留證明動作**，是後來稽核才補上的。
插隊做的東西也要留一段，否則 plan 會宣稱「六階段全完成」而其中一整塊功能不在任何階段裡。

---

### 完工稽核（2026-09-03）

六階段標完之後做的一次「這個宣稱哪裡不成立」的稽核：六個面向平行找、每條發現再派兩個
立場不同的覆核者對抗式駁斥（懷疑論者 + 維護者），提出 50 條、留下 46 條。
**它推翻了「做完了」這個宣稱**，修掉的實質缺陷有三類：

**1. 正式站上真的有一個洩漏（`749d692`）**
階段 4 在正式站量到「每 IP 上限寫 8 實際只開得了 6」，當時只修了每 IP 那一條。
**同一個洩漏在全域那條原封不動**：`readyState === WS_OPEN` 濾不掉半開 socket
（半開的 readyState 正是 OPEN 而且不會自己消失），而且那條 503 排在每 IP 那條**之前**，
連「回來的 IP 順手清一清」這唯一的自癒路徑都被自己擋掉 ⇒ 累積到 200 之後對所有人回 503，
只有重新部署救得回來。行動網路每次換 IP，留下的半開 socket 不會有人回來掃，所以這會發生。
`liveCount` 改成 `reapAndCount(sockets, nowMs)`，兩道閘餵同一支。

**正式站實測（2026-09-03，部署後）**：剛跑完 smoke 時只開得了 **6** 條 —— 那兩格是
smoke 留下的半開 socket，**而且那是對的**：它們還沒閒置滿 `IDLE_REAP_MS`（5 分鐘），
本來就該算數。等過了那個窗再量，**8 條、第 9 條被拒**。
回收確實在動，而且沒有早收活人的連線。
（階段 4 當初量到 6 就以為是 bug —— 那次是真的漏，但這次的 6 不是。
差別在「量的時候距離上一次連線多久」，量之前要先想清楚這件事。）

**2. `src/relay.ts` 從來沒有被任何測試執行過（`5959315`）**
64 個測試對它只做原始碼字串比對，而**字串比對守的是拼字不是行為**。
稽核當場示範兩種各改一行就把 fan-out 改成跳過發送者、而 `pnpm check` 全綠的寫法：
加第三個參數 `sender`，或連改名都不用的 `this.lastSender === peer`（左右對調就躲掉了）。
現在 `test/relay.behaviour.test.ts` 在 workerd 裡真的把 Worker 與 RelayDO 跑起來（18 條），
鐵律 4 第一次有行為斷言。原始碼鎖留著當第二道防線，但改成鎖形狀而不是鎖識別字。

**3. 機器鎖上的後門**
`no-restricted-globals` 的 `fetch` 只擋裸識別字 ⇒ `globalThis.fetch` 放行；
`no-restricted-imports` 只認靜態 import ⇒ `await import()` 放行。兩個都實測過會通過整條 check。
⚠️ 補的時候踩到這個檔案自己警告過的坑：純函式葉檔**同時吃得到兩個 block**，
flat config 同名規則後蓋前**不是合併**，所以共用內容要抽成陣列在兩處展開。
七種繞法全部反向驗證會紅。

還有一批文件與事實對不上的（測試數、行數、交叉引用指到不存在的節、已完成卻還寫著待做），
一併修掉了。**最貴的一條是 `CLAUDE.md` 的「目前狀態」停在階段 3 整整兩個階段** ——
那是新 session 第一個讀的檔案，它會讓下一個 session 去做一件已經做完的事。
規矩因此加一句：**標掉階段的那個 commit 要同時更新 CLAUDE.md 的「目前狀態」。**

**這次稽核本身的教訓**：每階段結尾的「證明」擋得住「做錯」，擋不住「沒做」與「說謊」。
六個階段各自的證明都通過了，而上面三條沒有任何一條被那些證明碰到。

---

## 2. 不做的清單（動手前先讀，免得手癢）

| 不做 | 為什麼 |
| --- | --- |
| 驗 schnorr 簽章 | spec §4：金鑰每次隨機，驗了擋不到人；而且 Workers 沒 secp256k1 |
| 任何 `ctx.storage` | 零儲存是整件事便宜的原因；機器鎖守著 |
| 多顆 DO / 分片 | 一個客戶、一個月幾次配對；先做單例 |
| 自訂協定 | 講 NIP-01 才有公共 relay 當備援（spec §8） |
| 把 super-reversi2 搬過來 | 它自己那套撮合解得更好；這個 relay 比 DuelRoomDO 弱 |
| 從 ChatDO 複製貼上 | 它跳過發送者，這裡不能跳；重寫比改安全 |

---

## 3. 機器鎖（eslint + 測試）

從 super-reversi2 照搬兩條，因為它們就是「只做撮合」這句話的硬度來源：

**eslint**
- `src/**`：禁 `window` / `document` / `fetch`；禁一切非 `cloudflare:workers` 的 import
  → relay 不外呼任何第三方，這是可以被 diff 看見的事實，不是承諾
- `src/{nip01,match,limits}.ts`：禁 `Math.random` / `Date.now`
  → 純函式葉檔，時間與隨機一律由 `relay.ts` 餵入；否則 vitest 不可能決定論

**測試**
- `storageFree.test.ts`：原始碼比對 `relay.ts`
  - 零 `storage` / `setAlarm` / `transaction` / `blockConcurrencyWhile`
  - 零 `.push(`（沒有任何「累積訊息」的形狀）
  - 走 `acceptWebSocket` + `webSocketMessage`，**不是** `addEventListener('message')`（那會擋掉 hibernation）
  - 尺寸閘的判斷式在 `JSON.parse` **之前**（找判斷式不找識別字，理由見 chatStorageFree.test）
  - **沒有** `peer === ws` / `if (peer !== ws)` 之類跳過自己的判斷

---

## 4. 時間

| 階段 | 估 |
| --- | --- |
| 0 probe | 1h |
| 1 純函式 + 測試 | 半天 |
| 2 DO | 半天 |
| 3 Trystero 冒煙 | 1h |
| 4 部署 | 1h |
| 5 接柴米帳 + 真機 | 半小時 + 兩支手機在手邊 |

**一個週末，鬆的。** 最可能超時的是階段 4 的儀表板設定，那是點滑鼠，不是寫程式。

---

## 5. 當初懸著的決定（都已裁決，留著是因為理由有用）

1. **網域** —— 選了 `relay.arc.idv.tw`。只影響 `wrangler.jsonc` 一行跟客戶端那一行，要換很便宜。
2. **先量再寫** —— 階段 0 的 probe（20 行 + `wrangler dev`）先跑，把 `serializeAttachment` 的上限從
   「記憶中的 2KB」變成實測的 16384。那個習慣後來救了不只一次:每 IP 上限也是先量到
   「寫 8 實際只有 6」才發現半開連線的洩漏。
