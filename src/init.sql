-- Invest REhearsal MVP DDL (SQLite, 10 테이블)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  pw_hash TEXT NOT NULL,
  nickname TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER','ADMIN')),
  status TEXT NOT NULL DEFAULT '정상',
  display_badge INTEGER REFERENCES badges(id),
  created_at DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cash INTEGER NOT NULL,
  init_cash INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stocks (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cur_price INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT '정상' CHECK (status IN ('정상','정지')),
  tags TEXT NOT NULL DEFAULT '',
  stock_type TEXT NOT NULL DEFAULT 'normal' CHECK (stock_type IN ('normal','bluechip')),
  dividend INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS holdings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stock_code TEXT NOT NULL REFERENCES stocks(code),
  qty INTEGER NOT NULL CHECK (qty >= 1),
  avg_price INTEGER NOT NULL CHECK (avg_price >= 1),
  PRIMARY KEY (user_id, stock_code)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stock_code TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  qty INTEGER NOT NULL CHECK (qty >= 1),
  price INTEGER NOT NULL CHECK (price >= 1),
  pnl INTEGER,
  created_at DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS asset_history (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  total INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_code TEXT REFERENCES stocks(code),
  user_id INTEGER REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '정상' CHECK (status IN ('정상','블라인드')),
  created_at DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '정상',
  created_at DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('전체','종목')),
  stock_code TEXT REFERENCES stocks(code),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  by_admin INTEGER REFERENCES users(id),
  expires_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS stock_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_code TEXT NOT NULL REFERENCES stocks(code),
  type TEXT NOT NULL CHECK (type IN ('급등','급락','정지','배당')),
  rate REAL NOT NULL,
  status TEXT NOT NULL DEFAULT '예약' CHECK (status IN ('예약','진행중','종료')),
  reason TEXT,
  by_admin INTEGER REFERENCES users(id),
  start_at DATETIME,
  end_at DATETIME
);

CREATE TABLE IF NOT EXISTS price_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_code TEXT NOT NULL,
  prev INTEGER NOT NULL,
  next INTEGER NOT NULL,
  cause TEXT,
  by_admin INTEGER REFERENCES users(id),
  created_at DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stock_code TEXT NOT NULL REFERENCES stocks(code),
  side TEXT NOT NULL DEFAULT 'BUY' CHECK (side IN ('BUY','SELL')),
  qty INTEGER NOT NULL CHECK (qty >= 1),
  target_price INTEGER NOT NULL CHECK (target_price >= 1),
  status TEXT NOT NULL DEFAULT '대기' CHECK (status IN ('대기','체결','취소')),
  memo TEXT,
  created_at DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
  executed_at DATETIME
);

CREATE TABLE IF NOT EXISTS indices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '전체' CHECK (kind IN ('전체','태그','대장주')),
  tag TEXT NOT NULL DEFAULT '',
  base_value REAL NOT NULL DEFAULT 1000,
  created_at DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS cb_hits (
  stock_code TEXT NOT NULL,
  date TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('상한','하한')),
  level INTEGER NOT NULL CHECK (level >= 1),
  halt_until DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (stock_code, date, side, level)
);

CREATE TABLE IF NOT EXISTS dividend_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stock_code TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty >= 1),
  per_share INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  div_date TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(user_id, stock_code, div_date)
);

-- 엔젤펀드(기부): pool 1행, 기부/수령 로그
CREATE TABLE IF NOT EXISTS angel_fund (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  balance INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS donations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount >= 1),
  created_at DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS fund_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount >= 1),
  claim_date TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 뱃지 상점 + 보유 (장착은 users.display_badge)
CREATE TABLE IF NOT EXISTS badges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  descrip TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS user_badges (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  created_at DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (user_id, badge_id)
);

-- 도박 게임 설정 + 로그 (환수율<100%로 설계 = 돈 먹는 하우스)
CREATE TABLE IF NOT EXISTS games (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  payout_mult REAL NOT NULL,
  win_prob REAL NOT NULL CHECK (win_prob > 0 AND win_prob < 1),
  min_bet INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  descrip TEXT NOT NULL DEFAULT '',
  p_up REAL,
  rng_up REAL,
  rng_down REAL,
  max_n INTEGER,
  max_mult REAL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS gambles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_code TEXT NOT NULL,
  bet INTEGER NOT NULL,
  payout INTEGER NOT NULL DEFAULT 0,
  win INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
);
