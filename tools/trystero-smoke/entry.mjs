// Phase-3 acceptance: the REAL trystero/nostr client, pointed at the local relay only.
// Host page embeds itself as an iframe (?peer=guest) => a second, independent Trystero instance
// (module scope => its own selfId). Both must reach onPeerJoin and exchange one message over WebRTC.
import { joinRoom, getRelaySockets, selfId } from 'trystero/nostr';

const RELAY = 'wss://relay.arc.idv.tw';
const role = new URLSearchParams(location.search).get('peer') ?? 'host';
const t0 = Date.now();
const out = { role, selfId, relays: null, peerJoined: null, sent: null, got: null, warnings: [], error: null };
window.__result = out;
const render = () => { document.getElementById('out').textContent = JSON.stringify(out, null, 2); };
const origWarn = console.warn.bind(console);
console.warn = (...a) => { out.warnings.push(a.map(String).join(' ')); render(); origWarn(...a); };

try {
  const room = joinRoom({ appId: 'relay-smoke', relayConfig: { urls: [RELAY], warnOnRelayFailure: true } }, 'phase3');
  const hello = room.makeAction('hello');
  hello.onMessage = (data, peerId) => { out.got = { data, from: peerId, at: Date.now() - t0 }; render(); };
  room.onPeerJoin = (peerId) => {
    out.peerJoined = { peerId, at: Date.now() - t0 };
    render();
    hello.send({ from: role, n: 1 });
    out.sent = { to: peerId, at: Date.now() - t0 };
    render();
  };
  room.onPeerLeave = (peerId) => { out.peerLeft = peerId; render(); };
  setTimeout(() => { out.relays = Object.keys(getRelaySockets()); render(); }, 1500);
} catch (e) {
  out.error = String(e && e.stack ? e.stack : e);
}
render();

if (role === 'host') {
  const f = document.createElement('iframe');
  f.id = 'guest';
  f.src = location.pathname + '?peer=guest';
  f.style.cssText = 'width:100%;height:320px;border:1px solid #999';
  document.body.appendChild(f);
}
