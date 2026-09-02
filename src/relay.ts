/**
 * RelayDO —— NIP-01 子集的廣播器,**單例**(`idFromName('relay')`),零儲存。
 *
 * ## 為什麼全檔零 `ctx.storage`(本檔最重要的一件事)
 * 事件全在 ephemeral 區段(kind 20000–29999),規格明說 relay 不該存;客戶端的 `since`
 * 永遠是 `now()`,沒有歷史要查。「什麼都不存」不是伺服器自律不給,是**根本沒有東西可以給**。
 * `test/storageFree.test.ts` 以原始碼比對守著這條。
 *
 * ## 紀律(照抄 super-reversi2 的 ChatDO,但 fan-out 那段**反過來**)
 * - 裁決全在純函式(`nip01` / `match` / `limits`);本檔只做 I/O + 時間。
 * - 訂閱表與令牌桶都隨 socket 走(`serializeAttachment`):hibernation 會清記憶體,
 *   任何 in-memory 狀態醒來都歸零。上限 16384 bytes(實測,見 limits.ts)。
 * - **fan-out 包含發送者自己。** 標準 Nostr relay 就是這樣,Trystero 跑在公共 relay 上
 *   是好的,那個行為是它被驗證過的前提。ChatDO 跳過自己是因為它的客戶端本地上屏;
 *   這裡不是。storageFree.test 斷言本檔**沒有** `peer === ws` 這種判斷。
 * - 尺寸閘在 `JSON.parse` **之前**;令牌桶在 `parseClientMsg` **之前**(每一則解析得動的
 *   訊框都扣一顆,壞形狀的 NOTICE 才不會變成免費的回應通道)。
 * - 本檔**唯一的 await** 是 `verifyEventId`。桶要在那之前就結算並寫回:DO 的 input gate
 *   只擋 storage 操作,`crypto.subtle` 的 await 期間同一條 socket 的下一則訊息可能進來,
 *   桶已經寫回就不會被重複扣或重複給。
 *
 * ## 對抗式覆核之後補的三道閘(2026-09-02)
 * - **每個 IP 的連線上限**(socket 以 IP 當 tag,tag 撐得過 hibernation)。沒有它,
 *   200 條閒置連線就能讓所有真正的客戶端永遠吃 503,而攻擊者一毛錢都不用花。
 * - **DO 層的總量桶**(記憶體內)。每條 socket 的桶擋不了 200 條 socket 各自合規地灌;
 *   一則接受的事件要對每條 socket 的每個訂閱扇出,總量才是 DO 的成本。
 * - **事件只 stringify 一次**,每個訂閱只拼上 subId。4000 次重複序列化一則事件要幾百 ms。
 * - 訂閱表用 `Object.create(null)` + `Object.hasOwn`:subId 叫 `toString` 的話,`in` 會走
 *   原型鏈說它已存在而跳過上限;叫 `__proto__` 的話,`s[subId] = f` 會把整張表的原型換掉。
 *
 * ## 回應
 *   EVENT 收下      → 對每條 socket 的每個訂閱比對,命中就 ["EVENT", subId, event];最後 ["OK", id, true, ""]
 *   EVENT id 對不上 → ["OK", id, false, "invalid: ..."]
 *   REQ            → 存訂閱,回 ["EOSE", subId](沒有歷史,立刻 EOSE;Trystero 不看它,守規矩而已)
 *   CLOSE          → 刪訂閱,不回
 *   被限流         → 帶 id 的 EVENT 回 ["OK", id, false, "rate-limited: ..."],其他靜默
 *   壞形狀         → ["NOTICE", "invalid: <reason>"]
 *   訂閱過量/表滿   → ["NOTICE", "blocked: ..."]
 */
import {
  DO_EVENT_CAP,
  DO_EVENT_REFILL_MS,
  MAX_FRAME,
  MAX_SOCKETS,
  MAX_SOCKETS_PER_IP,
  MAX_SUBS_PER_SOCKET,
  WS_OPEN,
  bucketOf,
  fullBucket,
  isStale,
  takeToken,
  type Bucket,
} from './limits';
import { isFilter, matches, type Filter } from './match';
import { eoseFrame, eventFrame, noticeFrame, okFrame, parseClientMsg, verifyEventId, type NostrEvent } from './nip01';

/** 訂閱表。**一律 `Object.create(null)`**:普通物件會讓 `__proto__` / `toString` 這種 subId 走進原型鏈。 */
type SubTable = Record<string, Filter>;
const emptyTable = (): SubTable => Object.create(null) as SubTable;

/** 隨 socket 走的狀態。鍵名刻意短:這東西要塞進 16 KB 的 attachment。 */
interface Attachment {
  readonly b: Bucket;
  readonly s: SubTable;
}

