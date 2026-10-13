const express = require('express');
const db = require('../db');
const { dayOpen, circuitState } = require('../circuit');
const { kNow } = require('../ktime');

const router = express.Router();

function withDay(s) {
  const open = dayOpen(s.code, s.cur_price);
  const cb = circuitState(s.code);
  return { ...s, day_open: open, day_rate: open ? (s.cur_price - open) / open : 0, halted: cb ? cb.halted : false, paused: cb ? cb.paused : false };
}

// 표시용 거래량 = 실체결 + 가상 (상세 차트 막대와 같은 공식: 5분 버킷별 확정 난수)
function displayVol(code, isBlue, realVol) {
  const rows = db.prepare(
    'SELECT next, created_at FROM price_logs WHERE stock_code = ? ORDER BY id DESC LIMIT 400'
  ).all(code);
  if (!rows.length) return realVol;
  const B = 300;
  const ts = (s) => new Date(String(s).replace(' ', 'T')).getTime();
  const map = new Map();
  for (const p of rows) {
    const t = ts(p.created_at);
    if (isNaN(t)) continue;
    const b = Math.floor(t / 1000 / B) * B;
    if (!map.has(b)) map.set(b, []);
    map.get(b).push(p.next);
  }
  const baseVol = isBlue ? 1500 : 120;
  let virt = 0;
  for (const [b, ps] of map) {
    const o = ps[ps.length - 1], c = ps[0];
    const r = Math.abs(Math.sin(b * 12.9898) * 43758.5453) % 1;
    const rangePct = o ? Math.abs(c - o) / o : 0;
    virt += Math.round(baseVol * (0.5 + r) * (1 + Math.min(3, rangePct * 80)));
  }
  return realVol + virt;
}

// GET /api/stocks?q= 목록 (태그·당일등락·실거래량 포함)
router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  const base = `SELECT s.code, s.name, s.cur_price, s.status, s.tags, s.stock_type, s.dividend, s.listed_shares, s.updated_at,
      COALESCE(v.tv, 0) AS vol, COALESCE(v.tover, 0) AS turnover, COALESCE(v.tc, 0) AS trades
    FROM stocks s LEFT JOIN (
      SELECT stock_code, SUM(qty) AS tv, SUM(qty * price) AS tover, COUNT(*) AS tc
      FROM transactions GROUP BY stock_code
    ) v ON v.stock_code = s.code`;
  let rows;
  if (q) {
    rows = db.prepare(
      `${base} WHERE s.delist_type IS NULL AND (s.code LIKE ? OR s.name LIKE ? OR s.tags LIKE ?) ORDER BY s.code`
    ).all(`%${q}%`, `%${q}%`, `%${q}%`);
  } else {
    rows = db.prepare(`${base} WHERE s.delist_type IS NULL ORDER BY s.code`).all();
  }
  res.json(rows.map((r) => {
    const w = withDay(r);
    w.dvol = displayVol(r.code, r.stock_type === 'bluechip', r.vol || 0);
    return w;
  }));
});

// GET /api/stocks/:code/history?limit=60 (가격 그래프용, 최근 N 포인트)
router.get('/:code/history', (req, res) => {
  const s = db.prepare('SELECT code, cur_price FROM stocks WHERE code = ?').get(req.params.code);
  if (!s) return res.status(404).json({ error: 'NOT_FOUND' });
  let limit = Number(req.query.limit) || 60;
  if (limit < 2) limit = 2;
  if (limit > 600) limit = 600;
  const logs = db.prepare(
    'SELECT prev, next, created_at FROM price_logs WHERE stock_code = ? ORDER BY id DESC LIMIT ?'
  ).all(s.code, limit).reverse();
  let points;
  if (!logs.length) {
    points = [{ price: s.cur_price, at: kNow().replace(' ', 'T') + '+09:00' }];
  } else {
    points = [{ price: logs[0].prev, at: logs[0].created_at }, ...logs.map((l) => ({ price: l.next, at: l.created_at }))];
  }
  res.json({ code: s.code, cur_price: s.cur_price, points });
});

// GET /api/stocks/:code/trades?limit=30 (최근 체결 테이프, 익명: 가격·수량·방향·시간만)
router.get('/:code/trades', (req, res) => {
  const s = db.prepare('SELECT code FROM stocks WHERE code = ?').get(req.params.code);
  if (!s) return res.status(404).json({ error: 'NOT_FOUND' });
  let limit = Number(req.query.limit) || 30;
  if (limit < 1) limit = 1;
  if (limit > 200) limit = 200;
  const rows = db.prepare(
    'SELECT price, qty, side, created_at FROM transactions WHERE stock_code = ? ORDER BY id DESC LIMIT ?'
  ).all(s.code, limit);
  res.json({ code: s.code, trades: rows });
});

// GET /api/stocks/:code/events (공개: 최근 이벤트 20, 차트 거래량 부스트용)
router.get('/:code/events', (req, res) => {
  const s = db.prepare('SELECT code FROM stocks WHERE code = ?').get(req.params.code);
  if (!s) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(db.prepare(
    'SELECT id, stock_code, type, rate, status, reason, start_at, end_at FROM stock_events WHERE stock_code = ? ORDER BY id DESC LIMIT 20'
  ).all(s.code));
});

// GET /api/stocks/:code 상세 (현재가 + 보유뱃지용 + 태그 + 당일등락)
router.get('/:code', (req, res) => {
  const s = db.prepare('SELECT code, name, cur_price, status, tags, stock_type, dividend, listed_shares, delist_type, updated_at FROM stocks WHERE code = ?')
    .get(req.params.code);
  if (!s) return res.status(404).json({ error: 'NOT_FOUND' });
  let isHolder = false;
  let qty = 0;
  let avg_price = null;
  if (req.session && req.session.userId) {
    const h = db.prepare('SELECT qty, avg_price FROM holdings WHERE user_id = ? AND stock_code = ?')
      .get(req.session.userId, s.code);
    if (h) {
      isHolder = true;
      qty = h.qty;
      avg_price = h.avg_price;
    }
  }
  res.json({ ...withDay(s), cb: circuitState(s.code), isHolder, qty, avg_price });
});

module.exports = router;
