const express = require('express');
const db = require('../db');

const router = express.Router();

// 당일 시가: 오늘 첫 시세로그의 prev, 없으면 전체 첫 로그, 그것도 없으면 현재가
function dayOpen(code, cur) {
  let r = db.prepare(
    "SELECT prev FROM price_logs WHERE stock_code = ? AND date(created_at) = date('now','localtime') ORDER BY id LIMIT 1"
  ).get(code);
  if (!r) r = db.prepare('SELECT prev FROM price_logs WHERE stock_code = ? ORDER BY id LIMIT 1').get(code);
  return r ? r.prev : cur;
}

function withDay(s) {
  const open = dayOpen(s.code, s.cur_price);
  return { ...s, day_open: open, day_rate: open ? (s.cur_price - open) / open : 0 };
}

// GET /api/stocks?q= 목록 (태그·당일등락 포함)
router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  let rows;
  if (q) {
    rows = db.prepare(
      `SELECT code, name, cur_price, status, tags, updated_at FROM stocks
       WHERE code LIKE ? OR name LIKE ? OR tags LIKE ? ORDER BY code`
    ).all(`%${q}%`, `%${q}%`, `%${q}%`);
  } else {
    rows = db.prepare(
      'SELECT code, name, cur_price, status, tags, updated_at FROM stocks ORDER BY code'
    ).all();
  }
  res.json(rows.map(withDay));
});

// GET /api/stocks/:code/history?limit=60&before=ISO시간 (가격 그래프용)
// before 이전 기록만 반환 → 차트 팬/이전보기 페이징용. hasMore로 계속 로드 가능.
router.get('/:code/history', (req, res) => {
  const s = db.prepare('SELECT code, cur_price FROM stocks WHERE code = ?').get(req.params.code);
  if (!s) return res.status(404).json({ error: 'NOT_FOUND' });
  let limit = Number(req.query.limit) || 200;
  if (limit < 2) limit = 2;
  if (limit > 2000) limit = 2000;
  const before = (req.query.before || '').trim();
  let logs;
  if (before) {
    logs = db.prepare(
      "SELECT id, prev, next, created_at FROM price_logs WHERE stock_code = ? AND created_at < ? ORDER BY id DESC LIMIT ?"
    ).all(s.code, before, limit).reverse();
  } else {
    logs = db.prepare(
      'SELECT id, prev, next, created_at FROM price_logs WHERE stock_code = ? ORDER BY id DESC LIMIT ?'
    ).all(s.code, limit).reverse();
  }
  const total = db.prepare('SELECT COUNT(*) AS c FROM price_logs WHERE stock_code = ?').get(s.code).c;
  let points;
  if (!logs.length) {
    points = before ? [] : [{ price: s.cur_price, at: new Date().toISOString(), id: null }];
  } else {
    points = [{ price: logs[0].prev, at: logs[0].created_at, id: logs[0].id }, ...logs.map((l) => ({ price: l.next, at: l.created_at, id: l.id }))];
  }
  const hasMore = logs.length > 0 && total > logs.length && !!db.prepare(
    'SELECT 1 FROM price_logs WHERE stock_code = ? AND id < ? LIMIT 1'
  ).get(s.code, logs[0].id);
  res.json({ code: s.code, cur_price: s.cur_price, points, hasMore: !!hasMore, oldestAt: logs.length ? logs[0].created_at : null });
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
  const s = db.prepare('SELECT code, name, cur_price, status, tags, updated_at FROM stocks WHERE code = ?')
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
  res.json({ ...withDay(s), isHolder, qty, avg_price });
});

module.exports = router;
