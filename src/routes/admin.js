const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware');
const { kNow, kPlusMinutes } = require('../ktime');

const router = express.Router();
router.use(requireAdmin);

const EVENT_TYPES = ['급등', '급락', '정지', '배당'];

function autoNotice({ scope, stock_code, title, body, by_admin, expires_at }) {
  db.prepare(
    'INSERT INTO notices (scope, stock_code, title, body, pinned, by_admin, expires_at) VALUES (?,?,?,?,0,?,?)'
  ).run(scope, stock_code || null, title, body, by_admin, expires_at || null);
}

function plusMinutes(iso, mins) {
  return kPlusMinutes(iso, mins);
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

// GET /api/admin/notices (관리자 공시/공지 목록: 수정·삭제용)
router.get('/notices', (req, res) => {
  res.json(db.prepare('SELECT * FROM notices ORDER BY pinned DESC, id DESC LIMIT 100').all());
});

// PUT /api/admin/notices/:id {title?, body?, scope?, stock_code?, pinned?}
router.put('/notices/:id', (req, res) => {
  const n = db.prepare('SELECT * FROM notices WHERE id = ?').get(req.params.id);
  if (!n) return res.status(404).json({ error: 'NOT_FOUND' });
  const { title, body, scope, stock_code, pinned } = req.body || {};
  const updates = [];
  const params = [];
  if (title !== undefined) {
    if (String(title).trim().length < 1) return res.status(400).json({ error: 'INVALID_INPUT' });
    updates.push('title = ?');
    params.push(String(title).trim());
  }
  if (body !== undefined) {
    if (String(body).trim().length < 1) return res.status(400).json({ error: 'INVALID_INPUT' });
    updates.push('body = ?');
    params.push(String(body).trim());
  }
  if (scope !== undefined) {
    if (!['전체', '종목'].includes(scope)) return res.status(400).json({ error: 'INVALID_SCOPE' });
    updates.push('scope = ?');
    params.push(scope);
  }
  if (stock_code !== undefined) {
    const sc = stock_code ? String(stock_code).trim() : null;
    if (sc) {
      const s = db.prepare('SELECT code FROM stocks WHERE code = ?').get(sc);
      if (!s) return res.status(404).json({ error: 'NOT_FOUND' });
    }
    updates.push('stock_code = ?');
    params.push(sc || null);
  }
  if (pinned !== undefined) {
    updates.push('pinned = ?');
    params.push(pinned ? 1 : 0);
  }
  if (!updates.length) return res.status(400).json({ error: 'NO_CHANGES' });
  db.prepare(`UPDATE notices SET ${updates.join(', ')} WHERE id = ?`).run(...params, n.id);
  res.json(db.prepare('SELECT * FROM notices WHERE id = ?').get(n.id));
});

// DELETE /api/admin/notices/:id
router.delete('/notices/:id', (req, res) => {
  const n = db.prepare('SELECT * FROM notices WHERE id = ?').get(req.params.id);
  if (!n) return res.status(404).json({ error: 'NOT_FOUND' });
  db.prepare('DELETE FROM notices WHERE id = ?').run(n.id);
  res.json({ ok: true });
});

// GET /api/admin/indices (지수 정의 목록)
router.get('/indices', (req, res) => {
  res.json(db.prepare('SELECT * FROM indices ORDER BY id').all());
});

// POST /api/admin/indices {name, kind?, tag?, base_value?} (지수 추가)
router.post('/indices', (req, res) => {
  const { name, kind, tag, base_value } = req.body || {};
  const n = String(name || '').trim();
  if (!n || n.length > 30) return res.status(400).json({ error: 'INVALID_NAME' });
  const k = kind || '전체';
  if (!['전체', '태그', '대장주'].includes(k)) return res.status(400).json({ error: 'INVALID_KIND' });
  const t = String(tag || '').trim().slice(0, 100);
  if (k === '태그' && !t) return res.status(400).json({ error: 'TAG_REQUIRED' });
  const base = base_value === undefined ? 1000 : Number(base_value);
  if (!Number.isFinite(base) || base < 1 || base > 1000000) return res.status(400).json({ error: 'INVALID_BASE' });
  const r = db.prepare('INSERT INTO indices (name, kind, tag, base_value) VALUES (?,?,?,?)')
    .run(n, k, t, base);
  res.status(201).json(db.prepare('SELECT * FROM indices WHERE id = ?').get(r.lastInsertRowid));
});

// PUT /api/admin/indices/:id {name?, kind?, tag?, base_value?} (지수 수정)
router.put('/indices/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM indices WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
  const { name, kind, tag, base_value } = req.body || {};
  const updates = [];
  const params = [];
  let nk = row.kind, nt = row.tag;
  if (name !== undefined) {
    const n = String(name).trim();
    if (!n || n.length > 30) return res.status(400).json({ error: 'INVALID_NAME' });
    updates.push('name = ?');
    params.push(n);
  }
  if (kind !== undefined) {
    if (!['전체', '태그', '대장주'].includes(kind)) return res.status(400).json({ error: 'INVALID_KIND' });
    updates.push('kind = ?');
    params.push(kind);
    nk = kind;
  }
  if (tag !== undefined) {
    nt = String(tag).trim().slice(0, 100);
    updates.push('tag = ?');
    params.push(nt);
  }
  if (nk === '태그' && !nt) return res.status(400).json({ error: 'TAG_REQUIRED' });
  if (base_value !== undefined) {
    const base = Number(base_value);
    if (!Number.isFinite(base) || base < 1 || base > 1000000) return res.status(400).json({ error: 'INVALID_BASE' });
    updates.push('base_value = ?');
    params.push(base);
  }
  if (!updates.length) return res.status(400).json({ error: 'NO_CHANGES' });
  db.prepare(`UPDATE indices SET ${updates.join(', ')} WHERE id = ?`).run(...params, row.id);
  res.json(db.prepare('SELECT * FROM indices WHERE id = ?').get(row.id));
});

