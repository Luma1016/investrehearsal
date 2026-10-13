const express = require('express');
const db = require('../db');
const { dayOpen, circuitState } = require('../circuit');

const router = express.Router();

function withDay(s) {
  const open = dayOpen(s.code, s.cur_price);
  const cb = circuitState(s.code);
  return { ...s, day_open: open, day_rate: open ? (s.cur_price - open) / open : 0, halted: cb ? cb.halted : false, paused: cb ? cb.paused : false };
}

// GET /api/stocks?q= 목록 (태그·당일등락 포함)
router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  let rows;
  if (q) {
    rows = db.prepare(
      `SELECT code, name, cur_price, status, tags, stock_type, updated_at FROM stocks
       WHERE code LIKE ? OR name LIKE ? OR tags LIKE ? ORDER BY code`
    ).all(`%${q}%`, `%${q}%`, `%${q}%`);
  } else {
    rows = db.prepare(
      'SELECT code, name, cur_price, status, tags, stock_type, updated_at FROM stocks ORDER BY code'
    ).all();
  }
  res.json(rows.map(withDay));
});

// GET /api/stocks/:code/history?limit=60 (가격 그래프용, 최근 N 포인트)
router.get('/:code/history', (req, res) => {
  const s = db.prepare('SELECT code, cur_price FROM stocks WHERE code = ?').get(req.params.code);
  if (!s) return res.status(404).json({ error: 'NOT_FOUND' });
  let limit = Number(req.query.limit) || 60;
  if (limit < 2) limit = 2;
  if (limit > 200) limit = 200;
  const logs = db.prepare(
    'SELECT prev, next, created_at FROM price_logs WHERE stock_code = ? ORDER BY id DESC LIMIT ?'
  ).all(s.code, limit).reverse();
  let points;
  if (!logs.length) {
    points = [{ price: s.cur_price, at: new Date().toISOString() }];
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

// GET /api/stocks/:code 상세 (현재가 + 보유뱃지용 + 태그 + 당일등락)
router.get('/:code', (req, res) => {
  const s = db.prepare('SELECT code, name, cur_price, status, tags, stock_type, updated_at FROM stocks WHERE code = ?')
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
