/**
 * 機器鎖 —— 以原始碼比對守 `src/relay.ts` 的結構。鏡射 super-reversi2 的
 * `chatStorageFree.test.ts`,但第五條**反過來**:那邊斷言「跳過發送者」,這邊斷言「沒有跳過」。
 *
 * 文件會過期、註解會被無視,這條不會。
 */
import { describe, expect, it } from 'vitest';
import SRC from '../src/relay.ts?raw';

/** 剝掉註解再比對 —— 檔頭正文會提到 `ctx.storage` 這幾個字,那不算違規 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
/** fanOut 那個方法的本體(從簽名到下一個方法) */
const FANOUT = CODE.slice(CODE.indexOf('fanOut('), CODE.indexOf('webSocketClose'));

describe('RelayDO 零持久化(鐵律 1)', () => {
  it('全檔零 storage:沒有 ctx.storage / setAlarm / transaction / blockConcurrencyWhile', () => {
    for (const banned of ['storage', 'setAlarm', 'transaction', 'blockConcurrencyWhile']) {
      expect(CODE.includes(banned), `relay.ts 出現 ${banned} ⇒「零儲存」不再是結構性事實`).toBe(false);
    }
  });

  it('沒有任何「累積訊息」的形狀:不留歷史陣列、不 push', () => {
    expect(/\b(history|backlog|recent|buffer|ring)\b/i.test(CODE), '出現緩衝/歷史命名').toBe(false);
    expect(/\.push\(/.test(CODE), 'relay.ts 不該把訊息累積進任何陣列').toBe(false);
  });
});

describe('RelayDO 結構鎖', () => {
  it('走 Hibernation API(acceptWebSocket + webSocketMessage),不是常駐 addEventListener', () => {
    // 常駐 ws.addEventListener('message') 會讓 DO 無法 hibernate ⇒ 一直計 duration
    expect(CODE).toContain('acceptWebSocket');
    expect(CODE).toContain('webSocketMessage');
    expect(/addEventListener\(\s*['"]message/.test(CODE), '常駐 listener 會擋掉 hibernation').toBe(false);
  });

  it('尺寸閘在 JSON.parse **之前**(鐵律 6:順序即契約)', () => {
    // 找的是**判斷式**不是識別字:MAX_FRAME 也出現在 import 行,拿識別字比位置等於沒鎖
    const gate = CODE.search(/message\.length\s*>\s*MAX_FRAME/);
    const parse = CODE.indexOf('JSON.parse');
    expect(gate, 'relay.ts 沒有訊框尺寸閘').toBeGreaterThan(-1);
    expect(parse).toBeGreaterThan(-1);
    expect(gate, '尺寸閘必須早於 JSON.parse').toBeLessThan(parse);
  });

  it('令牌桶在 parseClientMsg **之前**(壞形狀的 NOTICE 不能是免費的回應通道)', () => {
    const bucket = CODE.indexOf('takeToken(');
    const parse = CODE.indexOf('parseClientMsg(');
    expect(bucket).toBeGreaterThan(-1);
    expect(parse).toBeGreaterThan(-1);
    expect(bucket, '桶要在 parseClientMsg 之前結算').toBeLessThan(parse);
  });

  it('fan-out **不**跳過發送者(鐵律 4,跟 ChatDO 相反)', () => {
    // ⚠️ 舊版只擋 /peer\s*[!=]==?\s*ws\b/ —— 那綁死了兩個識別字**與運算元順序**。
    // 完工稽核實測到兩種各改一行就繞過、而且整條 pnpm check 全綠的寫法:
    //   (a) 加第三個參數 `sender`,迴圈裡 `if (peer === sender) continue;`
    //   (b) 連改名都不必:`if (this.lastSender === peer) continue;`(左右對調就躲掉了)
    // 所以改成鎖**形狀**而不是拼字:參數只能有兩個(沒有第三個東西可以拿來比對發送者)、
    // 本體不得早退、只准有一個 if 而且必須是 matches 那個。
    // 這仍然是原始碼比對;真正把它跑起來斷言的是 relay.behaviour.test.ts。
    const sig = FANOUT.slice(0, FANOUT.indexOf(')') + 1);
    expect(sig.split(',').length, 'fanOut 只該收 (event, nowMs);多一個參數就是要拿來跳過自己').toBe(2);
    expect(/\bcontinue\b|\breturn\b/.test(FANOUT), 'fanOut 本體不得早退 ⇒ 每條 socket 都要走到').toBe(false);
    expect((FANOUT.match(/\bif\s*\(/g) ?? []).length, 'fanOut 只該有一個 if(matches);多一個就是在挑對象').toBe(1);
    expect(FANOUT, '那個 if 必須是 matches,不是別的條件').toContain('if (matches(event, f))');
    expect(CODE).toContain('getWebSockets()');
  });

  it('唯一的 await 是 verifyEventId,而且桶在它之前已經寫回', () => {
    const awaits = CODE.match(/\bawait\b/g) ?? [];
    expect(awaits.length, '本檔只該有一個 await(驗 id)').toBe(1);
    const verify = CODE.indexOf('await verifyEventId');
    expect(verify).toBeGreaterThan(-1);
    // 從 EVENT 分支開始到 await 之間,一定有一次 writeAttachment(桶已結算)
    const eventBranch = CODE.lastIndexOf('writeAttachment(ws', verify);
    expect(eventBranch, 'await 之前要先把桶寫回').toBeGreaterThan(-1);
    expect(verify - eventBranch, 'writeAttachment 要緊貼在 await 之前的那個分支裡').toBeLessThan(400);
  });

  it('不拉簽章驗證進來(鐵律 5)', () => {
    expect(/noble|secp256k1|schnorr/i.test(CODE), 'relay.ts 不該碰 secp256k1').toBe(false);
  });
});

describe('對抗式覆核與完工稽核補的閘(2026-09-02 / 09-03)', () => {
  it('socket 以 IP 當 tag,而且 fetch 有每個 IP 的上限', () => {
    // 200 條閒置連線的免費鎖死,唯一不用 storage 的解法就是 tag
    expect(CODE).toContain('CF-Connecting-IP');
    expect(/acceptWebSocket\(server,\s*\[/.test(CODE), 'acceptWebSocket 要帶 tag 陣列').toBe(true);
    expect(/reapAndCount\(this\.ctx\.getWebSockets\(ip\), nowMs\)\s*>=\s*MAX_SOCKETS_PER_IP/.test(CODE), '每 IP 的閘要走 reapAndCount(會濾掉死的)').toBe(true);
  });

  it('DO 層有總量桶,而且在 await 之前結算', () => {
    expect(CODE).toContain('DO_EVENT_CAP');
    const relayGate = CODE.indexOf('DO_EVENT_REFILL_MS)');
    const verify = CODE.indexOf('await verifyEventId');
    expect(relayGate, '沒有 DO 層的桶').toBeGreaterThan(-1);
    expect(relayGate, 'DO 層的桶要在 await 之前').toBeLessThan(verify);
  });

  it('fan-out 只 stringify 事件一次', () => {
    expect(FANOUT.length, '找不到 fanOut 本體').toBeGreaterThan(50);
    expect((FANOUT.match(/JSON\.stringify/g) ?? []).length, 'fanOut 裡只該有一次 JSON.stringify(事件)').toBe(1);
    expect(FANOUT).toContain('eventFrame(');
  });

  it('**兩道**連線閘都要回收死的,不是只有每 IP 那條', () => {
    // 半開的 socket 不觸發 webSocketClose 但 getWebSockets() 數得到 ⇒ 格子單向洩漏。
    // 正式站實測過:每 IP 上限寫 8 實際只開得了 6,靜置三分鐘也不回來。
    //
    // ⚠️ 這條原本寫的是「全域那條濾 readyState」—— 那等於**把缺陷鎖了起來**:
    // 半開 socket 的 readyState 正是 OPEN,所以全域那條根本沒在回收。累積到 MAX_SOCKETS
    // 之後 503 會把所有人永久鎖在門外,而且它排在每 IP 那條之前,連「回來的 IP 順手清一清」
    // 這條自癒路徑都被自己擋掉,只有重新部署救得回來。現在兩道閘餵同一支 reapAndCount。
    expect(CODE).toContain('reapAndCount(');
    expect(CODE).toContain('isStale(');
    expect(/reapAndCount\(this\.ctx\.getWebSockets\(\), nowMs\)/.test(CODE), '全域那條也要走 reapAndCount').toBe(true);
    expect(/reapAndCount\(this\.ctx\.getWebSockets\(ip\), nowMs\)/.test(CODE), '每 IP 那條要走 reapAndCount').toBe(true);
    expect(/getWebSockets\(ip\)\.length/.test(CODE), '每 IP 那條不能直接數').toBe(false);
    // 全域的 503 必須排在回收之後,否則它自己擋掉唯一的自癒路徑
    const reapAll = CODE.indexOf('reapAndCount(this.ctx.getWebSockets(), nowMs)');
    const full = CODE.indexOf("'relay full'");
    expect(reapAll, '找不到全域回收').toBeGreaterThan(-1);
    expect(reapAll, '503 要排在全域回收之後').toBeLessThan(full);
  });

  it('訂閱表不走原型鏈:Object.create(null) + Object.hasOwn,沒有 `in subs`', () => {
    expect(CODE).toContain('Object.create(null)');
    expect(CODE).toContain('Object.hasOwn(');
    expect(/\bin subs\b/.test(CODE), '`subId in subs` 會把 toString / __proto__ 當成已存在').toBe(false);
  });
});
