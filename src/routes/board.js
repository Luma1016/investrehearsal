const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware');

const router = express.Router();

// 좋아요 중복방지 (메모리, 세션/유저 기준 1인 1회)
const liked = new Set(); // `${userId}:${postId}` 또는 `sess:${sessionID}:${postId}`
function likeKey(req, postId) {
  if (req.session && req.session.userId) return `u:${req.session.userId}:${postId}`;
  return `s:${req.sessionID}:${postId}`;
}

// 도배 방지: 글쓰기 30초 1회 (사용자별, spec의 express-rate-limit 대체)
const lastWrite = new Map();
function writeThrottle(req, res, next) {
  const uid = req.session && req.session.userId ? `u:${req.session.userId}` : `ip:${req.ip}`;
  const now = Date.now();
  const prev = lastWrite.get(uid) || 0;
  if (now - prev < 30000) {
    return res.status(429).json({ error: 'RATE_LIMIT' });
  }
  lastWrite.set(uid, now);
  next();
}

function displayNickname(u) {
  if (!u) return '알수없음';
  return u.status === '탈퇴' ? '탈퇴회원' : u.nickname;
}

function withMeta(row, viewerId) {
  const u = row.user_id ? db.prepare('SELECT nickname, status FROM users WHERE id = ?').get(row.user_id) : null;
  let isHolder = false;
  if (row.stock_code && row.user_id) {
    const h = db.prepare('SELECT 1 AS ok FROM holdings WHERE user_id = ? AND stock_code = ?')
      .get(row.user_id, row.stock_code);
    isHolder = !!h;
  }
  const cc = db.prepare("SELECT COUNT(*) AS c FROM comments WHERE post_id = ? AND status = '정상'").get(row.id).c;
  return {
    ...row,
    nickname: displayNickname(u),
    isHolder,
    comment_cnt: cc,
    mine: viewerId ? row.user_id === viewerId : false,
  };
}

function isAdminId(uid) {
  if (!uid) return false;
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(uid);
  return u && u.role === 'ADMIN';
}

