# CLAUDE.md

NIP-01 子集的 WebSocket 廣播器，跑在 Cloudflare Durable Object 上，給柴米帳當 WebRTC 訊令。

**開任何新 session 先照這個順序讀**：[README.md](README.md)（前因後果）→ [docs/plan.md](docs/plan.md)（做到哪、下一步）→ [docs/spec.md](docs/spec.md)（協定細節，動到 `src/` 才需要）。

## 目前狀態

階段 0–2 完成：骨架、`serializeAttachment` 上限 = 16384、純函式層、**正式的 RelayDO**，40 個測試 + 14 條即時 smoke 全綠。**下一步是 plan 的階段 3**：用真的 `trystero/nostr` 指向 `ws://localhost:8787`，兩個客戶端 `onPeerJoin` 要觸發 —— 那是整個專案的驗收。
plan 每一階段結束都有一個「證明」動作，做完就在 plan 裡把那一階段標掉。

## 鐵律

1. **零 `ctx.storage`。** 事件全在 ephemeral 區段，沒有東西該被存。`test/storageFree.test.ts` 用原始碼比對守著；動到 `src/relay.ts` 那支測試要一起過。
2. **`src/**` 禁 `fetch`、禁一切非 `cloudflare:workers` 的 import。** relay 不外呼任何第三方，這句話要是 diff 看得見的事實。eslint 擋。
3. **純函式葉檔（`nip01.ts` / `match.ts` / `limits.ts`）禁 `Date.now` / `Math.random`。** 時間與隨機由 `relay.ts` 餵入，否則測試不可能決定論。eslint 擋。
4. **fan-out 要回送給發送者自己。** 這跟 super-reversi2 的 `ChatDO` 相反。不要從那邊複製貼上，`chatStorageFree.test` 有一條 `peer === ws` 的斷言會反過來逼你留著錯的行為。
5. **不驗 schnorr 簽章，不拉 secp256k1 進來。** 理由在 spec §4。`id` 的 SHA-256 要驗。
6. **尺寸閘在 `JSON.parse` 之前。** 順序即契約，測試找的是判斷式的位置不是識別字。
7. **對抗式覆核補的四道閘不能退**：socket 以 `CF-Connecting-IP` 當 tag、每 IP 上限；DO 層總量桶在 await 之前結算；fan-out 只 `JSON.stringify` 事件一次；訂閱表 `Object.create(null)` + `Object.hasOwn`，永遠不用 `in`。`storageFree.test.ts` 最後一組 describe 鎖著這四條，改 `relay.ts` 要一起過。

## 不做

公共 relay、事件儲存、NIP-11、NIP-42、分片、自訂協定、把 super-reversi2 搬過來。清單跟理由在 plan §2。

## 指令

```bash
pnpm check          # lint → typecheck → test，commit 前跑這個
pnpm dev            # wrangler dev，port 8787
pnpm deploy:check   # wrangler deploy --dry-run
node tools/smoke-nip01.mjs   # 對跑著的 relay 做 14 條 NIP-01 即時檢查（先 pnpm dev）
```

## 參照

super-reversi2 的 `packages/signal/`（DO 骨架與機器鎖）、accounting 的 `sync/trystero.ts`（客戶端）。路徑與要抄哪幾段在 README。
