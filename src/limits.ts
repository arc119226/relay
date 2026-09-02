/**
 * 常數與限流 —— **純函式葉檔**,零 Cloudflare 依賴。時間由殼層以 `now` 參數餵入。
 * (token bucket 在 plan 階段 1 從 super-reversi2 的 chatLogic.ts 搬過來;本檔目前只有常數。)
 */

/**
 * `ws.serializeAttachment()` 的硬上限:**16384 bytes**(序列化後)。
 *
 * 實測(2026-09-02,wrangler 4.127.1 / workerd 本地):
 *   8192 bytes 的字串 → 寫得進去
 *   16380 字元的字串 → 拒收,runtime 自己說:
 *     "A WebSocket 'attachment' cannot be larger than 16384 bytes. 'attachment' was 16385 bytes."
 *   ⇒ 結構化複製一個 ASCII 字串多 5 bytes 的表頭;16379 字元是最後一個塞得進的。
 *
 * 訂閱狀態必須住在 attachment 裡(hibernation 會清記憶體,見 plan §3),所以這個數字
 * 就是每條連線能記住多少訂閱的預算。一筆訂閱(subId 64 字元 + 2 個 topic + kinds + since)
 * 含 JSON 外殼約 250 bytes ⇒ 16 KB 放得下 ~60 筆。下面的政策上限刻意留了 3 倍的餘裕。
 */
export const ATTACHMENT_MAX_BYTES = 16_384;

/** 每條連線最多幾個開啟中的訂閱(subId)。Trystero 一個房間開 1 個,批次最多幾個。 */
export const MAX_SUBS_PER_SOCKET = 20;
/** 單一 filter 的 `#x` 主題數上限。一個房間只送 2 個(root + self);250 是客戶端批次上限,不是需求。 */
export const MAX_TOPICS_PER_FILTER = 16;
/** 單一 filter 的 `kinds` 長度上限。跟 `#x` 同一個理由。 */
export const MAX_KINDS_PER_FILTER = 16;
