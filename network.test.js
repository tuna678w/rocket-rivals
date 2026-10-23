// End-to-end network test: spawns the real server and drives it with real WebSocket clients.
const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 4300 + Math.floor(Math.random() * 500);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ port: PORT, path: p, host: '127.0.0.1' }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ status: r.statusCode, body: b, headers: r.headers })); }).on('error', rej));

class Client {
  constructor(name) { this.name = name; this.msgs = []; this.last = null; this.closed = false; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      this.ws.onopen = () => res(this);
      this.ws.onerror = rej;
      this.ws.onclose = () => { this.closed = true; };
      this.ws.onmessage = e => { const m = JSON.parse(e.data); if (m.type === 'state') this.last = m; else this.msgs.push(m); };
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  async wait(type, ms = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const i = this.msgs.findIndex(m => m.type === type); if (i >= 0) return this.msgs.splice(i, 1)[0]; await sleep(20); }
    throw new Error(`${this.name}: timeout waiting for ${type}; got ${JSON.stringify(this.msgs.map(m => m.type))}`);
  }
  async waitPhase(phase, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (this.last && this.last.phase === phase) return this.last; await sleep(20); }
    throw new Error(`${this.name}: timeout waiting for phase ${phase}, last=${this.last && this.last.phase}`);
  }
  close() { try { this.ws.close(); } catch (e) {} }
}
const rooms = async () => JSON.parse((await get('/health')).body).rooms;

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), MATCH_LENGTH: '5' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverErr = ''; srv.stderr.on('data', d => serverErr += d);
  for (let i = 0; i < 50; i++) { try { await get('/health'); break; } catch (e) { await sleep(100); } }
  const passed = [];
  const ok = name => { passed.push(name); console.log('  ✓', name); };
  try {
    // --- HTTP
    assert.strictEqual((await get('/health')).status, 200); ok('GET /health');
    const idx = await get('/'); assert(idx.status === 200 && idx.body.includes('ROCKET')); ok('GET / serves the game');
    assert.strictEqual((await get('/game.js')).status, 200); assert.strictEqual((await get('/style.css')).status, 200); ok('static assets');
    for (const p of ['/../server.js', '/%2e%2e/server.js', '/match.js', '/package.json', '/..%2fserver.js']) assert.strictEqual((await get(p)).status, 404, p);
    ok('server source / path traversal not served');

    // --- private room, two players
    const A = await new Client('A').open(), B = await new Client('B').open();
    A.send({ type: 'create' });
    const roomA = await A.wait('room'); assert(/^[A-Z2-9]{5}$/.test(roomA.code)); assert.strictEqual(roomA.player, 0);
    ok('create private room returns a 5-char code');
    B.send({ type: 'join', code: roomA.code.toLowerCase() });
    const roomB = await B.wait('room'); assert.strictEqual(roomB.player, 1);
    await A.wait('peer_joined'); await B.wait('peer_joined'); ok('second player joins (case-insensitive code), both notified');
    const C = await new Client('C').open();
    C.send({ type: 'join', code: roomA.code }); assert.match((await C.wait('error')).message, /full/i); ok('third player rejected: room full');
    C.send({ type: 'join', code: 'ZZZZZ' }); assert.match((await C.wait('error')).message, /not found/i); ok('unknown code rejected');
    A.send({ type: 'join', code: roomA.code }); const again = await A.wait('room'); assert.strictEqual(again.player, 0); ok('re-joining own room is idempotent (no duplicate slot)');

    await A.waitPhase('countdown'); await B.waitPhase('playing', 6000); ok('countdown -> playing');
    // sync: same match for both players
    await sleep(300);
    assert.deepStrictEqual(A.last.scores, B.last.scores); assert(Math.abs(A.last.seq - B.last.seq) < 8); assert(Math.abs(A.last.remaining - B.last.remaining) < .3);
    ok('both clients receive the same match state (scores/timer)');
    // input moves the right car; the other stays
    const z0 = [A.last.cars[0].z, A.last.cars[1].z];
    for (let i = 0; i < 20; i++) { A.send({ type: 'input', throttle: 1, steer: 0, boost: false, jump: false }); B.send({ type: 'input', throttle: 0 }); await sleep(33); }
    assert(A.last.cars[0].z < z0[0] - 2, 'A car moved'); assert(Math.abs(A.last.cars[1].z - z0[1]) < .5, 'B car idle');
    assert(Math.abs(B.last.cars[0].z - A.last.cars[0].z) < 3); ok('input from player A moves only car A; B sees the same movement');
    // watchdog: stop sending input; car must brake instead of driving on
    await sleep(1800); const sp = Math.hypot(A.last.cars[0].vx, A.last.cars[0].vz);
    assert(sp < 5 || A.last.cars[0].z < -20, 'car should decelerate after input stops (speed ' + sp + ')'); ok('input watchdog stops a silent client\'s car');
    // robustness: garbage frames
    A.ws.send('not json'); A.ws.send(JSON.stringify({ type: 'input', throttle: 'x', steer: 1e99, boost: {} })); A.ws.send(JSON.stringify([1, 2])); A.ws.send(JSON.stringify({ type: 'join', code: { a: 1 } }));
    await sleep(100); assert(!A.closed); assert.strictEqual((await get('/health')).status, 200); ok('malformed / hostile messages ignored, server alive');
    // match end: A drives at the ball (and into the goal) so a real goal is scored over the wire.
    const t0 = Date.now(); let sawOT = false, padsA = 0, padsB = 0;
    while (Date.now() - t0 < 40000 && !(A.last.phase === 'finished')) {
      const s = A.last, c = s.cars[0], b = s.ball; if (s.overtime) sawOT = true;
      const want = Math.atan2(b.x - c.x, -(b.z - c.z)); let d = want - c.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      A.send({ type: 'input', throttle: 1, steer: Math.max(-1, Math.min(1, d * 3)), boost: Math.abs(d) < .3, jump: false });
      const za = (A.last.pads.match(/0/g) || []).length, zb = (B.last.pads.match(/0/g) || []).length; padsA = Math.max(padsA, za); padsB = Math.max(padsB, zb);
      await sleep(33);
    }
    assert.strictEqual(A.last.pads.length, 34); assert(/^[01]{34}$/.test(B.last.pads)); assert(padsA > 0 && padsB > 0, 'boost pad pickups are visible to both players (' + padsA + '/' + padsB + ')');
    ok('boost pad state is server-driven and identical for both players (34 pads, pickups seen by both)');
    const fa = await A.waitPhase('finished', 1000), fb = await B.waitPhase('finished', 3000);
    assert(fa.scores[0] + fa.scores[1] >= 1, 'a goal was scored through real network play: ' + fa.scores);
    assert.strictEqual(fa.winner, fb.winner); assert.deepStrictEqual(fa.scores, fb.scores); assert.strictEqual(fa.celebration, fb.celebration);
    ok('goal scored over the wire, match finishes, both players see the same result (' + fa.celebration + ' ' + fa.scores.join('-') + (sawOT ? ', via overtime' : '') + ')');
    await A.waitPhase('countdown', 11000); assert.deepStrictEqual(A.last.scores, [0, 0]); ok('match restarts automatically after full time');

    // --- disconnect handling
    B.close(); await A.wait('peer_left'); assert.strictEqual(await rooms(), 1); ok('opponent disconnect: remaining player notified, room kept');
    const D = await new Client('D').open(); D.send({ type: 'join', code: roomA.code });
    assert.strictEqual((await D.wait('room')).player, 1); await A.wait('peer_joined'); await D.wait('peer_joined'); await D.waitPhase('countdown'); ok('reconnect / replacement player can rejoin the same room');
    A.close(); D.close(); await sleep(300); assert.strictEqual(await rooms(), 0); ok('empty room is deleted');
    C.close();

    // --- quick match
    const Q1 = await new Client('Q1').open(), Q2 = await new Client('Q2').open(), Q3 = await new Client('Q3').open();
    Q1.send({ type: 'quick' }); const q1 = await Q1.wait('room');
    Q2.send({ type: 'quick' }); const q2 = await Q2.wait('room'); assert.strictEqual(q1.code, q2.code); assert.strictEqual(q2.player, 1);
    await Q1.wait('peer_joined'); await Q2.wait('peer_joined'); ok('quick match pairs two waiting players');
    Q3.send({ type: 'quick' }); const q3 = await Q3.wait('room'); assert.notStrictEqual(q3.code, q1.code); ok('third quick player gets a fresh waiting room (not a full one)');
    Q3.send({ type: 'join', code: q1.code }); await Q3.wait('error'); ok('cannot join a full quick-match room by code');
    Q1.close(); Q2.close(); Q3.close(); await sleep(300); assert.strictEqual(await rooms(), 0);

    // --- solo vs bot
    const S = await new Client('S').open(); S.send({ type: 'solo' });
    await S.wait('room'); await S.wait('peer_joined'); await S.waitPhase('playing', 6000);
    const bz = S.last.cars[1]; await sleep(2500); const b2 = S.last.cars[1];
    assert(Math.hypot(b2.x - bz.x, b2.z - bz.z) > 3, 'bot drives'); ok('solo: bot joins instantly, match starts, bot drives');
    assert.strictEqual(await rooms(), 1);
    const J = await new Client('J').open(); J.send({ type: 'join', code: 'AAAAA' }); await J.wait('error'); J.close();
    S.send({ type: 'leave' }); await S.wait('left'); await sleep(100); assert.strictEqual(await rooms(), 0); ok('leaving a bot match deletes the room');
    S.close();

    // --- flood protection
    const F = await new Client('F').open(); for (let i = 0; i < 400; i++) F.send({ type: 'ping', sent: i }); for (let i = 0; i < 50 && !F.closed; i++) await sleep(50);
    assert(F.closed, 'flooder disconnected'); assert.strictEqual((await get('/health')).status, 200); ok('message flood disconnects the client, server survives');
    assert.strictEqual(serverErr, '', 'server stderr must be empty: ' + serverErr);
    ok('no server errors logged');
    console.log(`\nnetwork tests: ${passed.length} passed`);
  } catch (e) { console.error('\nFAILED:', e.stack || e); console.error(serverErr); process.exitCode = 1; }
  finally { srv.kill(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
})();
