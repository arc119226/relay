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
│                                typescript-eslint、wrangler、@cloudflare/workers-types
├── pnpm-workspace.yaml          allowBuilds: esbuild, workerd
├── tsconfig.json                照抄 super-reversi2 的 tsconfig.base.json，加 workers-types
├── eslint.config.js             兩條鐵律（見 §3）
├── wrangler.jsonc               name: relay；routes: relay.arc.idv.tw；一顆 DO
├── src/
│   ├── index.ts                 router：GET / (Upgrade) → RelayDO；GET /health；其他 404
│   ├── relay.ts                 RelayDO —— 只做 I/O + 時間；裁決全在純函式
│   ├── nip01.ts                 純函式：訊息框架的解析與驗形（EVENT/REQ/CLOSE）、event id 驗證
│   ├── match.ts                 純函式：filter 比對（kinds ∩ since ∩ #x）
│   └── limits.ts                純函式：常數 + token bucket（從 chatLogic 搬）
├── test/
│   ├── nip01.test.ts
│   ├── match.test.ts
│   ├── limits.test.ts
│   └── storageFree.test.ts      原始碼比對機器鎖（從 chatStorageFree 搬）
└── docs/
    ├── spec.md
    └── plan.md
```

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

### 階段 4 · 一小時 · 部署

1. `wrangler.jsonc`：`routes: [{pattern: "relay.arc.idv.tw", custom_domain: true}]`，
   `migrations: [{tag:"v1", new_sqlite_classes:["RelayDO"]}]`（免費方案硬規定，即使零儲存）
2. Cloudflare 儀表板開 Workers Builds 連 GitHub：build 空、deploy `npx wrangler deploy`
   ⚠️ **`name` 要跟儀表板的 Worker 名字一字不差**，不然會長出第二顆 Worker 而網域掛在空的那顆上
   （柴米帳 `wrangler.jsonc` 檔頭記著這個事故）
3. **Workers Builds 對非 production 分支也會跑 `wrangler deploy` 然後紅燈** —— dev-blog 踩過。
   一開始就把 build branches 設成只建 main，或者接受 PR 上永遠有一個無意義的紅燈。

**證明**：`wss://relay.arc.idv.tw` 用階段 3 那支腳本再打一次，`onPeerJoin` 觸發。

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

---

## 2. 不做的清單（動手前先讀，免得手癢）

| 不做 | 為什麼 |
| --- | --- |
| 驗 schnorr 簽章 | spec §4：金鑰每次隨機，驗了擋不到人；而且 Workers 沒 secp256k1 |
| 任何 `ctx.storage` | 零儲存是整件事便宜的原因；機器鎖守著 |
| 多顆 DO / 分片 | 一個客戶、一個月幾次配對；先做單例 |
| NIP-11 | Trystero 不讀；以後想給人看再加，一個 HTTP 回應的事 |
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

## 5. 還要你決定的

1. **網域**：`relay.arc.idv.tw`？還是 `nostr.arc.idv.tw`、`signal.arc.idv.tw`？
   只影響 `wrangler.jsonc` 一行跟柴米帳那一行。
2. **階段 0 現在就跑，還是先看過計畫**？probe 是 20 行 + `wrangler dev`，不碰正式環境。
