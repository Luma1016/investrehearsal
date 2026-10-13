-- Invest REhearsal MVP DDL (SQLite, 10 테이블)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  pw_hash TEXT NOT NULL,
  nickname TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER','ADMIN')),
  status TEXT NOT NULL DEFAULT '정상',
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
