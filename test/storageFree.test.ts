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
    expect(/peer\s*[!=]==?\s*ws\b/.test(CODE), 'relay.ts 出現 peer === ws / peer !== ws ⇒ 抄到 ChatDO 的跳過自己').toBe(false);
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
