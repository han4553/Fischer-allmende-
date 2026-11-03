/* FischGründe – Mehrspieler-Server (Vercel Function + Upstash Redis).
   Umgebungsvariablen (kommen automatisch, wenn in Vercel "Upstash Redis" mit dem Projekt verbunden wird):
   KV_REST_API_URL + KV_REST_API_TOKEN   (oder UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) */
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 60 * 60 * 12;
async function R(...cmd) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer ' + TOK, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
const hash = (arr) => { const o = {}; for (let i = 0; i < (arr || []).length; i += 2) o[arr[i]] = arr[i + 1]; return o; };
const rnd = (n) => Array.from({ length: n }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
const clean = (s, n) => String(s || '').replace(/[<>]/g, '').slice(0, n).trim();
const J = (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (!URL_ || !TOK) return res.status(500).json({ error: 'Redis nicht verbunden (KV_REST_API_URL fehlt)' });
    const q = req.query || {};
    let b = req.body;
    if (typeof b === 'string') b = J(b, {});
    b = b || {};
    const a = b.a || q.a;
    const code = clean(b.code || q.code, 6).toUpperCase();
    const key = 'fg:' + code;

    if (a === 'time') { res.setHeader('Cache-Control', 'no-store'); return res.json({ now: Date.now() }); }

    if (a === 'create') {
      let c, ok = 0;
      for (let i = 0; i < 8 && !ok; i++) { c = rnd(4); ok = await R('HSETNX', 'fg:' + c, 'meta', JSON.stringify({ state: 'lobby', v: 1, cfg: b.cfg || {} })); }
      if (!ok) return res.status(503).json({ error: 'Kein freier Code' });
      const hk = rnd(16);
      await R('HSET', 'fg:' + c, 'hk', hk);
      await R('EXPIRE', 'fg:' + c, TTL);
      return res.json({ code: c, hk, now: Date.now() });
    }

    const raw = await R('HGETALL', key);
    const h = hash(raw);
    if (!h.meta) return res.status(404).json({ error: 'Raum nicht gefunden' });
    const meta = J(h.meta, {});

    if (a === 'state') { // öffentlich, darf kurz gecacht werden
      res.setHeader('Cache-Control', 'public, s-maxage=1, stale-while-revalidate=2');
      const n = Object.keys(h).filter((k) => k[0] === 'p' && k[1] === ':').length;
      return res.json({ now: Date.now(), meta, n });
    }
    if (a === 'join') {
      if (meta.state !== 'lobby') {
        const old = b.id && h['p:' + b.id];
        if (old) return res.json({ id: b.id, now: Date.now() });
        return res.status(409).json({ error: 'Das Spiel läuft schon' });
      }
      const n = Object.keys(h).filter((k) => k.startsWith('p:')).length;
      if (n >= 30) return res.status(409).json({ error: 'Die Lobby ist voll (30)' });
      const id = b.id && h['p:' + b.id] ? b.id : String(await R('HINCRBY', key, 'n', 1));
      const boat = J(JSON.stringify(b.boat || {}), {});
      const prev = J(h['p:' + id], {});
      await R('HSET', key, 'p:' + id, JSON.stringify({ id, name: clean(b.name, 16) || 'Fischer', alias: prev.alias || '', boat }));
      return res.json({ id, now: Date.now() });
    }
    if (a === 'report') {
      const id = clean(b.id, 6);
      if (!h['p:' + id]) return res.status(403).json({ error: 'unbekannt' });
      const r = b.rep || {};
      const rep = { fish: Math.max(0, Math.min(200, Math.round(+r.fish || 0))), gold: Math.max(0, Math.min(200, Math.round(+r.gold || 0))), income: Math.max(0, Math.min(5000, Math.round(+r.income || 0))), fine: Math.max(0, Math.min(5000, Math.round(+r.fine || 0))), viol: !!r.viol, eco: !!r.eco, caught: !!r.caught, sneaky: !!r.sneaky, poach: Math.max(0, Math.min(200, Math.round(+r.poach || 0))) };
      await R('HSET', key, 'r:' + (+b.ph || 0) + ':' + (+b.rd || 0) + ':' + id, JSON.stringify(rep));
      return res.json({ ok: 1 });
    }

    // ab hier nur Lehrer
    if (b.hk !== h.hk) return res.status(403).json({ error: 'Kein Lehrer-Schlüssel' });
    if (a === 'hstate') {
      res.setHeader('Cache-Control', 'no-store');
      const players = [], reports = {};
      for (const k of Object.keys(h)) {
        if (k.startsWith('p:')) players.push(J(h[k], null));
        else if (k.startsWith('r:')) { const [, ph, rd, id] = k.split(':'); (reports[ph + ':' + rd] = reports[ph + ':' + rd] || {})[id] = J(h[k], {}); }
      }
      players.sort((x, y) => +x.id - +y.id);
      return res.json({ now: Date.now(), meta, players: players.filter(Boolean), reports });
    }
    if (a === 'set') {
      const next = Object.assign({}, meta, b.patch || {}, { v: (meta.v || 0) + 1 });
      await R('HSET', key, 'meta', JSON.stringify(next));
      return res.json({ ok: 1, v: next.v, now: Date.now() });
    }
    if (a === 'alias') {
      const p = J(h['p:' + b.id], null);
      if (!p) return res.status(404).json({ error: 'unbekannt' });
      p.alias = clean(b.alias, 16);
      await R('HSET', key, 'p:' + b.id, JSON.stringify(p));
      return res.json({ ok: 1 });
    }
    if (a === 'kick') { await R('HDEL', key, 'p:' + b.id); return res.json({ ok: 1 }); }
    return res.status(400).json({ error: 'unbekannte Aktion' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
