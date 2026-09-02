# 訊令 relay 規格（NIP-01 子集）

`wss://relay.arc.idv.tw`

這份規格的範圍是：**讓 Trystero 的 nostr strategy 能跑**，不多不少。
不是一個 Nostr relay，是一個照 NIP-01 說話的 WebSocket 廣播器。

規格是從 `@trystero-p2p/nostr@0.25.3` 的原始碼逐行讀出來的，不是照 NIP-01 全文抄的。
下面每一條都對得到那 6KB 裡的某幾行。

---

## 0. 一句話

收 WebSocket，收到 `EVENT` 就丟給所有 filter 對得上的訂閱者，**什麼都不存**。

---

## 1. 客戶端會送什麼

只有三種。

### `["EVENT", <event>]`

`event` 的長相（`createEvent`）：

```json
{
  "kind": 20000-29999,
  "tags": [["x", "<房間主題>"]],
  "created_at": 1788350000,
  "content": "<字串>",
  "pubkey": "<64 hex>",
  "id": "<64 hex>",
  "sig": "<128 hex>"
}
```

- `kind = strToNum(topic, 10000) + 20000` ⇒ 恆落在 **20000–29999**。
  那是 NIP-01 的 **ephemeral 區段，規格明說 relay 不該儲存**。
- `tags` 恆為單一個 `["x", topic]`。
- `id = SHA-256(JSON([0, pubkey, created_at, kind, tags, content]))`，十六進位小寫。
- `sig` 是對 `id` 的 schnorr 簽章（secp256k1）。

### `["REQ", <subId>, <filter>]`

`subId` 是 64 字元亂數。**一個 REQ 只帶一個 filter**（NIP-01 允許多個，它不用）。

```json
{
  "kinds": [20001, 20042],
  "since": 1788350000,
  "#x": ["<主題1>", "<主題2>"]
}
```

- 會**批次**：最多 250 個主題塞進同一個 REQ（`maxTopicsPerSubscription`）。
  主題超過 250 就開第二個 subId。
- **實際上一個房間只有兩個主題**：`rootTopic`（房間本身）跟 `selfTopic`（這個 peer 自己）。
  兩者都是 SHA-1 逐 byte 轉 base36 串起來，各約 20–40 字元。
  250 是客戶端的上限，不是柴米帳會送的量 —— 柴米帳一次同步就一個房間。
- `since` 永遠是 `now()`，也就是「只要新的」。
- 重連之後會**重送 REQ**（`resubscribeOnReconnect`）⇒ relay 不必跨連線記住訂閱。

### `["CLOSE", <subId>]`

取消訂閱。房間退光了才送。

---

## 2. 客戶端會讀什麼

| relay → client | 客戶端怎麼處理 |
| --- | --- |
| `["EVENT", <subId>, <event>]` | **唯一有作用的**。它讀 `event.content` 與 `event.tags` |
| `["NOTICE", <訊息>]` | `console.warn` |
| `["OK", <eventId>, <bool>, <訊息>]` | `bool` 為 false 時 `console.warn` |

**它完全不看 `EOSE`。** 送不送都行，送了比較守規矩（而且未來換 client 比較安全）。

`["EVENT", ...]` 裡的 `subId` 要填**當初那個 REQ 的 subId** —— 客戶端靠它決定
要交給哪個 handler。批次訂閱的情況它會退而用 `tags` 裡的 `x` 值去找主題，
所以 **`tags` 一定要原樣轉發**。

---

## 3. Relay 的行為

### 收到 EVENT

1. 檢查大小、格式、欄位型別（見第 5 節）。
2. 找出所有「filter 對得上」的**開啟中訂閱**，各送一則 `["EVENT", subId, event]`。
3. 回 `["OK", <id>, true, ""]`。
4. **不儲存。** kind 在 ephemeral 區段，本來就不該存。

拒絕的話回 `["OK", <id>, false, "<原因>"]`。NIP-01 建議原因加前綴，
例如 `invalid: `、`blocked: `、`rate-limited: `。

### filter 比對

一則事件對上一個 filter 的條件是**三個都成立**：

```
event.kind ∈ filter.kinds
event.created_at + CLOCK_SKEW_S >= filter.since    （時鐘容忍；relay 沒有歷史，since 只剩「擋時鐘歪的活事件」這個副作用，放寬是純收益）
∃ tag ∈ event.tags 使得 tag[0] === "x" 且 tag[1] ∈ filter["#x"]
```

沒有其他欄位要支援（`authors`、`ids`、`until`、`limit`、`#e`、`#p` 全部用不到）。

### 要不要回送給發送者自己

**要。照公共 relay 的行為做。**

標準 Nostr relay 會把事件送給**所有**對得上的訂閱，包含發送者自己那條。
Trystero 現在跑在公共 relay 上是好的，所以那個行為就是它被驗證過的前提。