/** 反序列化容錯:壞值/缺席 = 滿桶、零訂閱(限流與訂閱都不該因為壞資料而失效或誤擋)。 */
function readAttachment(ws: WebSocket, nowMs: number): Attachment {
  let raw: unknown = null;
  try {
    raw = ws.deserializeAttachment();
  } catch {
    raw = null;
  }
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const s = emptyTable();
  const rs = r['s'];
  if (rs && typeof rs === 'object' && !Array.isArray(rs)) {
    for (const [subId, f] of Object.entries(rs as Record<string, unknown>)) {
      if (isFilter(f)) s[subId] = f;
    }
  }
  return { b: bucketOf(r['b'], nowMs), s };
}

/** 寫回。超過 ATTACHMENT_MAX_BYTES 會 throw ⇒ 回 false,由呼叫端決定怎麼講。 */
function writeAttachment(ws: WebSocket, a: Attachment): boolean {
  try {
    ws.serializeAttachment(a);
    return true;
  } catch {
    return false;
  }
}

/** 送出是 best-effort:對端收攤中不該讓其餘人收不到。 */
function send(ws: WebSocket, frame: string): void {
  try {
    ws.send(frame);
  } catch {
    // 對端已關
  }
}

/** 被限流時偷看一眼:是帶 id 的 EVENT 就用 OK 講清楚(NIP-01 的 rate-limited 前綴),其他靜默。 */
function idOfRawEvent(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw[0] !== 'EVENT') return null;
  const ev = raw[1];
  if (!ev || typeof ev !== 'object') return null;
  const id = (ev as Record<string, unknown>)['id'];
  return typeof id === 'string' ? id : null;
}

/** 複製一張表,可選擇改一格或刪一格。結果永遠是 null 原型。 */
function withSub(subs: SubTable, subId: string, filter: Filter | null): SubTable {
  const next = emptyTable();
  for (const [k, v] of Object.entries(subs)) {
    if (k !== subId) next[k] = v;
  }
  if (filter !== null) next[subId] = filter;
  return next;
}

