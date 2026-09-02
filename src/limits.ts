/**
 * 常數與限流 —— **純函式葉檔**,零 Cloudflare 依賴,plain vitest 直測。
 * 時間一律由殼層以 `now` 參數餵入(eslint 禁 `Date.now` / `Math.random`)。
 *
 * token bucket 那段從 super-reversi2 `packages/signal/src/chatLogic.ts` 搬過來,
 * 數字換成 spec §5。搬的理由:那套已經在線上跑過、而且「拒絕也要寫回」這條
 * 不直覺的細節它已經踩過了。
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

/**
 * 單一訊框上限,單位是 **UTF-16 code unit**(`string.length`),不是 byte —— CJK 一個字最多 3 bytes,
 * 所以線上的實際上限約 48 KB。**在 `JSON.parse` 之前擋**(順序即契約,storageFree.test 鎖著)。
 * 限流是解析之後才判的,沒有這道閘,一個壞客戶端可以拿平台允許的 32 MiB 反覆逼 DO
 * 做大型 JSON 解析而不花任何令牌。合法訊框:SDP 約 2 KB,16K 是 8 倍的餘裕。
 * (對抗式覆核抓到原本的 64K 讓一則事件的扇出可以吃到 ~192 KB × 4000 次,才收緊的。)
 */
export const MAX_FRAME = 16_384;

/** 每條連線最多幾個開啟中的訂閱(subId)。Trystero 一個房間開 1 個,批次最多幾個。 */
export const MAX_SUBS_PER_SOCKET = 20;
/** 單一 filter 的 `#x` 主題數上限。一個房間只送 2 個(root + self);250 是客戶端批次上限,不是需求。 */
export const MAX_TOPICS_PER_FILTER = 16;
/** 單一 filter 的 `kinds` 長度上限。跟 `#x` 同一個理由。 */
export const MAX_KINDS_PER_FILTER = 16;
/** 同時連線上限(濫用上限不是產品上限;超過即拒新連線,既有的不受影響) */
export const MAX_SOCKETS = 200;
/**
 * 每個來源 IP 的同時連線上限。兩支手機在同一個 NAT 後面也塞得下。
 * 沒有這條的話,200 條**閒置**連線(零訊息、零令牌、hibernate 起來連 DO 都不用錢)就能讓
 * 之後每一個真正的客戶端永遠吃 503 —— 免費的鎖死。socket 用 IP 當 tag,tag 撐得過 hibernation。
 */
export const MAX_SOCKETS_PER_IP = 8;
/** `created_at` 相對於伺服器時間的容忍(秒)。手機時鐘會歪;柴米帳自己也處理過時鐘漂移。 */
export const CLOCK_SKEW_S = 15 * 60;

/** 每條 socket 的令牌桶:容量 40、每 50ms 回一顆 ⇒ 穩態 20 則/s、可爆發 40 則。撮合是短暫爆量不是持續流量。 */
export const BUCKET_CAP = 40;
export const BUCKET_REFILL_MS = 50;
/**
 * 整顆 DO 的事件桶(記憶體內;hibernation 醒來重置成滿桶,對限流器來說沒關係)。
 * 每條 socket 的桶只擋單一客戶端,擋不了 200 條 socket **各自合規地**灌 —— 一則接受的事件
 * 要對每條 socket 的每個訂閱扇出,總量才是 DO 真正的成本。這顆擋總量:爆發 200、穩態 50/s。
 */
export const DO_EVENT_CAP = 200;
export const DO_EVENT_REFILL_MS = 20;

/** 令牌桶狀態(隨 socket 走;`at`=上次結算時刻) */
export interface Bucket {
  readonly tokens: number;
  readonly at: number;
}

export const fullBucket = (now: number, cap: number = BUCKET_CAP): Bucket => ({ tokens: cap, at: now });

/**
 * 取一顆令牌:先按經過時間回補(夾在容量),再決定准不准。
 * 回傳恆帶新桶 —— **拒絕時也要寫回**,否則被擋的人不會被計時、下一則又立刻重試。
 * `cap` / `refillMs` 預設是每條 socket 的桶;DO 層的總量桶把自己的數字傳進來。
 */
export function takeToken(
  bucket: Bucket,
  now: number,
  cap: number = BUCKET_CAP,
  refillMs: number = BUCKET_REFILL_MS,
): { readonly ok: boolean; readonly next: Bucket } {
  const elapsed = Math.max(0, now - bucket.at);
  const refilled = Math.min(cap, bucket.tokens + elapsed / refillMs);
  if (refilled < 1) return { ok: false, next: { tokens: refilled, at: now } };
  return { ok: true, next: { tokens: refilled - 1, at: now } };
}

/** attachment 反序列化容錯:壞值/缺席=給一個滿桶(限流不該因為壞資料而失效或誤擋) */
export function bucketOf(x: unknown, now: number): Bucket {
  if (!x || typeof x !== 'object') return fullBucket(now);
  const r = x as Record<string, unknown>;
  const tokens = r['tokens'];
  const at = r['at'];
  if (typeof tokens !== 'number' || typeof at !== 'number' || !Number.isFinite(tokens) || !Number.isFinite(at)) {
    return fullBucket(now);
  }
  return { tokens: Math.min(BUCKET_CAP, Math.max(0, tokens)), at };
}

/** NIP-01 的 ephemeral 區段。Trystero 的 `topicToKind` = `strToNum(topic, 1e4) + 2e4` ⇒ 恆落在這裡。 */
export const KIND_MIN = 20_000;
export const KIND_MAX = 29_999;
/** subId:Trystero 用 `genId(64)`。 */
export const SUBID_MAX = 64;
/** 主題字串:Trystero 是 SHA-1 逐 byte 轉 base36,實際 30–40 字元;128 是很鬆的上限。 */
export const TOPIC_MAX = 128;
/** 一則事件的 tags 數。Trystero 恆送 1 個(`["x", topic]`)。 */
export const MAX_TAGS_PER_EVENT = 16;
