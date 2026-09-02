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

// 自架那台的位址。**用 ?anchor= 換掉**,不要改這裡 —— fork 這個 repo 的人跑預設情境
// 不應該去打作者的正式站(那樣拿到的綠燈證明的是別人的服務還活著,不是你的)。
const ANCHOR = new URLSearchParams(location.search).get('anchor') ?? 'ws://127.0.0.1:8787';
// 一組公共 relay。⚠️ 這是**手抄的快照,會腐敗** —— 2026-09-03 實測這五台只有兩台是活的
// (staging.yabu.me / relay2.angor.io)。留著是當「舊清單」的回歸用,不是「現況」。
// 要知道現在哪幾台能用,跑柴米帳的 tools/probe-relays.mjs。
const PUBLIC = [
  'wss://hornetstorage.net/relay',
  'wss://slick.mjex.me',
  'wss://staging.yabu.me',
  'wss://relay2.angor.io',
  'wss://communities.nos.social',
];
// 連不上的位址,用來假裝錨點掛了。指到一個不存在的子網域,
// 確定它會失敗而不是意外連上別人的 relay。
const DEAD_ANCHOR = 'wss://suspended.invalid.example';

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
// 預設用 relay 自己的 appId。要重現柴米帳的情境就傳 ?appId=zhangben-sync-v1 ——
// 那會讓派生金鑰與 topic 的算法跟柴米帳正式站一致(appId 不是秘密,它在客戶端 bundle 裡)。
const appId = q.get('appId') ?? 'relay-smoke';

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