⚠️ 這裡跟 `ChatDO` 不一樣 —— 那支是 fan-out 跳過發送者。**不要照抄。**
改成跳過等於引入一個沒人測過的行為差異。

### 收到 REQ

1. 記下 `subId → filter`（掛在那條 socket 上）。
2. 因為什麼都不存，沒有歷史可送。
3. 可以直接回 `["EOSE", subId]`（守規矩，客戶端會忽略）。

同一個 subId 再送一次 REQ = 覆蓋原本的 filter。批次那段就是這樣運作的。

### 收到 CLOSE

刪掉那個 subId。找不到就靜靜忽略。

### 連線關掉

刪掉那條 socket 的所有訂閱。沒有別的要清。

---

## 4. 安全模型（這一節結論跟直覺相反）

### 驗簽章沒有意義

Trystero 在**模組載入時**產生一次性金鑰：

```js
const { secretKey, publicKey } = schnorr.keygen();
```

那是 module scope，每次開網頁就是一組新的。所以 `pubkey` **不是身分，是亂數**。

推論：

- **驗簽章擋不了任何人。** 攻擊者產一組新金鑰就好，成本是零。
- 白名單 pubkey 不可能，因為連合法使用者的 pubkey 都每次不一樣。
- 驗簽章唯一擋得住的是「改別人的封包再重送」，可是內容本來就是
  AES-GCM 加密過的 SDP，改了也沒用，而且 relay 本來就在信任邊界外。

所以 **secp256k1 的相依可以整個不要**。
（Workers 的 WebCrypto 沒有 secp256k1，只有 P-256/384/521，
要驗就得拉 `@noble/curves` 進來。這裡的結論是不必。）

**驗 `id` 倒是要驗** —— 那只要 SHA-256，WebCrypto 就有。它擋的不是攻擊，
是格式錯誤的客戶端。而且它是免費的。

### 真正該擋的

| 面向 | 手段 |
| --- | --- |
| 洗版 | 每條連線的 token bucket（`ChatDO` 已經有這套） |
| 大封包 | `JSON.parse` **之前**先擋長度 |
| 佔連線 | 同時連線數上限 |
| 訂閱爆量 | 每條連線的 subId 數上限、每個 filter 的主題數上限 |
| 認識的人才能用 | `#x` 主題白名單，或 appId 綁定（見第 8 節） |

---

## 5. 限制（要定的數字）

| 項目 | 建議 | 理由 |
| --- | --- | --- |
| 單則訊息大小 | 16384 個 UTF-16 code unit（CJK 最多約 48 KB） | SDP 約 2KB，8 倍餘裕。`string.length` 數的是 code unit 不是 byte。**要在 parse 之前擋** |
| 每條連線的訂閱數 | 20 | 250 主題一批，正常用一兩個就夠 |
| 單一 filter 的 `#x` 數 | 16 | 一個房間只送 2 個；250 是客戶端批次上限，不是需求（見 §6） |
| `kinds` 陣列長度 | 16 | 同上 |
| 事件速率 | 20/秒，突發 40 | 撮合是短暫爆量，不是持續流量 |
| 同時連線數 | 200 | 跟 `ChatDO` 同一個量級 |
| 每個 IP 的同時連線數 | 8 | 兩支手機同一個 NAT 也塞得下。沒有這條，200 條**閒置**連線就能讓所有真客戶端永遠吃 503，攻擊者零成本。socket 用 IP 當 tag |
| 整顆 DO 的事件速率 | 爆發 200，穩態 50/秒 | 每條 socket 的桶擋不了 200 條各自合規地灌；一則事件要對所有訂閱扇出，總量才是 DO 的成本。記憶體內，醒來重置 |
| `created_at` 容忍度 | ±15 分鐘 | 手機時鐘會歪。柴米帳自己也處理過時鐘漂移 |

---

## 6. 對到 Cloudflare 的實作

跟 `super-reversi2` 的 `ChatDO` 幾乎一對一。

| 需要的東西 | ChatDO 已經有的 |
| --- | --- |
| WebSocket + Hibernation | `ctx.acceptWebSocket` |
| 零儲存 | 那支檔案裡一個 `ctx.storage` 都沒有 |
| 限流 | `serializeAttachment` 上的 token bucket |
| 廣播 | `getWebSockets()` 迴圈 |
| parse 前擋大小 | `CHAT_MAX_FRAME` |

**要新寫的只有兩塊**：

1. NIP-01 的訊息框架（三種進、四種出）
2. 每條 socket 的訂閱表，比對 kind / since / `#x`

### 一個 Hibernation 的坑（讀完 core 原始碼之後降級了）

Hibernation 會把記憶體清掉，所以**訂閱狀態必須存進 `serializeAttachment`**，
跟 token bucket 一樣。那個欄位有大小上限：**16384 bytes（序列化後）**，2026-09-02 在 wrangler dev 實測，runtime 的錯誤訊息自己講的。一筆訂閱約 250 bytes，放得下 ~60 筆；下面的政策上限留了 3 倍餘裕。