// GET /api/posts?stock=&sort=최신/좋아요&q=&mine=1
router.get('/posts', (req, res) => {
  const { stock, sort, q, mine } = req.query;
  const viewerId = req.session && req.session.userId ? req.session.userId : null;
  const conds = ["p.status = '정상'"];
  const params = [];
  if (stock) {
    conds.push('p.stock_code = ?');
    params.push(stock);
  }
  if (q) {
    conds.push('(p.title LIKE ? OR p.body LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (mine && viewerId) {
    conds.push('p.user_id = ?');
    params.push(viewerId);
  }
  const order = sort === '좋아요' ? 'p.likes DESC, p.id DESC' : 'p.id DESC';
  const rows = db.prepare(
    `SELECT p.* FROM posts p WHERE ${conds.join(' AND ')} ORDER BY ${order} LIMIT 100`
  ).all(...params);
  res.json(rows.map((r) => withMeta(r, viewerId)));
});

// POST /api/posts {stock_code,title,body}
router.post('/posts', requireLogin, writeThrottle, (req, res) => {
  const { stock_code, title, body } = req.body || {};
  if (!title || !body || String(title).trim().length < 1 || String(body).trim().length < 1) {
    return res.status(400).json({ error: 'INVALID_INPUT' });
  }
  if (String(title).length > 100) return res.status(400).json({ error: 'TITLE_TOO_LONG' });
  if (stock_code) {
    const s = db.prepare('SELECT code FROM stocks WHERE code = ?').get(stock_code);
    if (!s) return res.status(404).json({ error: 'NOT_FOUND' });
  }
  const r = db.prepare(
    'INSERT INTO posts (stock_code, user_id, title, body) VALUES (?,?,?,?)'
  ).run(stock_code || null, req.user.id, String(title).trim(), String(body).trim());
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(r.lastInsertRowid);
  res.status(201).json(withMeta(row, req.user.id));
});

// GET /api/posts/:id (views+1)
router.get('/posts/:id', (req, res) => {
  const viewerId = req.session && req.session.userId ? req.session.userId : null;
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
  if (row.status === '블라인드' && !isAdminId(viewerId)) {
    return res.status(404).json({ error: 'NOT_FOUND' });
  }
  db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').run(row.id);
  const fresh = db.prepare('SELECT * FROM posts WHERE id = ?').get(row.id);
  res.json(withMeta(fresh, viewerId));
});

// PUT /api/posts/:id (본인만)
router.put('/posts/:id', requireLogin, (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
  if (row.user_id !== req.user.id) return res.status(403).json({ error: 'FORBIDDEN' });
  const { title, body } = req.body || {};
  if (title !== undefined) {
    if (String(title).trim().length < 1 || String(title).length > 100) {
      return res.status(400).json({ error: 'INVALID_INPUT' });
    }
    db.prepare('UPDATE posts SET title = ? WHERE id = ?').run(String(title).trim(), row.id);
  }
  if (body !== undefined) {
    if (String(body).trim().length < 1) return res.status(400).json({ error: 'INVALID_INPUT' });
    db.prepare('UPDATE posts SET body = ? WHERE id = ?').run(String(body).trim(), row.id);
  }
  const fresh = db.prepare('SELECT * FROM posts WHERE id = ?').get(row.id);
  res.json(withMeta(fresh, req.user.id));
});

// DELETE /api/posts/:id (본인만, ADMIN 우회)
router.delete('/posts/:id', requireLogin, (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
  if (row.user_id !== req.user.id && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  db.prepare('DELETE FROM posts WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// POST /api/posts/:id/like (1인 1회)
router.post('/posts/:id/like', (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!row || row.status === '블라인드') return res.status(404).json({ error: 'NOT_FOUND' });
  const key = likeKey(req, row.id);
  if (liked.has(key)) return res.status(400).json({ error: 'ALREADY_LIKED' });
  liked.add(key);
  db.prepare('UPDATE posts SET likes = likes + 1 WHERE id = ?').run(row.id);
  const fresh = db.prepare('SELECT * FROM posts WHERE id = ?').get(row.id);
  res.json({ ok: true, likes: fresh.likes });
});

// GET /api/posts/:id/comments
router.get('/posts/:id/comments', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'NOT_FOUND' });
  const viewerId = req.session && req.session.userId ? req.session.userId : null;
  if (post.status === '블라인드' && !isAdminId(viewerId)) {
    return res.status(404).json({ error: 'NOT_FOUND' });
  }
  const rows = db.prepare(
    `SELECT c.*, u.nickname, u.status AS ustatus FROM comments c
     LEFT JOIN users u ON u.id = c.user_id
     WHERE c.post_id = ? AND c.status = '정상' ORDER BY c.id`
  ).all(post.id);
  res.json(rows.map((c) => ({
    ...c,
    nickname: c.ustatus === '탈퇴' ? '탈퇴회원' : (c.nickname || '알수없음'),
    mine: viewerId ? c.user_id === viewerId : false,
  })));
});

// POST /api/posts/:id/comments {body}
router.post('/posts/:id/comments', requireLogin, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post || post.status === '블라인드') return res.status(404).json({ error: 'NOT_FOUND' });
  const { body } = req.body || {};
  if (!body || String(body).trim().length < 1) return res.status(400).json({ error: 'INVALID_INPUT' });
  const r = db.prepare('INSERT INTO comments (post_id, user_id, body) VALUES (?,?,?)')
    .run(post.id, req.user.id, String(body).trim());
  const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(r.lastInsertRowid);
  res.status(201).json(row);
});

// DELETE /api/comments/:id (본인만, ADMIN 우회)
router.delete('/comments/:id', requireLogin, (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'NOT_FOUND' });
  if (c.user_id !== req.user.id && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

// GET /api/notices?scope=&stock= (전체 공개, 고정글 우선)
router.get('/notices', (req, res) => {
  const { scope, stock } = req.query;
  const conds = [];
  const params = [];
  if (scope === '전체' || scope === '종목') {
    conds.push('scope = ?');
    params.push(scope);
  }
  if (stock) {
    conds.push('(stock_code = ? OR scope = ?)');
    params.push(stock, '전체');
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  res.json(
    db.prepare(`SELECT * FROM notices ${where} ORDER BY pinned DESC, id DESC LIMIT 50`).all(...params)
  );
});

module.exports = router;
