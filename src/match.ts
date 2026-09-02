/**
 * filter 比對 —— **純函式葉檔**,零 Cloudflare 依賴。
 *
 * 只支援 Trystero 會送的三個欄位:`kinds`、`since`、`#x`。其他 NIP-01 欄位
 * (`authors` / `ids` / `until` / `limit` / `#e` / `#p`)**靜默丟掉**,不當錯誤:
 * 未來換一個會多送欄位的客戶端,relay 還是能用,只是那些條件不生效。
 */
import { CLOCK_SKEW_S, KIND_MAX, KIND_MIN, MAX_KINDS_PER_FILTER, MAX_TOPICS_PER_FILTER, TOPIC_MAX } from './limits';

/** 正規化後的 filter。`since` 缺席 = 0(NIP-01 語意:不限)。 */
export interface Filter {
  readonly kinds: readonly number[];
  readonly since: number;
  readonly topics: readonly string[];
}

/** 比對只需要事件的這三個面向 */
export interface Matchable {
  readonly kind: number;
  readonly created_at: number;
  readonly tags: ReadonlyArray<ReadonlyArray<string>>;
}

const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
const isKind = (x: unknown): x is number => isInt(x) && x >= KIND_MIN && x <= KIND_MAX;
const isTopic = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= TOPIC_MAX;

/**
 * 「這是不是一個我們自己寫出去的 Filter」—— 給殼層從 attachment 讀回訂閱表時用。
 * attachment 是我們自己寫的,可是 hibernation 之間格式可能改版、或被舊版寫過,
 * 讀回來不驗形狀就直接 `matches()` 會在 `.includes` 上炸。
 */
export function isFilter(x: unknown): x is Filter {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const r = x as Record<string, unknown>;
  const kinds = r['kinds'];
  const topics = r['topics'];
  const since = r['since'];
  return Array.isArray(kinds) && kinds.every(isKind) && Array.isArray(topics) && topics.every(isTopic) && isInt(since) && since >= 0;
}

/**
 * 驗形 + 正規化。壞形狀回 null(no-throw)。
 * - `kinds`:非空、全在 ephemeral 區段、長度 ≤ MAX_KINDS_PER_FILTER
 * - `#x`:非空、全是合法主題、長度 ≤ MAX_TOPICS_PER_FILTER
 * - `since`:缺席=0;給了就得是非負整數
 * 空的 `kinds` 或 `#x` 視為壞形狀:那種 filter 什麼都對不上,存著只是佔 attachment 預算。
 */
export function normalizeFilter(raw: unknown): Filter | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const kinds = r['kinds'];
  if (!Array.isArray(kinds) || kinds.length === 0 || kinds.length > MAX_KINDS_PER_FILTER) return null;
  if (!kinds.every(isKind)) return null;

  const topics = r['#x'];
  if (!Array.isArray(topics) || topics.length === 0 || topics.length > MAX_TOPICS_PER_FILTER) return null;
  if (!topics.every(isTopic)) return null;

  const sinceRaw = r['since'];
  let since = 0;
  if (sinceRaw !== undefined) {
    if (!isInt(sinceRaw) || sinceRaw < 0) return null;
    since = sinceRaw;
  }

  return { kinds: [...new Set(kinds)], since, topics: [...new Set(topics)] };
}

/**
 * 三個條件全成立才 true(spec §3)。
 *
 * `since` 那條放了 CLOCK_SKEW_S 的容忍。Trystero 的 `since` 是**訂閱那支手機**的 `now()`,
 * `created_at` 是**發送那支手機**的 `now()`;發送方時鐘慢了 δ 秒,它的每一則都會被嚴格的
 * `since` 擋到 δ 秒之後 —— 配對就晚 δ 秒才成。這個 relay 什麼都不存,`since` 對它本來就
 * 沒有「過濾歷史」的意義,只剩「擋掉時鐘歪的活事件」這個副作用,所以放寬是純收益。
 */
export function matches(event: Matchable, filter: Filter): boolean {
  if (!filter.kinds.includes(event.kind)) return false;
  if (event.created_at + CLOCK_SKEW_S < filter.since) return false;
  for (const tag of event.tags) {
    if (tag[0] === 'x' && tag[1] !== undefined && filter.topics.includes(tag[1])) return true;
  }
  return false;
}
