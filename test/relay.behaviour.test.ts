/**
 * 行為鎖 —— **真的把 Worker 與 RelayDO 跑起來**(workerd),斷言它做了什麼,
 * 而不是斷言原始碼長什麼樣。
 *
 * 為什麼要有這支:完工稽核發現 `src/relay.ts` 從來沒有被任何測試執行過 ——
 * 64 個測試對它只做原始碼字串比對,而字串比對守的是**拼字不是行為**。
 * 稽核當場示範了兩種「改一行就把 fan-out 改成跳過發送者、而 `pnpm check` 全綠」的寫法。
 * `storageFree.test.ts` 留著當第二道防線(它守的是「不准長出某種形狀」,那是這支測不到的),
 * 但真正的行為從今天起由這支守。
 *
 * ⚠️ **這支的 `it()` 標題一律用 ASCII。** vitest-pool-workers 會把測試名塞進
 * `MF-Vitest-Source` 這個 HTTP 標頭,非 ASCII 會讓 workerd 對**每一條測試**印兩行警告,
 * 淹掉真正的失敗訊息。中文說明寫在註解與 `expect(x, '理由')` 的第二參數裡 —— 那兩個
 * 不會進標頭,而斷言訊息本來就是失敗時最該看到的東西。
 */
import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';

const KIND = 22690;
const TOPIC = '2p4n6g54165w2j74s1b6cn4q0233c362f4m1n';
const nowSec = (): number => Math.floor(Date.now() / 1000);
const hex = (n: number): string => Array.from({ length: n }, (_, i) => (i % 16).toString(16)).join('');

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface Ev {
  kind: number;
  tags: string[][];
  created_at: number;
  content: string;
  pubkey: string;
  id: string;
  sig: string;
}

/** 照 NIP-01 的序列化算 id。`tamper` 用來造一個 id 對不上內容的事件。 */
async function mkEvent(content: string, opts: { topic?: string; kind?: number; tamper?: boolean } = {}): Promise<Ev> {
  const kind = opts.kind ?? KIND;
  const tags = [['x', opts.topic ?? TOPIC]];
  const created_at = nowSec();
  const pubkey = hex(64);
  const id = await sha256hex(JSON.stringify([0, pubkey, created_at, kind, tags, content]));
  return {
    kind,
    tags,
    created_at,
    content,
    pubkey,
    id: opts.tamper ? id.replace(/^./, id[0] === '0' ? '1' : '0') : id,
    sig: '0'.repeat(128),
  };
}

interface Conn {
  ws: WebSocket;
  frames: unknown[][];
  send: (x: unknown) => void;
}

/**
 * 每個測試開過的 socket。收尾一定要關掉:留著沒關的 WebSocket 會讓 vitest-pool-workers
 * 在 suite 結束時炸「Isolated storage failed」—— 它要收掉 DO,而 DO 還握著活的連線。
 */
const opened: WebSocket[] = [];
afterEach(async () => {
  for (const ws of opened.splice(0)) {
    try {
      ws.close();
    } catch {
      // 已經關了
    }
  }
  // `close()` **不是同步生效**。不等 DO 真的收到 webSocketClose 就讓 isolated storage
  // 收尾,DO 還握著連線 ⇒ Windows 上會 EBUSY 鎖住那個 sqlite 檔然後整個 suite 紅掉。
  // (這也正是 relay.ts 的 reapAndCount 存在的理由:close 之後那條**還在** getWebSockets 裡。)
  await new Promise((r) => setTimeout(r, 50));
});

