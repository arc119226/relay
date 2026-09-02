// 用**真的** trystero/nostr 客戶端驗 relay。頁面自己嵌 iframe 當第二個 peer
// （module scope ⇒ 各自一個 selfId），兩邊都必須 onPeerJoin 才算過。
//
// 情境用 ?scenario= 選（預設 solo）：
//   solo      只打自架那台。階段 3 的驗收（docs/plan.md 階段 3）
//   full      柴米帳實際用的六台：錨點 + relays.json 的五台公共
//   anchor    只有錨點 —— 證明公共全掛也配得上
//   failover  錨點指向一個連不上的位址 + 五台公共 —— 這條等同「把 Worker 暫停」
//             （階段 5 的證明，只是不必真的動正式站）
//
// 也可以直接給清單：?relays=wss://a,wss://b
import { joinRoom, getRelaySockets, selfId } from 'trystero/nostr';

const ANCHOR = 'wss://relay.arc.idv.tw';
// 柴米帳 public/relays.json 的內容（升級橋接期刻意就是舊版洗出來的那五台）
const PUBLIC = [
  'wss://hornetstorage.net/relay',
  'wss://slick.mjex.me',
  'wss://staging.yabu.me',
  'wss://relay2.angor.io',
  'wss://communities.nos.social',
];
// 連不上的位址，用來假裝錨點掛了。指到自架網域的一個不存在的子網域，
// 確定它會失敗而不是意外連上別人的 relay。
const DEAD_ANCHOR = 'wss://suspended.relay.arc.idv.tw';

const SCENARIOS = {
  solo: [ANCHOR],
  full: [ANCHOR, ...PUBLIC],
  anchor: [ANCHOR],
  failover: [DEAD_ANCHOR, ...PUBLIC],
};

const q = new URLSearchParams(location.search);
const role = q.get('peer') ?? 'host';
const scenario = q.get('scenario') ?? 'solo';
const relays = q.get('relays') ? q.get('relays').split(',') : (SCENARIOS[scenario] ?? SCENARIOS.solo);
// 每次載入換一個房間，才不會撞到正式站正在進行的同步（topic = SHA-1(appId+roomId)）
const room = q.get('room') ?? `smoke-${Math.floor(Date.now() / 1000)}`;
// 柴米帳真正的 appId：這樣派生金鑰與 topic 的算法跟正式站一致
const appId = q.get('appId') ?? 'zhangben-sync-v1';

const t0 = Date.now();
const out = { role, scenario, relays, room, selfId, peerJoined: null, got: null, sockets: null, warnings: [], error: null };
window.__result = out;
const render = () => {
  document.getElementById('out').textContent = JSON.stringify(out, null, 2);
};
const origWarn = console.warn.bind(console);
console.warn = (...a) => {
  out.warnings.push(a.map(String).join(' '));
  render();
  origWarn(...a);
};

/** 哪幾台真的連上了 —— failover 情境要靠這個證明「死的那台沒連上、活的接手」 */
const snapshotSockets = () => {
  const READY = { 0: 'connecting', 1: 'open', 2: 'closing', 3: 'closed' };
  const m = getRelaySockets();
  out.sockets = Object.fromEntries(Object.entries(m).map(([url, ws]) => [url, READY[ws?.readyState] ?? 'missing']));
  render();
};

try {
  const r = joinRoom({ appId, relayConfig: { urls: relays, warnOnRelayFailure: true } }, room);
  const hello = r.makeAction('hello');
  hello.onMessage = (data, peerId) => {
    out.got = { data, from: peerId, at: Date.now() - t0 };
    render();
  };
  r.onPeerJoin = (peerId) => {
    out.peerJoined = { peerId, at: Date.now() - t0 };
    render();
    hello.send({ from: role, n: 1 });
  };
  setTimeout(snapshotSockets, 2000);
  setTimeout(snapshotSockets, 6000);
} catch (e) {
  out.error = String(e && e.stack ? e.stack : e);
}
render();

if (role === 'host') {
  const f = document.createElement('iframe');
  f.id = 'guest';
  const p = new URLSearchParams(location.search);
  p.set('peer', 'guest');
  p.set('room', room); // 兩邊必須同一個房間
  f.src = `${location.pathname}?${p}`;
  f.style.cssText = 'width:100%;height:320px;border:1px solid #999';
  document.body.appendChild(f);
}