原本擔心「一個 filter 帶 250 個主題塞不下」。讀完 `strategy.mjs` 之後這個擔心縮小了：
**一個房間只有兩個主題**（root + self），一筆訂閱記錄含 JSON 外殼約 200 bytes。
250 是 Trystero 客戶端的批次上限，柴米帳永遠不會靠近它。

所以這不再是架構問題，是**一條政策**：本 relay 把每個 filter 的 `#x` 上限訂為 16、
每條連線的訂閱數訂為 20。超過就回 `NOTICE` 拒收。真的有 app 需要 250 個主題再說，
那時候的選項是把訂閱表放進 DO 的 SQLite —— 但那會破「零儲存」的宣稱，要重新想怎麼講。

第一天仍然先做一個 `serializeAttachment` 的實測，只是它從「可能翻掉設計」變成「便宜的保險」。

---

## 7. 刻意不做

| 不做 | 為什麼 |
| --- | --- |
| 事件儲存 | kind 在 ephemeral 區段，規格說不該存 |
| 歷史查詢 | `since` 恆為 `now()`，永遠沒有歷史要查 |
| `authors` / `ids` / `until` / `limit` / `#e` / `#p` | 客戶端不送 |
| 一個 REQ 多個 filter | 客戶端只送一個 |
| 驗 schnorr 簽章 | 金鑰是每次隨機的，驗了擋不到任何人（第 4 節） |
| NIP-11 relay 資訊 | Trystero 不讀。想給人看的話再加，很便宜 |
| NIP-42 AUTH | 沒有穩定身分可以認 |
| NIP-13 工作量證明 | 這是防公共洗版用的，私有 relay 用不到 |
| 刪除、取代、過期 | 沒有東西被存下來 |

---

## 8. 要先決定的事

1. **只給自己用，還是開放？**
   只給自己 ⇒ 可以綁 `#x` 主題白名單或 Origin 檢查，安全問題幾乎消失。
   開放 ⇒ 洗版就變成主要問題，那是另一個專案。

2. **接哪些 app？**
   柴米帳一定接。super-reversi2 現在是自己的 Worker 撮合，**沒有理由搬過來**
   （它已經解決了，而且解得更好）。所以現階段就是柴米帳一個客戶。

3. **柴米帳那邊怎麼配？**
   建議**混進去，不是取代**：

   ```js
   relayConfig: { urls: ['wss://relay.arc.idv.tw', ...兩三個公共的] }
   ```

   一次拿到三件事：多一台自己控制的、公共的當備援、
   **順便修掉 BACKLOG 記的確定性洗牌地雷**（明寫 urls 之後，
   trystero 改版動到那 47 個的陣列長度就再也影響不到你）。

   混搭是安全的，有 core 原始碼背書：
   - `getRelays`：`relayConfig.urls || shuffle(...).slice(0, n)` —— `urls` 給了就**原樣全用**，
     不套 redundancy 的切片（`.slice` 綁在 shuffle 那一支上）。
   - `strategy.mjs:219`：每個 relay 在**自己的 async 回呼裡**各自 `await relayP`，
     **沒有 `Promise.all` 把整個房間卡在所有 relay 都連上**。自架那台掛了，
     它只是永遠不訂閱，公共的照走。
   - `makeSocket`：每條 socket 獨立重連，指數退避 3.3s → 60s；`send` 在未開啟時靜默丟。

   `RelayConfig` 的型別：`{ urls?: string[]; redundancy?: number;
   manualReconnection?: boolean; warnOnRelayFailure?: boolean }`。

4. **放哪個 repo？**
   新開一個，還是塞進柴米帳的 monorepo？
   塞進去的話會破壞「柴米帳沒有後端」這句話 —— 那句話是它 README 的核心宣稱，
   也是它開源的主要理由。**分開比較乾淨。**

5. **relay 掛掉怎麼辦？**
   混進公共 relay 就不是單點故障。可是要想清楚：
   遊戲撮合失敗只是這局重來，**帳本配對失敗是兩支手機再也對不上**。
   這兩者的容錯需求不一樣。

---

## 9. 規模感

新寫的程式碼估計：

```
NIP-01 訊息框架與驗證     ~120 行
訂閱表與 filter 比對       ~80 行
限流與大小閘（多半可搬）   ~60 行
DO 外殼（多半可搬）        ~80 行
測試（純函式那層）         ~200 行
```

**約 350 行新程式 + 200 行測試。**
純函式的部分（框架解析、filter 比對、限流）可以完全脫離 Cloudflare 測，
跟 `roomLogic.ts` / `chatLogic.ts` 同一個模式。

第 6 節那個 `serializeAttachment` 的實測已經做了：16384 bytes。沒有翻掉任何東西。