/** 開一條真的 WebSocket 到 RelayDO。每個測試用不同的 ip,免得互相吃掉每 IP 的名額。 */
async function connect(ip: string): Promise<Conn> {
  const res = await SELF.fetch('https://relay.example/', {
    headers: { Upgrade: 'websocket', 'CF-Connecting-IP': ip },
  });
  expect(res.status, '升級成 WebSocket 應該回 101').toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error('回應沒有帶 webSocket');
  ws.accept();
  opened.push(ws);
  const frames: unknown[][] = [];
  ws.addEventListener('message', (e: MessageEvent) => {
    frames.push(JSON.parse(String(e.data)) as unknown[]);
  });
  return { ws, frames, send: (x: unknown) => ws.send(JSON.stringify(x)) };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 等某個訊框出現。回 null 表示等到逾時都沒來(拿來斷言「不該來」時很有用)。 */
async function waitFor(c: Conn, pred: (f: unknown[]) => boolean, ms = 1500): Promise<unknown[] | null> {
  const t0 = Date.now();
  for (;;) {
    const f = c.frames.find(pred);
    if (f) return f;
    if (Date.now() - t0 > ms) return null;
    await sleep(10);
  }
}

const subscribe = (c: Conn, subId: string, extra: Record<string, unknown> = {}): void =>
  c.send(['REQ', subId, { kinds: [KIND], since: nowSec() - 60, '#x': [TOPIC], ...extra }]);

describe('routing', () => {
  it('GET /health returns ok', async () => {
    const res = await SELF.fetch('https://relay.example/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('HEAD /health returns 200 with no body', async () => {
    // /health 就是給監控用的,而監控慣用 HEAD。這條之前是 405。
    const res = await SELF.fetch('https://relay.example/health', { method: 'HEAD' });
    expect(res.status, 'HEAD 不該被打成 405').toBe(200);
    expect(await res.text(), 'HEAD 的回應不該有 body').toBe('');
  });

  it('OPTIONS returns 204 with the three CORS headers NIP-11 requires', async () => {
    const res = await SELF.fetch('https://relay.example/', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toBeTruthy();
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('NIP-11 document is served on Accept: application/nostr+json', async () => {
    const res = await SELF.fetch('https://relay.example/', {
      headers: { Accept: 'application/nostr+json' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/nostr+json');
    expect(res.headers.get('access-control-allow-origin'), 'NIP-11 的 MUST:要帶 CORS').toBe('*');
    const doc = (await res.json()) as { name: string; supported_nips: number[]; limitation: Record<string, unknown> };
    expect(doc.supported_nips).toContain(11);
    expect(doc.name, 'name 要取自請求的 host,不是寫死的網域').toBe('relay.example');
    expect(doc.limitation['max_filters'], '一個 REQ 只收一個 filter,這條一定要宣告').toBe(1);
  });

  it('plain GET returns human-readable text, not the NIP-11 JSON', async () => {
    const res = await SELF.fetch('https://relay.example/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('unknown path is 404 and non-GET is 405', async () => {
    expect((await SELF.fetch('https://relay.example/nope')).status).toBe(404);
    expect((await SELF.fetch('https://relay.example/', { method: 'POST' })).status).toBe(405);
  });
});

describe('NIP-01 exchange', () => {
  it('REQ gets EOSE immediately (there is no history)', async () => {
    const a = await connect('10.0.0.1');
    subscribe(a, 'subA');
    expect(await waitFor(a, (f) => f[0] === 'EOSE' && f[1] === 'subA')).toBeTruthy();
  });

  it('IRON LAW 4: fan-out includes the sender itself', async () => {
    // 這是整支測試存在的理由。super-reversi2 的 ChatDO 跳過發送者,這裡**不能**跳 ——
    // 跳了的話 Trystero 兩端的 onPeerJoin 就不成立,而症狀只有「配對不起來」。
    // 原本守這條的是一句綁死識別字的正規式,改一行就繞得過去且 pnpm check 全綠。
    const a = await connect('10.0.1.1');
    const b = await connect('10.0.1.2');
    subscribe(a, 'subA');
    subscribe(b, 'subB');
    await waitFor(a, (f) => f[0] === 'EOSE');
    await waitFor(b, (f) => f[0] === 'EOSE');

    const ev = await mkEvent('hello-from-B');
    b.send(['EVENT', ev]);

    const aGot = await waitFor(a, (f) => f[0] === 'EVENT' && f[1] === 'subA' && (f[2] as Ev)?.id === ev.id);
    const bGot = await waitFor(b, (f) => f[0] === 'EVENT' && f[1] === 'subB' && (f[2] as Ev)?.id === ev.id);
    expect(aGot, '對方要收到').toBeTruthy();
    expect(bGot, '**發送者自己也要收到**(鐵律 4);少了這個 Trystero 配不上對').toBeTruthy();

    const ok = await waitFor(b, (f) => f[0] === 'OK' && f[1] === ev.id);
    expect(ok?.[2], '收下的事件要回 OK true').toBe(true);
    expect(JSON.stringify((aGot?.[2] as Ev).tags), 'tags 要原樣轉發').toBe(JSON.stringify(ev.tags));
  });

  it('event with a tampered id is rejected and never fanned out', async () => {
    const a = await connect('10.0.2.1');
    const b = await connect('10.0.2.2');
    subscribe(a, 'subA');
    await waitFor(a, (f) => f[0] === 'EOSE');

    const bad = await mkEvent('tampered', { tamper: true });
    b.send(['EVENT', bad]);
    const ok = await waitFor(b, (f) => f[0] === 'OK' && f[1] === bad.id);
    expect(ok?.[2], 'id 對不上內容就要拒收').toBe(false);
    expect(String(ok?.[3]), '拒收要帶 invalid: 前綴').toMatch(/^invalid:/);
    expect(
      await waitFor(a, (f) => f[0] === 'EVENT' && (f[2] as Ev)?.id === bad.id, 250),
      '被拒的事件不可以流出去',
    ).toBeNull();
  });

  it('kind outside the ephemeral range is rejected with a NOTICE', async () => {
    // ⚠️ 回的是 NOTICE 不是 OK false。契約寫在 relay.ts 檔頭:
    // **壞形狀 → NOTICE、id 對不上 → OK false**。kind 不在區段內算壞形狀,
    // 在 parseClientMsg 就被擋下,那時還沒有「一個可信的 event.id」可以拿來回 OK。
    // 代價是客戶端無法用 id 對應這則拒絕 —— 可接受,因為 Trystero 的 topicToKind
    // (`strToNum(topic, 1e4) + 2e4`)恆落在 20000–29999,正常客戶端踩不到這條。
    const b = await connect('10.0.3.1');
    const ev = await mkEvent('persistent', { kind: 1 });
    b.send(['EVENT', ev]);
    const notice = await waitFor(b, (f) => f[0] === 'NOTICE');
    expect(String(notice?.[1]), 'kind 1 會被儲存型 relay 留下來,這裡只收 20000–29999').toContain('kind');
  });

  it('a different topic does not reach the subscriber', async () => {
    const a = await connect('10.0.4.1');
    const b = await connect('10.0.4.2');
    subscribe(a, 'subA');
    await waitFor(a, (f) => f[0] === 'EOSE');

    const other = await mkEvent('other-room', { topic: 'zzz-some-other-topic' });
    b.send(['EVENT', other]);
    expect(await waitFor(b, (f) => f[0] === 'OK' && f[1] === other.id), '事件本身是合法的').toBeTruthy();
    expect(
      await waitFor(a, (f) => f[0] === 'EVENT' && (f[2] as Ev)?.id === other.id, 250),
      '#x 對不上就不該送過去',
    ).toBeNull();
  });

  it('CLOSE stops delivery on that subscription', async () => {
    const a = await connect('10.0.5.1');
    const b = await connect('10.0.5.2');
    subscribe(a, 'subA');
    await waitFor(a, (f) => f[0] === 'EOSE');
    a.send(['CLOSE', 'subA']);
    await sleep(50);

    const ev = await mkEvent('after-close');
    b.send(['EVENT', ev]);
    await waitFor(b, (f) => f[0] === 'OK' && f[1] === ev.id);
    expect(
      await waitFor(a, (f) => f[0] === 'EVENT' && (f[2] as Ev)?.id === ev.id, 250),
      'CLOSE 之後不該再收到',
    ).toBeNull();
  });

  it('a REQ carrying two filters is rejected (this is what max_filters=1 declares)', async () => {
    // NIP-11 宣告 max_filters: 1。那個數字沒有對應的判斷式(實際的閘是 arity),
    // 所以宣告與行為對不對得上要在這裡驗 —— 否則就是一份會說謊的能力宣告。
    const a = await connect('10.0.11.1');
    const f = { kinds: [KIND], since: nowSec() - 60, '#x': [TOPIC] };
    a.send(['REQ', 'subTwo', f, f]);
    const notice = await waitFor(a, (f2) => f2[0] === 'NOTICE');
    expect(String(notice?.[1]), '兩個 filter 要被拒,而且理由要說得出是 multi-filter').toContain('multi-filter');
  });

  it('a malformed filter gets a NOTICE and malformed JSON gets silence', async () => {
    const a = await connect('10.0.6.1');
    a.send(['REQ', 'subBad', { kinds: [1], '#x': [TOPIC] }]); // kind 不在 ephemeral 區段
    const notice = await waitFor(a, (f) => f[0] === 'NOTICE');
    expect(String(notice?.[1])).toContain('filter');

    const before = a.frames.length;
    a.ws.send('{not json');
    await sleep(200);
    expect(a.frames.length, '壞 JSON 靜默丟,不回話(不然它就是免費的回應通道)').toBe(before);
  });

  it('oversized frames are dropped without a reply', async () => {
    const a = await connect('10.0.7.1');
    const before = a.frames.length;
    a.ws.send(JSON.stringify(['EVENT', { junk: 'x'.repeat(20000) }]));
    await sleep(200);
    expect(a.frames.length, '尺寸閘在 JSON.parse 之前,連解析都不該發生').toBe(before);
  });
});

describe('abuse gates', () => {
  it('subscription ids like __proto__ do not bypass the per-socket cap', async () => {
    // 訂閱表若用普通物件 + `in`,`__proto__` / `toString` 會被當成「已存在」而不佔名額,
    // 等於繞過上限。relay.ts 用 Object.create(null) + Object.hasOwn 擋這件事。
    const a = await connect('10.0.8.1');
    for (const id of ['__proto__', 'toString', 'constructor', 'hasOwnProperty']) {
      subscribe(a, id);
      expect(await waitFor(a, (f) => f[0] === 'EOSE' && f[1] === id), `${id} 應該是一個正常的訂閱`).toBeTruthy();
    }
    const ev = await mkEvent('proto-check');
    const b = await connect('10.0.8.2');
    b.send(['EVENT', ev]);
    // 每個原型名各自都該收到一次 —— 它們是真的訂閱,不是原型鏈上的殘影
    for (const id of ['__proto__', 'toString']) {
      expect(
        await waitFor(a, (f) => f[0] === 'EVENT' && f[1] === id && (f[2] as Ev)?.id === ev.id),
        `${id} 這個訂閱要真的收得到事件`,
      ).toBeTruthy();
    }
  });

  it('too many connections from one IP is refused with 429', async () => {
    const ip = '10.0.9.1';
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 12; i++) {
      const res = await SELF.fetch('https://relay.example/', {
        headers: { Upgrade: 'websocket', 'CF-Connecting-IP': ip },
      });
      if (res.status === 429) {
        await res.text(); // 一定要把 body 讀掉,否則那個 Response 會一直握著資源
        rejected++;
        break;
      }
      const ws = res.webSocket;
      if (ws) {
        ws.accept();
        opened.push(ws);
        accepted++;
      }
    }
    expect(rejected, '同一個 IP 開到上限之後要被擋').toBeGreaterThan(0);
    expect(accepted, '上限是 MAX_SOCKETS_PER_IP(8)').toBe(8);
  });

  it('a socket that floods gets rate-limited rather than silently served', async () => {
    const a = await connect('10.0.10.1');
    subscribe(a, 'subA');
    await waitFor(a, (f) => f[0] === 'EOSE');
    const ev = await mkEvent('flood');
    for (let i = 0; i < 80; i++) a.send(['EVENT', ev]);
    const limited = await waitFor(a, (f) => f[0] === 'OK' && f[2] === false && String(f[3]).startsWith('rate-limited:'), 2500);
    expect(limited, '灌爆要拿到 rate-limited: 而不是被靜默服務').toBeTruthy();
  });
});
