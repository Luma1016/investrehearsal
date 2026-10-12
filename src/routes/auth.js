const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');

const router = express.Router();
const INIT_CASH = 10000000;

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(u, cash) {
  return {
    id: u.id,
    email: u.email,
    nickname: u.status === '탈퇴' ? '탈퇴회원' : u.nickname,
    role: u.role,
    status: u.status,
    created_at: u.created_at,
    cash: cash ?? null,
  };
}

// POST /api/auth/signup
router.post('/signup', (req, res) => {
  const { email, pw, nickname } = req.body || {};
  if (!email || !pw || !nickname) {
    return res.status(400).json({ error: 'INVALID_INPUT' });
  }
  if (!emailRe.test(email)) return res.status(400).json({ error: 'INVALID_EMAIL' });
  if (String(pw).length < 4) return res.status(400).json({ error: 'WEAK_PASSWORD' });
  if (String(nickname).length < 2 || String(nickname).length > 12) {
    return res.status(400).json({ error: 'INVALID_NICKNAME' });
  }

  const dup = db.prepare('SELECT id FROM users WHERE email = ? OR nickname = ?').get(email, nickname);
  if (dup) return res.status(409).json({ error: 'DUPLICATE' });

  const pwHash = bcrypt.hashSync(String(pw), 10);
  const tx = db.transaction(() => {
    const r = db.prepare(
      "INSERT INTO users (email, pw_hash, nickname, role, status) VALUES (?,?,?,'USER','정상')"
    ).run(email, pwHash, nickname);
    db.prepare('INSERT INTO accounts (user_id, cash, init_cash) VALUES (?,?,?)')
      .run(r.lastInsertRowid, INIT_CASH, INIT_CASH);
    return r.lastInsertRowid;
  });

  try {
    const userId = tx();
    req.session.userId = userId;
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    return res.status(201).json(publicUser(u, INIT_CASH));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'DUPLICATE' });
    }
    throw e;
  }
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { email, pw } = req.body || {};
  if (!email || !pw) return res.status(400).json({ error: 'INVALID_INPUT' });
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u) return res.status(401).json({ error: 'INVALID_CREDENTIAL' });
  if (u.status === '탈퇴') return res.status(401).json({ error: 'WITHDRAWN' });
  if (u.status === '정지') return res.status(403).json({ error: 'FORBIDDEN' });
  const ok = bcrypt.compareSync(String(pw), u.pw_hash);
  if (!ok) return res.status(401).json({ error: 'INVALID_CREDENTIAL' });
  req.session.userId = u.id;
  const acc = db.prepare('SELECT cash FROM accounts WHERE user_id = ?').get(u.id);
  return res.json(publicUser(u, acc ? acc.cash : null));
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    return res.json({ ok: true });
  });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'LOGIN_REQUIRED' });
  }
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!u) return res.status(401).json({ error: 'LOGIN_REQUIRED' });
  const acc = db.prepare('SELECT cash, init_cash FROM accounts WHERE user_id = ?').get(u.id);
  return res.json({
    ...publicUser(u, acc ? acc.cash : null),
    init_cash: acc ? acc.init_cash : null,
  });
});

// PUT /api/auth/me
router.put('/me', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'LOGIN_REQUIRED' });
  }
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!u) return res.status(401).json({ error: 'LOGIN_REQUIRED' });
  const { nickname, pw } = req.body || {};
  if (nickname !== undefined) {
    if (String(nickname).length < 2 || String(nickname).length > 12) {
      return res.status(400).json({ error: 'INVALID_NICKNAME' });
    }
    try {
      db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname, u.id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'DUPLICATE' });
      }
      throw e;
    }
  }
  if (pw !== undefined) {
    if (String(pw).length < 4) return res.status(400).json({ error: 'WEAK_PASSWORD' });
    db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(pw), 10), u.id);
  }
  const nu = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
  const acc = db.prepare('SELECT cash FROM accounts WHERE user_id = ?').get(u.id);
  return res.json(publicUser(nu, acc ? acc.cash : null));
});

// DELETE /api/auth/me (탈퇴: 글 유지 + 닉네임 탈퇴회원 표시)
router.delete('/me', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'LOGIN_REQUIRED' });
  }
  db.prepare("UPDATE users SET status = '탈퇴' WHERE id = ?").run(req.session.userId);
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    return res.json({ ok: true });
  });
});

module.exports = router;
