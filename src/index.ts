/**
 * Router。四條路:
 *   OPTIONS /                                → 204 + CORS(NIP-11 要求,見下)
 *   GET /       + Accept: application/nostr+json → NIP-11 relay information document
 *   GET /       + Upgrade: websocket         → RelayDO(單例)
 *   GET /       (兩者皆無)                    → 一段給人看的純文字
 *   GET /health                              → {ok:true},不碰 DO
 * 其他一律 404。
 *
 * ## 順序有兩處是契約
 *
 * 1. **OPTIONS 要在 method 檢查之前。** 原本 `req.method !== 'GET'` 那條在 path 比對之前,
 *    所以任何 OPTIONS 都拿到裸 405、零 CORS 標頭 —— 送了額外標頭而觸發 preflight 的
 *    瀏覽器客戶端會直接失敗。
 * 2. **NIP-11 的判斷要在 Upgrade 之前檢查 Accept、但讓 Upgrade 優先。**
 *    帶 `Upgrade` 的請求是 WebSocket 客戶端,不該拿到 JSON。
 *
 * ## CORS
 *
 * NIP-11 明文:「Relays MUST accept CORS requests by sending `Access-Control-Allow-Origin`,
 * `Access-Control-Allow-Headers`, and `Access-Control-Allow-Methods` headers.」
 * 既然宣告 `supported_nips: [11]`,就得滿足它的 MUST。
 *
 * ⚠️ 但要說清楚:**單純的 NIP-11 抓取其實不會發 preflight。** `accept` 是 CORS
 * 安全清單內的標頭名,而 `application/nostr+json` 只含字母、`/`、`+`,都不是
 * CORS-unsafe request-header byte(那組是 `"()<>?@[\]{}` 與控制字元)。
 * OPTIONS 那條存在的理由是規格的 MUST 與「客戶端可能多送別的標頭」,不是 preflight 本身。
 */
export { RelayDO } from './relay';
import { relayInfo } from './nip11';

interface Env {
  readonly RELAY: DurableObjectNamespace;
}

/** NIP-11 要求的三個。值不由規格指定,`*` 是 relay 的慣例(這份文件本來就是公開資訊)。 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Accept, Content-Type',
  'access-control-allow-methods': 'GET, OPTIONS',
} as const;

export default {
  fetch(req: Request, env: Env): Response | Promise<Response> {
    const url = new URL(req.url);
    // 🔴 這條必須在 method 檢查之前(見檔頭)
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS } });
    }
    if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    if (url.pathname !== '/') return new Response('not found', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') {
      // Accept 可以是帶 q 值的清單,所以用 includes 而不是相等
      if ((req.headers.get('Accept') ?? '').includes('application/nostr+json')) {
        // **不碰 DO**:純靜態回應。DO 的請求是計費的,而這支會被爬。
        // host 從請求取,不寫死網域 —— 這個 repo 是給人 fork 自架的。
        return new Response(JSON.stringify(relayInfo(url.host)), {
          status: 200,
          headers: { 'content-type': 'application/nostr+json', ...CORS },
        });
      }
      return new Response(
        'NIP-01 子集的 WebSocket 訊令 relay,什麼都不存。\n' +
          '用 wss:// 連。機器可讀的能力宣告:GET / 帶 Accept: application/nostr+json\n' +
          '協定見 https://github.com/arc119226/relay/blob/main/docs/spec.md\n',
        { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }
    // 原封轉發:Upgrade 標頭與 WebSocketPair 都得走原請求
    return env.RELAY.get(env.RELAY.idFromName('relay')).fetch(req);
  },
};
