/**
 * NIP-01 訊息框架 —— **純函式葉檔**,零 Cloudflare 依賴。
 *
 * 只認 Trystero 會送的三種:`["EVENT", event]`、`["REQ", subId, filter]`、`["CLOSE", subId]`。
 * 全部 no-throw:壞形狀回 `{ok:false, reason}`,一個壞客戶端不該影響整顆 DO。
 *
 * ## 不驗 `sig`(spec §4)
 * Trystero 的金鑰是 module scope 的 `schnorr.keygen()`,每次開網頁一組新的 ⇒ `pubkey` 不是身分,
 * 是亂數。驗簽章擋不到任何人(攻擊者產一組新的就好),而且 Workers 的 WebCrypto 沒有 secp256k1。
 * 這裡只驗 `sig` 的**形狀**(128 hex),不驗它對不對。
 *
 * ## 要驗 `id`
 * `id = SHA-256(JSON([0, pubkey, created_at, kind, tags, content]))`。那只要 WebCrypto,免費。
 * 它擋的不是攻擊,是格式錯誤的客戶端。`verifyEventId` 是本檔唯一的 async。
 * 序列化必須跟 Trystero 的 `createEvent` 一字不差 —— `test/nip01.test.ts` 用真的 Trystero
 * 產出的事件當 fixture 逐 byte 對。
 */
import { CLOCK_SKEW_S, KIND_MAX, KIND_MIN, MAX_TAGS_PER_EVENT, SUBID_MAX, TOPIC_MAX } from './limits';
import { normalizeFilter, type Filter } from './match';

export interface NostrEvent {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: ReadonlyArray<ReadonlyArray<string>>;
  readonly content: string;
  readonly sig: string;
}

export type ClientMsg =
  | { readonly t: 'event'; readonly event: NostrEvent }
  | { readonly t: 'req'; readonly subId: string; readonly filter: Filter }
  | { readonly t: 'close'; readonly subId: string };

export type ParseVerdict = { readonly ok: true; readonly msg: ClientMsg } | { readonly ok: false; readonly reason: string };

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

const bad = (reason: string): ParseVerdict => ({ ok: false, reason });
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
const isSubId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= SUBID_MAX;

/** tags:每個都是字串陣列;第一個元素是名字。長度與主題長度都有上限。 */
function parseTags(x: unknown): ReadonlyArray<ReadonlyArray<string>> | null {
  if (!Array.isArray(x) || x.length > MAX_TAGS_PER_EVENT) return null;
  const out: string[][] = [];
  for (const tag of x) {
    if (!Array.isArray(tag) || tag.length === 0) return null;
    if (!tag.every((v): v is string => typeof v === 'string' && v.length <= TOPIC_MAX)) return null;
    out.push([...tag]);
  }
  return out;
}

function parseEvent(x: unknown, now: number): NostrEvent | string {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return 'event-shape';
  const r = x as Record<string, unknown>;
  const id = r['id'];
  const pubkey = r['pubkey'];
  const sig = r['sig'];
  const kind = r['kind'];
  const created_at = r['created_at'];
  const content = r['content'];
  if (typeof id !== 'string' || !HEX64.test(id)) return 'id';
  if (typeof pubkey !== 'string' || !HEX64.test(pubkey)) return 'pubkey';
  if (typeof sig !== 'string' || !HEX128.test(sig)) return 'sig-shape';
  if (!isInt(kind) || kind < KIND_MIN || kind > KIND_MAX) return 'kind';
  if (!isInt(created_at) || Math.abs(created_at - now) > CLOCK_SKEW_S) return 'created_at';
  if (typeof content !== 'string') return 'content';
  const tags = parseTags(r['tags']);
  if (tags === null) return 'tags';
  return { id, pubkey, created_at, kind, tags, content, sig };
}

/**
 * 解析一則客戶端訊息。`now` 是伺服器的 unix 秒,用來夾 `created_at`。
 * 多於一個 filter 的 REQ 視為壞形狀(spec §7:客戶端只送一個;明講比靜默截斷安全)。
 */
export function parseClientMsg(raw: unknown, now: number): ParseVerdict {
  if (!Array.isArray(raw) || raw.length === 0) return bad('frame');
  const type = raw[0];
  if (type === 'EVENT') {
    if (raw.length !== 2) return bad('event-arity');
    const ev = parseEvent(raw[1], now);
    return typeof ev === 'string' ? bad(ev) : { ok: true, msg: { t: 'event', event: ev } };
  }
  if (type === 'REQ') {
    if (raw.length !== 3) return bad(raw.length > 3 ? 'multi-filter' : 'req-arity');
    if (!isSubId(raw[1])) return bad('subid');
    const filter = normalizeFilter(raw[2]);
    if (filter === null) return bad('filter');
    return { ok: true, msg: { t: 'req', subId: raw[1], filter } };
  }
  if (type === 'CLOSE') {
    if (raw.length !== 2) return bad('close-arity');
    if (!isSubId(raw[1])) return bad('subid');
    return { ok: true, msg: { t: 'close', subId: raw[1] } };
  }
  return bad('type');
}

/** NIP-01 的 id 序列化。**要跟 Trystero 的 `createEvent` 一字不差**(它用 `JSON.stringify`)。 */
export function serializeForId(e: Omit<NostrEvent, 'id' | 'sig'>): string {
  return JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
}

const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/** 算 id。本檔唯一的 async。 */
export async function eventId(e: Omit<NostrEvent, 'id' | 'sig'>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serializeForId(e)));
  return hex(digest);
}

/** 事件自帶的 `id` 是不是它內容的 SHA-256。 */
export async function verifyEventId(e: NostrEvent): Promise<boolean> {
  return (await eventId(e)) === e.id;
}

// ── 給殼層用的回應框架 ────────────────────────────────────────────────
export const okFrame = (id: string, ok: boolean, reason = ''): string => JSON.stringify(['OK', id, ok, reason]);
export const eoseFrame = (subId: string): string => JSON.stringify(['EOSE', subId]);
export const noticeFrame = (msg: string): string => JSON.stringify(['NOTICE', msg]);
/**
 * 事件框架。`eventJson` 是**已經序列化過**的事件 —— fan-out 對每個命中的訂閱各送一則,
 * 事件本身只該 stringify 一次(對抗式覆核抓到:4000 次重複 stringify 一則 64K 的事件要幾百 ms)。
 */
export const eventFrame = (subId: string, eventJson: string): string => `["EVENT",${JSON.stringify(subId)},${eventJson}]`;
