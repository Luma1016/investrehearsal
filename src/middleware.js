const db = require('./db');

function requireLogin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'LOGIN_REQUIRED' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    return res.status(401).json({ error: 'LOGIN_REQUIRED' });
  }
  if (user.status === '탈퇴') {
    return res.status(401).json({ error: 'WITHDRAWN' });
  }
  if (user.status === '정지') {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'LOGIN_REQUIRED' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  if (user.status !== '정상') {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  req.user = user;
  next();
}

module.exports = { requireLogin, requireAdmin };
