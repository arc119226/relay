/**
 * Router。只有三條路:
 *   GET /        + Upgrade: websocket → RelayDO(單例)
 *   GET /        (沒有 Upgrade)        → 一段給人看的純文字
 *   GET /health                        → {ok:true},不碰 DO
 * 其他一律 404。
 */
export { RelayDO } from './relay';

interface Env {
  readonly RELAY: DurableObjectNamespace;
}

export default {
  fetch(req: Request, env: Env): Response | Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    if (url.pathname !== '/') return new Response('not found', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response(
        'relay.arc.idv.tw — NIP-01 子集的 WebSocket 訊令 relay,什麼都不存。\n' +
          '用 wss:// 連,協定見 https://github.com/arc119226/relay/blob/main/docs/spec.md\n',
        { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }
    // 原封轉發:Upgrade 標頭與 WebSocketPair 都得走原請求
    return env.RELAY.get(env.RELAY.idFromName('relay')).fetch(req);
  },
};
