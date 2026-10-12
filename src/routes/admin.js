const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware');

const router = express.Router();
router.use(requireAdmin);

const EVENT_TYPES = ['급등', '급락', '정지', '배당'];

function autoNotice({ scope, stock_code, title, body, by_admin }) {
  db.prepare(
    'INSERT INTO notices (scope, stock_code, title, body, pinned, by_admin) VALUES (?,?,?,?,0,?)'
  ).run(scope, stock_code || null, title, body, by_admin);
}

// GET /api/admin/summary (가입자, 거래수, 블라인드수, 진행중 이벤트)
router.get('/summary', (req, res) => {
  const users = db.prepare("SELECT COUNT(*) AS c FROM users WHERE status = '정상'").get().c;
  const trades = db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c;
  const blinded = db.prepare("SELECT COUNT(*) AS c FROM posts WHERE status = '블라인드'").get().c;
  const liveEvents = db.prepare("SELECT COUNT(*) AS c FROM stock_events WHERE status IN ('예약','진행중')").get().c;
  res.json({ users, trades, blinded, liveEvents });
});

// GET /api/admin/users
router.get('/users', (req, res) => {
  const rows = db.prepare(
    `SELECT u.id, u.email, u.nickname, u.role, u.status, u.created_at, a.cash
     FROM users u LEFT JOIN accounts a ON a.user_id = u.id ORDER BY u.id`
  ).all();
  res.json(rows);
});

// PUT /api/admin/users/:id/stop (정지, body.status=정지/정상으로 복구도 허용)
router.put('/users/:id/stop', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'NOT_FOUND' });
  if (u.role === 'ADMIN') return res.status(403).json({ error: 'FORBIDDEN' });
  const status = req.body && req.body.status === '정상' ? '정상' : '정지';
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, u.id);
  res.json({ ok: true, status });
});

// POST /api/admin/notices {scope, stock_code?, title, body, pinned?}
router.post('/notices', (req, res) => {
  const { scope, stock_code, title, body, pinned } = req.body || {};
  if (!['전체', '종목'].includes(scope)) return res.status(400).json({ error: 'INVALID_SCOPE' });
  if (!title || !body || String(title).trim().length < 1 || String(body).trim().length < 1) {
    return res.status(400).json({ error: 'INVALID_INPUT' });
  }
  if (scope === '종목') {
    if (!stock_code) return res.status(400).json({ error: 'INVALID_INPUT' });
    const s = db.prepare('SELECT code FROM stocks WHERE code = ?').get(stock_code);
    if (!s) return res.status(404).json({ error: 'NOT_FOUND' });
  }
  const r = db.prepare(
    'INSERT INTO notices (scope, stock_code, title, body, pinned, by_admin) VALUES (?,?,?,?,?,?)'
  ).run(scope, stock_code || null, String(title).trim(), String(body).trim(), pinned ? 1 : 0, req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM notices WHERE id = ?').get(r.lastInsertRowid));
});

// DELETE /api/admin/notices/:id
router.delete('/notices/:id', (req, res) => {
  const n = db.prepare('SELECT * FROM notices WHERE id = ?').get(req.params.id);
  if (!n) return res.status(404).json({ error: 'NOT_FOUND' });
  db.prepare('DELETE FROM notices WHERE id = ?').run(n.id);
  res.json({ ok: true });
});

// POST /api/admin/posts/:id/blind | unblind
router.post('/posts/:id/blind', (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'NOT_FOUND' });
  db.prepare("UPDATE posts SET status = '블라인드' WHERE id = ?").run(p.id);
  res.json({ ok: true });
});

router.post('/posts/:id/unblind', (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'NOT_FOUND' });
  db.prepare("UPDATE posts SET status = '정상' WHERE id = ?").run(p.id);
  res.json({ ok: true });
});