export class RelayDO {
  private readonly ctx: DurableObjectState;
  /**
   * 整顆 DO 的事件桶。記憶體內 —— hibernation 醒來重置成滿桶,對限流器沒關係,
   * 對「零儲存」也沒關係(它不是資料,是節流閥)。
   */
  private relayBucket: Bucket | null = null;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
    // 刻意沒有 blockConcurrencyWhile 回讀:本 DO 無持久狀態(見檔頭)
  }

  /**
   * 這批 socket 現在有幾條**活著**的;順手把死的收掉。
   *
   * 半開的 socket 不會觸發 `webSocketClose`,可是 `getWebSockets()` 數得到 ——
   * 不濾掉的話那些格子是單向洩漏的(正式站實測過,見 limits.ts 的 IDLE_REAP_MS)。
   * **兩道閘餵同一支函式**:每 IP 餵 `getWebSockets(ip)`,全域餵 `getWebSockets()`。
   * 早先只有每 IP 那條走這裡、全域那條只看 readyState ⇒ 同一個洩漏在全域仍然成立
   * (見 fetch 裡的註解)。只在連線進來時跑,成本是有界的。
   */
  private reapAndCount(sockets: WebSocket[], nowMs: number): number {
    let live = 0;
    for (const ws of sockets) {
      if (ws.readyState !== WS_OPEN) continue; // 關閉中/已關,不算也不用收
      if (isStale(readAttachment(ws, nowMs).b.at, nowMs)) {
        try {
          ws.close(1001, 'idle'); // 順手收掉。close 不是同步生效,所以**這一條本來就不計數**
        } catch {
          // 已經在關了
        }
        continue;
      }
      live++;
    }
    return live;
  }

  fetch(req: Request): Response {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const nowMs = Date.now();
    // 濫用上限(不是產品上限):滿了就拒新連線,既有連線不受影響。
    // 便宜的那一關先跑:只看 readyState,沒到頂就不必逐條反序列化 attachment(可能有 200 條)。
    if (this.ctx.getWebSockets().filter((w) => w.readyState === WS_OPEN).length >= MAX_SOCKETS) {
      // 到頂了才掃。半開的 socket readyState **也是 OPEN 而且不會自己消失** ——
      // 少了這一掃,累積到 MAX_SOCKETS 之後這條 503 就把所有人永久鎖在門外,
      // 而且它排在每 IP 那條之前,連「回來的 IP 順手清一清」這條自癒路徑都被自己擋掉,
      // 只有重新部署救得回來。每 IP 那條先前就是這樣漏的,正式站實測到(limits.ts 的 IDLE_REAP_MS)。
      // 掃描成本有界:只在已經到頂時才發生。
      if (this.reapAndCount(this.ctx.getWebSockets(), nowMs) >= MAX_SOCKETS) {
        return new Response('relay full', { status: 503 });
      }
    }
    // 每個 IP 的上限。wrangler dev 沒有這個標頭,本地全部落在 'unknown' 同一桶,測試開 3 條夠用。
    const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (this.reapAndCount(this.ctx.getWebSockets(ip), nowMs) >= MAX_SOCKETS_PER_IP) {
      return new Response('too many connections from this address', { status: 429 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Hibernation API:交給 runtime 保管,閒置時本 DO 可被逐出記憶體(不計 duration)。
    // IP 當 tag:tag 撐得過 hibernation,上面那個 getWebSockets(ip) 才數得到。
    this.ctx.acceptWebSocket(server, [ip]);
    // 進門給滿桶:第一則 REQ 不該被靜默丟掉,那是使用者最不可能理解的失敗
    server.serializeAttachment({ b: fullBucket(nowMs), s: emptyTable() } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return; // 二進位不是這條協定的東西,靜默丟
    // 尺寸閘在 parse 之前:沒有這道閘,一個壞客戶端可以拿 32 MiB 反覆逼 DO 解析而不花令牌
    if (message.length > MAX_FRAME) return;
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      return; // 壞 JSON 靜默丟
    }

    const nowMs = Date.now();
    const att = readAttachment(ws, nowMs);
    const gate = takeToken(att.b, nowMs);
    const subs = att.s;

    if (!gate.ok) {
      writeAttachment(ws, { b: gate.next, s: subs }); // 被擋也要寫回=被擋的人要被計時
      const id = idOfRawEvent(raw);
      if (id !== null) send(ws, okFrame(id, false, 'rate-limited: slow down'));
      return;
    }

    const verdict = parseClientMsg(raw, Math.floor(nowMs / 1000));
    if (!verdict.ok) {
      writeAttachment(ws, { b: gate.next, s: subs });
      send(ws, noticeFrame(`invalid: ${verdict.reason}`));
      return;
    }
    const msg = verdict.msg;

    if (msg.t === 'req') {
      // 同一個 subId 再送 = 覆蓋(Trystero 的批次就是這樣運作);上限算在合併**之後**
      const next = withSub(subs, msg.subId, msg.filter);
      if (!Object.hasOwn(subs, msg.subId) && Object.keys(next).length > MAX_SUBS_PER_SOCKET) {
        writeAttachment(ws, { b: gate.next, s: subs });
        send(ws, noticeFrame('blocked: too many subscriptions'));
        return;
      }
      if (!writeAttachment(ws, { b: gate.next, s: next })) {
        writeAttachment(ws, { b: gate.next, s: subs }); // 退回原本的表,至少桶要寫回
        send(ws, noticeFrame('blocked: subscription table full'));
        return;
      }
      send(ws, eoseFrame(msg.subId)); // 沒有歷史,立刻 EOSE
      return;
    }

    if (msg.t === 'close') {
      writeAttachment(ws, { b: gate.next, s: withSub(subs, msg.subId, null) });
      return;
    }

    // EVENT。先過 DO 層的總量桶(同步),桶都寫回之後才做本檔唯一的 await(理由見檔頭)。
    const event = msg.event;
    const relayGate = takeToken(this.relayBucket ?? fullBucket(nowMs, DO_EVENT_CAP), nowMs, DO_EVENT_CAP, DO_EVENT_REFILL_MS);
    this.relayBucket = relayGate.next;
    writeAttachment(ws, { b: gate.next, s: subs });
    if (!relayGate.ok) {
      send(ws, okFrame(event.id, false, 'rate-limited: relay busy'));
      return;
    }
    if (!(await verifyEventId(event))) {
      send(ws, okFrame(event.id, false, 'invalid: id does not match content'));
      return;
    }
    this.fanOut(event, nowMs);
    send(ws, okFrame(event.id, true));
  }

  /**
   * 對每條 socket 的每個訂閱比對;**包含發送者自己**(spec §3)。一個訂閱命中就送一則。
   * 事件只序列化一次,每則只拼上 subId。
   */
  private fanOut(event: NostrEvent, nowMs: number): void {
    const json = JSON.stringify(event);
    for (const peer of this.ctx.getWebSockets()) {
      const { s } = readAttachment(peer, nowMs);
      for (const [subId, f] of Object.entries(s)) {
        if (matches(event, f)) send(peer, eventFrame(subId, json));
      }
    }
  }

  webSocketClose(ws: WebSocket): void {
    try {
      ws.close(1000, 'bye');
    } catch {
      // 已經關了
    }
  }

  webSocketError(ws: WebSocket): void {
    try {
      ws.close(1011, 'error');
    } catch {
      // 已經關了
    }
  }
}
