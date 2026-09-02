/**
 * RelayDO。
 *
 * ⚠️ 階段 0:這支目前是 **probe**,不是 relay。webSocketMessage 的內容是拿來實測
 *    `serializeAttachment` 的大小上限的(plan.md 階段 0)。量到數字之後,這段會被
 *    階段 2 的正式實作整個換掉;只有 fetch 的骨架(426 / 503 / 101 + Hibernation)會留下來。
 *
 * probe 協定(暫時的):
 *   client → "N"(十進位整數)
 *   DO 試著 serializeAttachment 一個 N bytes 的字串,再 deserializeAttachment 讀回來
 *   DO → {"n":N,"wrote":bool,"readBack":bool,"err":string?}
 *
 * 讀回來這一步不等於「撐過 hibernation」—— wrangler dev 的 workerd 不會真的把 DO 逐出
 * 記憶體。這裡量的是 **寫入的拒收門檻**,那才是文件沒寫清楚的數字。
 */
export class RelayDO {
  private readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  fetch(req: Request): Response {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    if (this.ctx.getWebSockets().length >= 200) {
      return new Response('full', { status: 503 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') return;
    const n = Number.parseInt(message, 10);
    if (!Number.isFinite(n) || n < 0) {
      ws.send(JSON.stringify({ err: 'send a non-negative integer' }));
      return;
    }
    const payload = 'x'.repeat(n);
    let wrote = false;
    let readBack = false;
    let err: string | undefined;
    try {
      ws.serializeAttachment(payload);
      wrote = true;
      const back = ws.deserializeAttachment();
      readBack = typeof back === 'string' && back.length === n;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    ws.send(JSON.stringify({ n, wrote, readBack, ...(err === undefined ? {} : { err }) }));
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
