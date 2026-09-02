# 參與這個專案

先講清楚期待：**這是為了一個特定用途做的東西，不是通用的 Nostr relay。**
它的工作是幫兩支手機交換一段加密的 WebRTC 連線資訊，然後就散了。
任何變更的第一考量是「會不會讓兩支手機配不上對」。

要完整的 Nostr relay 的話，`strfry`、`nostr-rs-relay` 那些成熟得多，
而且它們真的存事件——這台不存，見下面。

## 很歡迎的

- **協定上的不相容回報**：某個 Nostr 客戶端接上來行為不對，附上它送的訊框
  與收到的回應（`docs/spec.md` §1、§2 有完整的訊框對照表）
- **資源耗盡的路徑**：單一 Durable Object 是單執行緒的，扇出是
  O(socket × 訂閱)，這一類的洞我特別想知道。走
  [SECURITY.md](SECURITY.md) 的私密回報，不要開公開 issue
- **平台行為的修正**：Cloudflare 的 Hibernation / `serializeAttachment` /
  `getWebSockets(tag)` 上，文件沒寫清楚而我猜錯的地方。
  這類回報請附**怎麼量的**——`src/limits.ts` 裡每個數字都是實測來的，
  新的數字也該是
- 文件的錯字、講不通的地方、過期的說明
- 已回報問題的修正 PR

## 原則上不收的功能請求

`docs/spec.md` §7（協定層面）與 `docs/plan.md` §2（專案層面）合起來才是完整清單與理由。
下面這些**不是還沒排到，是已經被否決**：

| 不做 | 為什麼 |
| --- | --- |
| 事件儲存、歷史查詢 | 事件全在 ephemeral 區段（kind 20000–29999），NIP-01 明說 relay 不該存；客戶端的 `since` 永遠是 `now()`，沒有歷史可查。而且**零儲存是這件事便宜的原因**：一旦要存，保留策略、備份、垃圾訊息就全部跟著來，那是另一個專案 |
| 驗 schnorr 簽章 | 客戶端金鑰每次開網頁隨機產生，`pubkey` 是亂數不是身分——驗了擋不到任何人。詳見 spec §4 與 SECURITY.md |
| `authors` / `ids` / `until` / `limit` / `#e` / `#p` 等 filter 欄位 | 目標客戶端不送。多送的欄位**靜默忽略**（不當錯誤），所以支援它們是加碼不是修 bug |
| 一個 REQ 帶多個 filter | 同上。明講拒收比靜默截斷安全 |
| NIP-42 AUTH | 沒有穩定身分可以認 |
| NIP-13 工作量證明 | 那是公共 relay 防洗版用的，這台不對外招攬 |
| 分片、多 DO | 一個客戶端、一個月幾次配對。先做單例 |

如果你覺得某條否決是錯的，那是值得聊的話題，但請當成**討論那條理由**來開，
不要當成功能請求來開。

## 送 PR 之前

```bash
pnpm check          # lint → typecheck → test，三個都必須綠
```

CI 會跑同一組加上 `wrangler deploy --dry-run`。

另外幾條會讓 PR 被退回的硬規則（完整版在 `CLAUDE.md`）：

- **`src/**` 零第三方 import、禁 `fetch`／`window`／`document`。**
  ESLint 機器強制。那條規則的目的不是精簡，是讓「這台 relay 不外呼任何第三方」
  成為 diff 看得見的事實
- **純函式葉檔（`nip01.ts` / `match.ts` / `limits.ts` / `nip11.ts`）禁 `Date.now`、`new Date()`、`Math.random`、`crypto.getRandomValues`。**
  時間與隨機一律由 `relay.ts` 殼層以參數餵入，否則測試不可能決定論
- **`relay.ts` 零 `ctx.storage`。** `test/storageFree.test.ts` 用原始碼比對守著
- **順序即契約**：訊框大小閘要在 `JSON.parse` **之前**、令牌桶要在
  `parseClientMsg` **之前**。這兩條也是原始碼比對鎖著的——
  只差幾行位置、跑起來完全正常，只有順序鎖擋得住
- **扇出必須包含發送者自己。** 這跟一般「廣播跳過發話者」的直覺相反，
  而且測試斷言原始碼裡**沒有** `peer === ws` 這種判斷
- 註解寫「為什麼」不是「做了什麼」，繁體中文

## 數字要有出處

`src/limits.ts` 裡每個常數上面都有一段註解說它是怎麼來的——
`serializeAttachment` 的 16384 是二分實測出來的，每 IP 8 條是對抗式覆核之後
定的、而且在正式站量到過它一度只有 6（半開連線佔住）。

改動任何一個數字，請一併說明新的數字是怎麼得到的。**「感覺比較合理」不算。**