// DELETE /api/admin/indices/:id (지수 삭제)
router.delete('/indices/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM indices WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
  db.prepare('DELETE FROM indices WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// GET /api/admin/volumes (실거래량: 가상 제외, 실제 체결 기준 종목별·사용자별)
router.get('/volumes', (req, res) => {
  const byStock = db.prepare(
    `SELECT t.stock_code AS code, s.name,
       COALESCE(SUM(CASE WHEN t.side = 'BUY' THEN t.qty ELSE 0 END), 0) AS buy_vol,
       COALESCE(SUM(CASE WHEN t.side = 'SELL' THEN t.qty ELSE 0 END), 0) AS sell_vol,
       COUNT(*) AS trades,
       COALESCE(SUM(t.qty * t.price), 0) AS turnover
     FROM transactions t LEFT JOIN stocks s ON s.code = t.stock_code
     GROUP BY t.stock_code ORDER BY turnover DESC`
  ).all();
  const byUser = db.prepare(
    `SELECT t.user_id AS id, u.nickname, u.status,
       COALESCE(SUM(CASE WHEN t.side = 'BUY' THEN t.qty ELSE 0 END), 0) AS buy_vol,
       COALESCE(SUM(CASE WHEN t.side = 'SELL' THEN t.qty ELSE 0 END), 0) AS sell_vol,
       COUNT(*) AS trades,
       COALESCE(SUM(t.qty * t.price), 0) AS turnover
     FROM transactions t LEFT JOIN users u ON u.id = t.user_id
     GROUP BY t.user_id ORDER BY turnover DESC LIMIT 100`
  ).all().map((r) => ({ ...r, nickname: r.status === '탈퇴' ? '탈퇴회원' : (r.nickname || '알수없음') }));
  res.json({ byStock, byUser });
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
  const now = kNow(); // KST
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
    expires_at: end_at ? plusMinutes(end_at, 5) : null, // 종료 5분 뒤 속보 만료
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

// POST /api/admin/news/fire (랜덤 뉴스 즉시 1건 발생, 테스트/운영용)
router.post('/news/fire', (req, res) => {
  const { fireNews, fireThemeNews } = require('../news');
  const body = req.body || {};
  const n = body.theme ? fireThemeNews({ tag: body.tag, type: body.type, rate: body.rate, mins: body.mins }) : fireNews();
  if (n === 'NO_SUCH_TAG') return res.status(404).json({ error: 'NOT_FOUND' });
  if (!n) return res.status(429).json({ error: 'SKIPPED' });
  res.status(201).json(n);
});

// GET /api/admin/stocks (관리자 종목관리 목록: 보유자수·거래량·태그 포함)
router.get('/stocks', (req, res) => {
  const rows = db.prepare(
    `SELECT s.code, s.name, s.cur_price, s.status, s.tags, s.stock_type, s.dividend, s.updated_at,
       (SELECT COUNT(*) FROM holdings h WHERE h.stock_code = s.code) AS holders,
       (SELECT COALESCE(SUM(qty),0) FROM transactions t WHERE t.stock_code = s.code) AS total_vol
     FROM stocks s ORDER BY s.code`
  ).all();
  res.json(rows);
});

// POST /api/admin/stocks {code, name, cur_price, tags?, stock_type?, dividend?} (신규 종목 추가 + SEED 로그 + 자동공시)
router.post('/stocks', (req, res) => {
  const { code, name, cur_price, tags, stock_type, dividend } = req.body || {};
  const c = String(code || '').trim().toUpperCase();
  const n = String(name || '').trim();
  const price = cur_price === undefined ? 10000 : cur_price;
  if (!/^[A-Z0-9]{2,10}$/.test(c)) return res.status(400).json({ error: 'INVALID_CODE' });
  if (n.length < 1 || n.length > 30) return res.status(400).json({ error: 'INVALID_NAME' });
  if (!Number.isInteger(price) || price < 100) return res.status(400).json({ error: 'INVALID_PRICE' });
  const tag = tags === undefined ? '일반' : String(tags).trim().slice(0, 100);
  const stype = stock_type === 'bluechip' ? 'bluechip' : 'normal';
  const div = dividend === undefined ? 0 : Math.floor(Number(dividend));
  if (!Number.isInteger(div) || div < 0 || div > 100000000) return res.status(400).json({ error: 'INVALID_DIVIDEND' });
  if (db.prepare('SELECT code FROM stocks WHERE code = ?').get(c)) {
    return res.status(409).json({ error: 'ALREADY_EXISTS' });
  }
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO stocks (code, name, cur_price, tags, stock_type, dividend, status) VALUES (?,?,?,?,?, ?,?)')
      .run(c, n, price, tag || '일반', stype, div, '정상');
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
  res.status(201).json(db.prepare('SELECT code, name, cur_price, status, tags, stock_type, dividend, updated_at FROM stocks WHERE code = ?').get(c));
});

// PUT /api/admin/stocks/:code {name?, status?, new_code?} (이름·코드 수정/정상·정지 관리 + 자동공시)
// 코드 변경 시 보유·거래·게시글·공지·이벤트·시세로그의 참조를 한 트랜잭션으로 함께 이전
router.put('/stocks/:code', (req, res) => {
  const s = db.prepare('SELECT * FROM stocks WHERE code = ?').get(req.params.code);
  if (!s) return res.status(404).json({ error: 'NOT_FOUND' });
  const { name, status, new_code, tags, stock_type, dividend } = req.body || {};
  const updates = [];
  const params = [];
  let renamed = null;
  let statusChanged = null;
  let recoded = null;
  let tagged = null;
  let typed = null;
  let divChanged = null;
  if (new_code !== undefined) {
    const nc = String(new_code).trim().toUpperCase();
    if (!/^[A-Z0-9]{2,10}$/.test(nc)) return res.status(400).json({ error: 'INVALID_CODE' });
    if (nc !== s.code) {
      if (db.prepare('SELECT code FROM stocks WHERE code = ?').get(nc)) {
        return res.status(409).json({ error: 'ALREADY_EXISTS' });
      }
      recoded = [s.code, nc];
    }
  }
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
  if (tags !== undefined) {
    const tg = String(tags).trim().slice(0, 100);
    if ((tg || '') !== (s.tags || '')) {
      updates.push('tags = ?');
      params.push(tg);
      tagged = [(s.tags || '-'), tg || '-'];
    }
  }
  if (stock_type !== undefined) {
    if (!['normal', 'bluechip'].includes(stock_type)) return res.status(400).json({ error: 'INVALID_TYPE' });
    if (stock_type !== (s.stock_type || 'normal')) {
      updates.push('stock_type = ?');
      params.push(stock_type);
      typed = [(s.stock_type || 'normal') === 'bluechip' ? '대장주' : '일반', stock_type === 'bluechip' ? '대장주' : '일반'];
    }
  }
  if (dividend !== undefined) {
    const dv = Math.floor(Number(dividend));
    if (!Number.isInteger(dv) || dv < 0 || dv > 100000000) return res.status(400).json({ error: 'INVALID_DIVIDEND' });
    if (dv !== (s.dividend || 0)) {
      updates.push('dividend = ?');
      params.push(dv);
      divChanged = [`주당 ${Number(s.dividend || 0).toLocaleString()}원`, `주당 ${dv.toLocaleString()}원`];
    }
  }
  if (!updates.length && !recoded) return res.status(400).json({ error: 'NO_CHANGES' });
  updates.push("updated_at = datetime('now','localtime')");
  const finalCode = recoded ? recoded[1] : s.code;
  const tx = db.transaction(() => {
    if (recoded) {
      // FK 즉시검사 회피: 새 행 INSERT → 자식 이전 → 旧 행 DELETE (셋 중 하나라도 어긋나면 전체 롤백)
      db.prepare(`INSERT INTO stocks (code, name, cur_price, tags, stock_type, dividend, status, updated_at)
        SELECT ?, name, cur_price, tags, stock_type, dividend, status, updated_at FROM stocks WHERE code = ?`)
        .run(finalCode, s.code);
      for (const t of ['holdings', 'transactions', 'posts', 'notices', 'stock_events', 'price_logs']) {
        db.prepare(`UPDATE ${t} SET stock_code = ? WHERE stock_code = ?`).run(finalCode, s.code);
      }
      db.prepare('DELETE FROM stocks WHERE code = ?').run(s.code);
    }
    if (updates.length) {
      db.prepare(`UPDATE stocks SET ${updates.join(', ')} WHERE code = ?`).run(...params, finalCode);
    }
  });
  tx();
  const desc = [
    recoded ? `코드 ${recoded[0]} → ${recoded[1]}` : null,
    renamed ? `이름 ${renamed[0]} → ${renamed[1]}` : null,
    statusChanged ? `상태 ${statusChanged[0]} → ${statusChanged[1]}` : null,
    tagged ? `태그 ${tagged[0]} → ${tagged[1]}` : null,
    typed ? `유형 ${typed[0]} → ${typed[1]}` : null,
    divChanged ? `배당 ${divChanged[0]} → ${divChanged[1]}` : null,
  ].filter(Boolean).join(', ');
  autoNotice({
    scope: '종목',
    stock_code: finalCode,
    title: `[공시] ${finalCode} 종목 정보 변경`,
    body: `관리자가 ${recoded ? recoded[0] : finalCode} 정보를 변경했습니다. (${desc})`,
    by_admin: req.user.id,
  });
  res.json(db.prepare('SELECT code, name, cur_price, status, tags, stock_type, dividend, updated_at FROM stocks WHERE code = ?').get(finalCode));
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

// POST /api/admin/price-logs/reset (과거 시세 기록 초기화: 종목별 현재가 SEED 1건만 남김, 되돌릴 수 없음)
// holdings·transactions·asset_history(사용자 자산)는 건드리지 않음
router.post('/price-logs/reset', (req, res) => {
  const stocks = db.prepare('SELECT code, cur_price FROM stocks').all();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM price_logs').run();
    const ins = db.prepare(
      "INSERT INTO price_logs (stock_code, prev, next, cause, by_admin) VALUES (?,?,?,'SEED',?)"
    );
    for (const s of stocks) ins.run(s.code, s.cur_price, s.cur_price, req.user.id);
  });
  tx();
  autoNotice({
    scope: '전체',
    stock_code: null,
    title: '[공시] 시세 기록 초기화',
    body: `관리자가 과거 시세 기록을 초기화했습니다. (${stocks.length}종목, 현재가 기준, 이후 1분마다 새 기록 누적)`,
    by_admin: req.user.id,
  });
  res.json({ ok: true, stocks: stocks.length });
});

// GET /api/admin/badges (뱃지 목록 + 보유자 수)
router.get('/badges', (req, res) => {
  res.json(db.prepare(
    `SELECT b.*, (SELECT COUNT(*) FROM user_badges u WHERE u.badge_id = b.id) AS owners
     FROM badges b ORDER BY b.id`
  ).all());
});

// POST /api/admin/badges {name, descrip?, price?} (뱃지 추가)
router.post('/badges', (req, res) => {
  const { name, descrip, price } = req.body || {};
  const n = String(name || '').trim();
  if (!n || n.length > 20) return res.status(400).json({ error: 'INVALID_NAME' });
  const p = price === undefined ? 0 : Math.floor(Number(price));
  if (!Number.isInteger(p) || p < 0 || p > 1000000000) return res.status(400).json({ error: 'INVALID_PRICE' });
  const r = db.prepare('INSERT INTO badges (name, descrip, price) VALUES (?,?,?)')
    .run(n, String(descrip || '').trim().slice(0, 100), p);
  res.status(201).json(db.prepare('SELECT * FROM badges WHERE id = ?').get(r.lastInsertRowid));
});

// PUT /api/admin/badges/:id {name?, descrip?, price?} (뱃지 수정)
router.put('/badges/:id', (req, res) => {
  const b = db.prepare('SELECT * FROM badges WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'NOT_FOUND' });
  const { name, descrip, price } = req.body || {};
  const updates = [];
  const params = [];
  if (name !== undefined) {
    const n = String(name).trim();
    if (!n || n.length > 20) return res.status(400).json({ error: 'INVALID_NAME' });
    updates.push('name = ?');
    params.push(n);
  }
  if (descrip !== undefined) {
    updates.push('descrip = ?');
    params.push(String(descrip).trim().slice(0, 100));
  }
  if (price !== undefined) {
    const p = Math.floor(Number(price));
    if (!Number.isInteger(p) || p < 0 || p > 1000000000) return res.status(400).json({ error: 'INVALID_PRICE' });
    updates.push('price = ?');
    params.push(p);
  }
  if (!updates.length) return res.status(400).json({ error: 'NO_CHANGES' });
  db.prepare(`UPDATE badges SET ${updates.join(', ')} WHERE id = ?`).run(...params, b.id);
  res.json(db.prepare('SELECT * FROM badges WHERE id = ?').get(b.id));
});

// DELETE /api/admin/badges/:id (뱃지 삭제: 보유·장착 함께 해제)
router.delete('/badges/:id', (req, res) => {
  const b = db.prepare('SELECT * FROM badges WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'NOT_FOUND' });
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET display_badge = NULL WHERE display_badge = ?').run(b.id);
    db.prepare('DELETE FROM user_badges WHERE badge_id = ?').run(b.id);
    db.prepare('DELETE FROM badges WHERE id = ?').run(b.id);
  });
  tx();
  res.json({ ok: true });
});

// GET /api/admin/fund (펀드 잔액 + 최근 기부/수령)
router.get('/fund', (req, res) => {
  db.prepare('INSERT OR IGNORE INTO angel_fund (id, balance) VALUES (1, 0)').run();
  const balance = db.prepare('SELECT balance FROM angel_fund WHERE id = 1').get().balance;
  const donations = db.prepare(
    'SELECT d.*, u.nickname FROM donations d LEFT JOIN users u ON u.id = d.user_id ORDER BY d.id DESC LIMIT 50'
  ).all();
  const claims = db.prepare(
    'SELECT c.*, u.nickname FROM fund_claims c LEFT JOIN users u ON u.id = c.user_id ORDER BY c.id DESC LIMIT 50'
  ).all();
  res.json({ balance, donations, claims });
});

// POST /api/admin/fund/adjust {amount} (잔액 직접 조정, ±)
router.post('/fund/adjust', (req, res) => {
  const amount = Math.floor(Number(req.body && req.body.amount));
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000000000) {
    return res.status(400).json({ error: 'INVALID_AMOUNT' });
  }
  db.prepare('INSERT OR IGNORE INTO angel_fund (id, balance) VALUES (1, 0)').run();
  const bal = db.prepare('SELECT balance FROM angel_fund WHERE id = 1').get().balance;
  if (bal + amount < 0) return res.status(400).json({ error: 'INSUFFICIENT_FUND' });
  db.prepare('UPDATE angel_fund SET balance = balance + ? WHERE id = 1').run(amount);
  res.json({ ok: true, balance: bal + amount });
});

// GET /api/admin/games (게임 설정 목록)
router.get('/games', (req, res) => {
  res.json(db.prepare('SELECT * FROM games ORDER BY code').all());
});

// POST /api/admin/games {code, name, ...} (게임 추가; crash는 가중치 파라미터 방식)
router.post('/games', (req, res) => {
  const { code, name, payout_mult, win_prob, min_bet, enabled, descrip, p_up, rng_up, rng_down, max_n } = req.body || {};
  const c = String(code || '').trim().toLowerCase();
  const n = String(name || '').trim();
  if (!/^[a-z0-9]{2,12}$/.test(c)) return res.status(400).json({ error: 'INVALID_CODE' });
  if (!n || n.length > 20) return res.status(400).json({ error: 'INVALID_NAME' });
  if (db.prepare('SELECT code FROM games WHERE code = ?').get(c)) return res.status(409).json({ error: 'ALREADY_EXISTS' });
  const mb = min_bet === undefined ? 100 : Math.floor(Number(min_bet));
  if (!Number.isInteger(mb) || mb < 1) return res.status(400).json({ error: 'INVALID_BET' });
  const en = enabled === undefined || enabled ? 1 : 0;
  const ds = String(descrip || '').slice(0, 100);
  if (c === 'crash' || p_up !== undefined || rng_up !== undefined || rng_down !== undefined || max_n !== undefined) {
    const v = checkCrashParams({ p_up, rng_up, rng_down, max_n }, {});
    if (v.error) return res.status(400).json({ error: v.error });
    db.prepare('INSERT INTO games (code, name, payout_mult, win_prob, min_bet, enabled, descrip, p_up, rng_up, rng_down, max_n) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(c, n, 0, 0.5, mb, en, ds, v.p_up, v.rng_up, v.rng_down, v.max_n);
  } else {
    const mult = Number(payout_mult);
    const prob = Number(win_prob);
    if (!Number.isFinite(mult) || mult <= 1 || mult > 100) return res.status(400).json({ error: 'INVALID_MULT' });
    if (!Number.isFinite(prob) || prob <= 0 || prob >= 1) return res.status(400).json({ error: 'INVALID_PROB' });
    if (mult * prob >= 1) return res.status(400).json({ error: 'HOUSE_EDGE_REQUIRED' });
    db.prepare('INSERT INTO games (code, name, payout_mult, win_prob, min_bet, enabled, descrip) VALUES (?,?,?,?,?,?,?)')
      .run(c, n, mult, prob, mb, en, ds);
  }
  res.status(201).json(db.prepare('SELECT * FROM games WHERE code = ?').get(c));
});

// 크래시 파라미터 검증 (하우스 우위 강제: 상승기대 < 하락기대)
function checkCrashParams(body, g) {
  const pUp = body.p_up !== undefined ? Number(body.p_up) : (g.p_up != null ? g.p_up : 0.48);
  const rUp = body.rng_up !== undefined ? Number(body.rng_up) : (g.rng_up != null ? g.rng_up : 1.0);
  const rDown = body.rng_down !== undefined ? Number(body.rng_down) : (g.rng_down != null ? g.rng_down : 1.1);
  const maxN = body.max_n !== undefined ? Math.floor(Number(body.max_n)) : (g.max_n != null ? g.max_n : 10);
  if (!Number.isFinite(pUp) || pUp <= 0 || pUp >= 1) return { error: 'INVALID_P_UP' };
  if (!Number.isFinite(rUp) || rUp <= 0 || rUp > 5) return { error: 'INVALID_RNG' };
  if (!Number.isFinite(rDown) || rDown <= 0 || rDown > 5) return { error: 'INVALID_RNG' };
  if (!Number.isInteger(maxN) || maxN < 1 || maxN > 20) return { error: 'INVALID_MAX_N' };
  if (pUp * rUp >= (1 - pUp) * rDown) return { error: 'HOUSE_EDGE_REQUIRED' };
  return { p_up: pUp, rng_up: rUp, rng_down: rDown, max_n: maxN };
}

// PUT /api/admin/games/:code (게임 수정; crash 파라미터 포함)
router.put('/games/:code', (req, res) => {
  const g = db.prepare('SELECT * FROM games WHERE code = ?').get(req.params.code);
  if (!g) return res.status(404).json({ error: 'NOT_FOUND' });
  const { name, payout_mult, win_prob, min_bet, enabled, descrip, p_up, rng_up, rng_down, max_n } = req.body || {};
  const updates = [];
  const params = [];
  let nm = g.payout_mult, pb = g.win_prob;
  if (name !== undefined) {
    const n = String(name).trim();
    if (!n || n.length > 20) return res.status(400).json({ error: 'INVALID_NAME' });
    updates.push('name = ?');
    params.push(n);
  }
  if (payout_mult !== undefined) {
    nm = Number(payout_mult);
    if (!Number.isFinite(nm) || nm <= 1 || nm > 100) return res.status(400).json({ error: 'INVALID_MULT' });
    updates.push('payout_mult = ?');
    params.push(nm);
  }
  if (win_prob !== undefined) {
    pb = Number(win_prob);
    if (!Number.isFinite(pb) || pb <= 0 || pb >= 1) return res.status(400).json({ error: 'INVALID_PROB' });
    updates.push('win_prob = ?');
    params.push(pb);
  }
  if (nm * pb >= 1) return res.status(400).json({ error: 'HOUSE_EDGE_REQUIRED' });
  if (min_bet !== undefined) {
    const mb = Math.floor(Number(min_bet));
    if (!Number.isInteger(mb) || mb < 1) return res.status(400).json({ error: 'INVALID_BET' });
    updates.push('min_bet = ?');
    params.push(mb);
  }
  if (enabled !== undefined) {
    updates.push('enabled = ?');
    params.push(enabled ? 1 : 0);
  }
  if (descrip !== undefined) {
    updates.push('descrip = ?');
    params.push(String(descrip).slice(0, 100));
  }
  if (p_up !== undefined || rng_up !== undefined || rng_down !== undefined || max_n !== undefined) {
    const v = checkCrashParams({ p_up, rng_up, rng_down, max_n }, g);
    if (v.error) return res.status(400).json({ error: v.error });
    updates.push('p_up = ?', 'rng_up = ?', 'rng_down = ?', 'max_n = ?');
    params.push(v.p_up, v.rng_up, v.rng_down, v.max_n);
  }
  if (!updates.length) return res.status(400).json({ error: 'NO_CHANGES' });
  db.prepare(`UPDATE games SET ${updates.join(', ')} WHERE code = ?`).run(...params, g.code);
  res.json(db.prepare('SELECT * FROM games WHERE code = ?').get(g.code));
});

// DELETE /api/admin/games/:code (게임 삭제, 로그는 유지)
router.delete('/games/:code', (req, res) => {
  const g = db.prepare('SELECT * FROM games WHERE code = ?').get(req.params.code);
  if (!g) return res.status(404).json({ error: 'NOT_FOUND' });
  db.prepare('DELETE FROM games WHERE code = ?').run(g.code);
  res.json({ ok: true });
});

// GET /api/admin/gamble/stats (하우스 수지 + 유저별)
router.get('/gamble/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS plays, COALESCE(SUM(bet),0) AS bet, COALESCE(SUM(payout),0) AS payout FROM gambles').get();
  const byUser = db.prepare(
    `SELECT g.user_id AS id, u.nickname, COUNT(*) AS plays, SUM(g.bet) AS bet, SUM(g.payout) AS payout
     FROM gambles g LEFT JOIN users u ON u.id = g.user_id GROUP BY g.user_id ORDER BY bet DESC LIMIT 50`
  ).all();
  res.json({ total, byUser, house_edge: total.bet ? Math.round((1 - total.payout / total.bet) * 1000) / 10 : 0 });
});

// GET /api/admin/gamble/halt (도박장 전체 정지 여부)
router.get('/gamble/halt', (req, res) => {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'gamble_halted'").get();
  res.json({ halted: r && r.value === '1' });
});

// POST /api/admin/gamble/halt {halt} (도박장 전체 정지/재개)
router.post('/gamble/halt', (req, res) => {
  const halt = !!(req.body && req.body.halt);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('gamble_halted', ?)").run(halt ? '1' : '0');
  res.json({ ok: true, halted: halt });
});

module.exports = router;
