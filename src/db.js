const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db.sqlite');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const initSql = fs.readFileSync(path.join(__dirname, 'init.sql'), 'utf8');
db.exec(initSql);

const INIT_CASH = 10000000;

function seed() {
  // 1) 관리자 시드
  const admin = db.prepare('SELECT * FROM users WHERE email = ?').get('admin@invest.local');
  if (!admin) {
    const pwHash = bcrypt.hashSync('admin1234!', 10);
    const r = db.prepare(
      "INSERT INTO users (email, pw_hash, nickname, role, status) VALUES (?,?,?,?,?)"
    ).run('admin@invest.local', pwHash, '관리자', 'ADMIN', '정상');
    db.prepare('INSERT INTO accounts (user_id, cash, init_cash) VALUES (?,?,?)')
      .run(r.lastInsertRowid, INIT_CASH, INIT_CASH);
    console.log('[db] seeded admin: admin@invest.local / admin1234! (변경 필수)');
  }

  // 2) 종목 10개 시드
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM stocks').get().c;
  if (cnt === 0) {
    const stocks = [
      ['CHKN', '치킨왕국', 45200],
      ['IDOL', '아이돌엔터', 32150],
      ['BUBBLE', '버블티랩', 12300],
      ['KIMCHI', '김치바이오', 58700],
      ['HANRIV', '한강배터리', 76400],
      ['TTEOK', '떡볶이게임즈', 21800],
      ['SOJU', '소주핀테크', 33500],
      ['WEBTOON', '웹툰스튜디오', 41200],
      ['KSTAR', '케이스타항공', 28900],
      ['SEOULFD', '서울푸드랩', 15600],
    ];
    const ins = db.prepare(
      "INSERT INTO stocks (code, name, cur_price, status) VALUES (?,?,?,'정상')"
    );
    const tx = db.transaction((rows) => {
      for (const row of rows) ins.run(row[0], row[1], row[2]);
    });
    tx(stocks);
    console.log('[db] seeded 10 stocks');
    // 차트 시작점: 시드가를 SEED 로그로 기록
    const seedLog = db.prepare(
      "INSERT INTO price_logs (stock_code, prev, next, cause) VALUES (?,?,?,'SEED')"
    );
    const txLog = db.transaction((rows) => {
      for (const row of rows) seedLog.run(row[0], row[2], row[2]);
    });
    txLog(stocks);
  }
}

seed();

module.exports = db;