// DELETE /api/admin/posts/:id
router.delete('/posts/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'NOT_FOUND' });
  db.prepare('DELETE FROM posts WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

// GET /api/admin/events
router.get('/events', (req, res) => {
  res.json(db.prepare('SELECT * FROM stock_events ORDER BY id DESC LIMIT 100').all());
});

// POST /api/admin/events {code,type,rate,start_at,end_at,reason} (즉시/예약)
router.post('/events', (req, res) => {
  const { code, type, rate, start_at, end_at, reason } = req.body || {};
  if (!code || !EVENT_TYPES.includes(type) || rate === undefined || isNaN(Number(rate))) {
    return res.status(400).json({ error: 'INVALID_INPUT' });
  }
  const s = db.prepare('SELECT code FROM stocks WHERE code = ?').get(code);
  if (!s) return res.status(404).json({ error: 'NOT_FOUND' });
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const status = !start_at || start_at <= now ? '진행중' : '예약';
  const r = db.prepare(
    'INSERT INTO stock_events (stock_code, type, rate, status, reason, by_admin, start_at, end_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(code, type, Number(rate), status, reason || null, req.user.id, start_at || null, end_at || null);
  autoNotice({
    scope: '종목',
    stock_code: code,
    title: `[공시] ${code} ${type} 이벤트 (${status})`,
    body: reason || `${type} 이벤트가 등록되었습니다.`,
    by_admin: req.user.id,
  });
  res.status(201).json(db.prepare('SELECT * FROM stock_events WHERE id = ?').get(r.lastInsertRowid));
});

// POST /api/admin/events/:id/cancel
router.post('/events/:id/cancel', (req, res) => {
  const e = db.prepare('SELECT * FROM stock_events WHERE id = ?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'NOT_FOUND' });
  db.prepare("UPDATE stock_events SET status = '종료' WHERE id = ?").run(e.id);
  res.json({ ok: true });
});

// GET /api/admin/stocks (관리자 종목관리 목록: 보유자수·거래량 포함)
router.get('/stocks', (req, res) => {
  const rows = db.prepare(
    `SELECT s.code, s.name, s.cur_price, s.status, s.updated_at,
       (SELECT COUNT(*) FROM holdings h WHERE h.stock_code = s.code) AS holders,
       (SELECT COALESCE(SUM(qty),0) FROM transactions t WHERE t.stock_code = s.code) AS total_vol
     FROM stocks s ORDER BY s.code`
  ).all();
  res.json(rows);
});

// POST /api/admin/stocks {code, name, cur_price} (신규 종목 추가 + SEED 로그 + 자동공시)
router.post('/stocks', (req, res) => {
  const { code, name, cur_price } = req.body || {};
  const c = String(code || '').trim().toUpperCase();
  const n = String(name || '').trim();
  const price = cur_price === undefined ? 10000 : cur_price;
  if (!/^[A-Z0-9]{2,10}$/.test(c)) return res.status(400).json({ error: 'INVALID_CODE' });
  if (n.length < 1 || n.length > 30) return res.status(400).json({ error: 'INVALID_NAME' });
  if (!Number.isInteger(price) || price < 100) return res.status(400).json({ error: 'INVALID_PRICE' });
  if (db.prepare('SELECT code FROM stocks WHERE code = ?').get(c)) {
    return res.status(409).json({ error: 'ALREADY_EXISTS' });
  }
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO stocks (code, name, cur_price, status) VALUES (?,?,?,?)')
      .run(c, n, price, '정상');
    db.prepare('INSERT INTO price_logs (stock_code, prev, next, cause, by_admin) VALUES (?,?,?,\'SEED\',?)')
      .run(c, price, price, req.user.id);
  });
  tx();
  autoNotice({
    scope: '종목',
    stock_code: c,
    title: `[공시] ${c} 신규 상장`,
    body: `관리자가 신규 종목 ${n}(${c})을 ${price}원에 상장했습니다.`,
    by_admin: req.user.id,
  });
  res.status(201).json(db.prepare('SELECT code, name, cur_price, status, updated_at FROM stocks WHERE code = ?').get(c));
});

// PUT /api/admin/stocks/:code {name?, status?} (이름 수정/정상·정지 관리 + 자동공시)
router.put('/stocks/:code', (req, res) => {
  const s = db.prepare('SELECT * FROM stocks WHERE code = ?').get(req.params.code);
  if (!s) return res.status(404).json({ error: 'NOT_FOUND' });
  const { name, status } = req.body || {};
  const updates = [];
  const params = [];
  let renamed = null;
  let statusChanged = null;
  if (name !== undefined) {
    const n = String(name).trim();
    if (n.length < 1 || n.length > 30) return res.status(400).json({ error: 'INVALID_NAME' });
    if (n !== s.name) {
      updates.push('name = ?');
      params.push(n);
      renamed = [s.name, n];
    }
  }
  if (status !== undefined) {
    if (!['정상', '정지'].includes(status)) return res.status(400).json({ error: 'INVALID_STATUS' });
    if (status !== s.status) {
      updates.push('status = ?');
      params.push(status);
      statusChanged = [s.status, status];
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'NO_CHANGES' });
  updates.push("updated_at = datetime('now','localtime')");
  db.prepare(`UPDATE stocks SET ${updates.join(', ')} WHERE code = ?`).run(...params, s.code);
  const desc = [
    renamed ? `이름 ${renamed[0]} → ${renamed[1]}` : null,
    statusChanged ? `상태 ${statusChanged[0]} → ${statusChanged[1]}` : null,
  ].filter(Boolean).join(', ');
  autoNotice({
    scope: '종목',
    stock_code: s.code,
    title: `[공시] ${s.code} 종목 정보 변경`,
    body: `관리자가 ${s.code} 정보를 변경했습니다. (${desc})`,
    by_admin: req.user.id,
  });
  res.json(db.prepare('SELECT code, name, cur_price, status, updated_at FROM stocks WHERE code = ?').get(s.code));
});

// POST /api/admin/stocks/:code/price {price, reason?} (직접조작 + price_logs + 자동공시)
router.post('/stocks/:code/price', (req, res) => {
  const { price, reason } = req.body || {};
  if (!Number.isInteger(price) || price < 1) return res.status(400).json({ error: 'INVALID_PRICE' });
  const s = db.prepare('SELECT * FROM stocks WHERE code = ?').get(req.params.code);
  if (!s) return res.status(404).json({ error: 'NOT_FOUND' });
  const tx = db.transaction(() => {
    db.prepare("UPDATE stocks SET cur_price = ?, updated_at = datetime('now','localtime') WHERE code = ?")
      .run(price, s.code);
    db.prepare('INSERT INTO price_logs (stock_code, prev, next, cause, by_admin) VALUES (?,?,?,\'ADMIN\',?)')
      .run(s.code, s.cur_price, price, req.user.id);
  });
  tx();
  autoNotice({
    scope: '종목',
    stock_code: s.code,
    title: `[공시] ${s.code} 가격 조정`,
    body: `관리자가 ${s.cur_price}원 → ${price}원으로 조정. 사유: ${reason || '-'}`,
    by_admin: req.user.id,
  });
  res.json({ ok: true, prev: s.cur_price, next: price });
});

// GET /api/admin/price-logs?cause=ADMIN (조작로그, 미지정시 전체)
router.get('/price-logs', (req, res) => {
  const { cause } = req.query;
  if (cause) {
    return res.json(db.prepare('SELECT * FROM price_logs WHERE cause = ? ORDER BY id DESC LIMIT 100').all(cause));
  }
  res.json(db.prepare('SELECT * FROM price_logs ORDER BY id DESC LIMIT 100').all());
});

module.exports = router;
