# CLAUDE.md

NIP-01 子集的 WebSocket 廣播器，跑在 Cloudflare Durable Object 上，當 WebRTC 訊令用。
目前唯一的客戶端是 [柴米帳](https://github.com/arc119226/accounting)（雙人記帳 PWA）。
對外的說明在 [README.md](README.md)，貢獻規則在 [CONTRIBUTING.md](CONTRIBUTING.md)。

**開任何新 session 先照這個順序讀**：[README.md](README.md)（前因後果）→ [docs/plan.md](docs/plan.md)（做到哪、下一步）→ [docs/spec.md](docs/spec.md)（協定細節，動到 `src/` 才需要）。

## 目前狀態

**六個階段（0–5）全部完成，正式站在跑。** `wss://relay.arc.idv.tw` 上線於 2026-09-02，
真的 Trystero 兩端 `onPeerJoin` 對正式站過了；柴米帳已接上（PR #12，錨點 + 可遠端更新的
`public/relays.json`）。NIP-11 也做了。**82 個測試**（unit 65 + workerd 行為鎖 17）
+ 14 條 NIP-01 smoke + trystero-smoke 三個情境全綠。

2026-09-03 做過一次完工稽核（六面向 × 對抗式覆核），修掉的重點：

- 🐛 **全域連線閘沒有回收半開 socket**，滿了就永久鎖死（只有重新部署救得回來）。
  階段 4 在正式站量到的那個洩漏，當時只修了每 IP 那一半。
- 🐛 **`src/relay.ts` 從來沒有被任何測試執行過** —— 只有原始碼字串比對，而它守的是拼字不是行為。
  現在有 `test/relay.behaviour.test.ts`（workerd 真的跑起來）。
- 🐛 eslint 的 `fetch` 與 import 禁令各有一個一行就繞得過的後門；`HEAD /health` 回 405。

**下一步沒有「下一階段」了。** 真正待辦的是：兩支真手機掃 QR 同步一次（要人在場）、
以及把 GitHub repo 翻成公開（`package.json` 目前 `private: true`）。
維護時要注意的是柴米帳那份公共 relay 清單會腐敗 —— 換清單前先跑
柴米帳的 `node tools/probe-relays.mjs`（2026-09-03 實測：舊清單五台只有兩台活著）。

🔴 **改完一個階段要在同一個 commit 裡把 plan 標掉，而且把上面這段一起更新。**
這次就是漏了後半：階段 4、5 都標了 ✅，這段卻停在階段 3 整整兩個階段，
而第 7 行明寫新 session 要先讀這裡 —— 下一個 session 會照著去做一件已經做完的事。

## 鐵律

1. **零 `ctx.storage`。** 事件全在 ephemeral 區段，沒有東西該被存。`test/storageFree.test.ts` 用原始碼比對守著；動到 `src/relay.ts` 那支測試要一起過。
2. **`src/**` 禁 `fetch`、禁一切非 `cloudflare:workers` 的 import。** relay 不外呼任何第三方，這句話要是 diff 看得見的事實。eslint 擋——裸 `fetch`、`globalThis.fetch`、靜態 import、動態 `import()` 四種都擋。
3. **純函式葉檔（`nip01.ts` / `match.ts` / `limits.ts` / `nip11.ts`）禁 `Date.now` / `new Date()` / `Math.random` / `crypto.getRandomValues`。** 時間與隨機由 `relay.ts` 餵入，否則測試不可能決定論。eslint 擋。
   ⚠️ **新增葉檔請擴充 `eslint.config.js` 裡那個 `files` 陣列，不要另開 block。** flat config 同名規則**後蓋前、不是合併**，另開一塊會讓其中一邊靜默失效而 `pnpm lint` 照樣全綠。同理，葉檔同時吃得到 `src/**` 那個 block，所以共用的規則內容抽成陣列在兩處展開。
4. **fan-out 要回送給發送者自己。** 這跟 super-reversi2 的 `ChatDO` 相反，不要從那邊複製貼上。兩道鎖：`relay.behaviour.test.ts` 的 `IRON LAW 4` 真的開兩條 socket 斷言發送者收得到自己那則；`storageFree.test.ts` 再鎖形狀（`fanOut` 只准兩個參數、本體不得早退、只准一個 `if` 而且必須是 `matches`）。**不要用「禁止某個識別字」來守這條**——原本那句綁死 `peer === ws` 的正規式，改個參數名或把左右對調就繞過去了。
5. **不驗 schnorr 簽章，不拉 secp256k1 進來。** 理由在 spec §4。`id` 的 SHA-256 要驗。
6. **尺寸閘在 `JSON.parse` 之前。** 順序即契約，測試找的是判斷式的位置不是識別字。
7. **對抗式覆核與完工稽核補的閘不能退**：socket 以 `CF-Connecting-IP` 當 tag；**兩道**連線閘（全域與每 IP）都走 `reapAndCount` 回收半開 socket，而且 503 要排在全域回收**之後**（不然它自己擋掉唯一的自癒路徑）；DO 層總量桶在 await 之前結算；fan-out 只 `JSON.stringify` 事件一次；訂閱表 `Object.create(null)` + `Object.hasOwn`，永遠不用 `in`。`storageFree.test.ts` 最後一組 describe 鎖著這些，改 `relay.ts` 要一起過。

## 不做

公共 relay、事件儲存、NIP-42、分片、自訂協定、把 super-reversi2 搬過來。理由分在兩處：

- **協定層面**的（事件儲存、歷史查詢、`authors`/`ids`/`until`/`limit`、多 filter、
  驗 schnorr、NIP-42、NIP-13、刪除取代過期）在 [docs/spec.md](docs/spec.md) §7。
- **專案層面**的（公共 relay、多顆 DO / 分片、自訂協定、把 super-reversi2 搬過來、
  從 `ChatDO` 複製貼上）在 [docs/plan.md](docs/plan.md) §2。

NIP-11 **已經做了**（2026-09-03，見 spec §7.5）：`src/nip11.ts` 是純函式葉檔，
`limitation` 的數字一律 import 自 `limits.ts` —— **不得複寫字面量**，會說謊的能力宣告比沒有更糟。
（`min_pow_difficulty: 0` 是唯一的字面量，因為「不做 PoW」沒有對應的上限常數。）

## 指令

```bash
pnpm check          # lint → typecheck → test，commit 前跑這個
pnpm test           # 兩個 project：unit（node）+ workers（workerd 真的跑 RelayDO）
pnpm vitest run --project workers   # 只跑行為鎖，改 relay.ts 時最有用
pnpm dev            # wrangler dev，port 8787
pnpm deploy:check   # wrangler deploy --dry-run

# 對「跑起來的服務」的檢查（本機要先 pnpm dev；也可以直接打正式站）
node tools/smoke-nip01.mjs [wss://…]    # 14 條 NIP-01 即時檢查
node tools/check-nip11.mjs [https://…]  # NIP-11 的宣告有沒有跟 limits.ts 對上
# 真的 Trystero 兩端配對：tools/trystero-smoke/（打包與跑法見 plan 階段 3）
```

這三支**不在 CI 裡**，因為它們要一個跑起來的 relay。CI 跑得動的等價物已經有了：
`nip11.test.ts` 逐項斷言宣告等於常數、`relay.behaviour.test.ts` 在 workerd 裡跑真的協定往返。

⚠️ Windows 上 `wrangler dev` 收不乾淨會留孤兒、8787 上多個 listener、`/health` 回空。殺法見 plan 階段 3 最後那段。

## 參照

DO 骨架與機器鎖的原型來自作者的另一個專案 super-reversi2 的 `packages/signal/`；
客戶端那一側是 accounting 的 `sync/trystero.ts` 與 `sync/relays.ts`。
兩者都是公開 repo，但**本 repo 不相依於它們** —— 需要的東西都已經抄進來或寫在 docs/spec.md。
