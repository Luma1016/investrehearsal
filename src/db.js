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

// 마이그레이션: 기존 DB에 tags/stock_type 컬럼 추가
try {
  db.exec("ALTER TABLE stocks ADD COLUMN tags TEXT NOT NULL DEFAULT ''");
} catch (e) { /* 이미 있으면 무시 */ }
try {
  db.exec("ALTER TABLE stocks ADD COLUMN stock_type TEXT NOT NULL DEFAULT 'normal'");
} catch (e) { /* 이미 있으면 무시 */ }
try {
  db.exec('ALTER TABLE notices ADD COLUMN expires_at DATETIME');
} catch (e) { /* 이미 있으면 무시 */ }
try {
  db.exec('ALTER TABLE stocks ADD COLUMN dividend INTEGER NOT NULL DEFAULT 0');
} catch (e) { /* 이미 있으면 무시 */ }
try {
  db.exec('ALTER TABLE stocks ADD COLUMN listed_shares INTEGER NOT NULL DEFAULT 1000000');
} catch (e) { /* 이미 있으면 무시 */ }
try {
  db.exec('ALTER TABLE users ADD COLUMN display_badge INTEGER REFERENCES badges(id)');
} catch (e) { /* 이미 있으면 무시 */ }
for (const col of ['p_up REAL', 'rng_up REAL', 'rng_down REAL', 'max_n INTEGER', 'max_mult REAL']) {
  try {
    db.exec(`ALTER TABLE games ADD COLUMN ${col}`);
  } catch (e) { /* 이미 있으면 무시 */ }
}
// 홀짝 제거 마이그레이션 (1회성): coin/dice 행 삭제, crash 파라미터 보정
try {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'migrated_rm_coindice'").get();
  if (!done) {
    db.prepare("DELETE FROM games WHERE code IN ('coin','dice')").run();
    const gc = db.prepare('SELECT COUNT(*) AS c FROM games').get().c;
    if (gc > 0) {
    const crash = db.prepare('SELECT p_up, max_mult FROM games WHERE code = ?').get('crash');
    if (crash) {
      if (crash.p_up == null) {
        db.prepare('UPDATE games SET p_up = 0.49, rng_up = 1.0, rng_down = 1.05, max_n = 10 WHERE code = ?').run('crash');
      }
      if (crash.max_mult == null) {
        db.prepare('UPDATE games SET max_mult = 10 WHERE code = ?').run('crash');
      }
    }
    if (gc > 0 && !crash) {
      db.prepare("INSERT INTO games (code, name, payout_mult, win_prob, min_bet, enabled, descrip, p_up, rng_up, rng_down, max_n, max_mult) VALUES ('crash','크래시',0,0.5,100,1,'목표 단계 도달 배율 게임 (승률 약 45%)',0.49,1.0,1.05,10,10)").run();
    }
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('migrated_rm_coindice','1')").run();
    console.log('[db] migrated: coin/dice 제거, crash 보정');
  }
} catch (e) { /* 무시 */ }

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
      ['SAMSUN', '삼선전자', 252000, '반도체', 'bluechip'],
      ['ANIMIN', '애니마이너스', 2100, '방송', 'normal'],
      ['DEVBRO', '데브브라더즈', 12300, '게임', 'normal'],
      ['SHELLT', '쉘트리온', 179700, '바이오', 'bluechip'],
      ['KRCHIP', '코리아칩', 22000, '배터리', 'normal'],
      ['SAMHI', '삼선중공업', 18700, '조선', 'normal'],
      ['HANAFN', '한아금융지주', 33500, '금융', 'normal'],
      ['GLOBOT', '글로봇', 20350, '로봇', 'normal'],
      ['KRAVI', '한국항공', 28900, '여행항공', 'normal'],
      ['KROFC', '한국광통신', 15600, '광통신', 'normal'],
    ];
    const ins = db.prepare(
      "INSERT INTO stocks (code, name, cur_price, tags, stock_type, status) VALUES (?,?,?,?,?,'정상')"
    );
    const tx = db.transaction((rows) => {
      for (const row of rows) ins.run(row[0], row[1], row[2], row[3], row[4]);
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

  // 3) 기존 DB 태그 백필 (tags가 비어 있는 종목만)
  const untagged = db.prepare("SELECT code FROM stocks WHERE tags IS NULL OR tags = ''").all();
  if (untagged.length) {
    const tagMap = {
      // 현행 기본 목록
      SAMSUN: '반도체', ANIMIN: '방송', DEVBRO: '게임', SHELLT: '바이오',
      KRCHIP: '배터리', SAMHI: '조선', HANAFN: '금융', GLOBOT: '로봇',
      KRAVI: '여행항공', KROFC: '광통신',
      // 구 목록 (기존 DB 호환)
      CHKN: '푸드외식', IDOL: '엔터', BUBBLE: '푸드외식', KIMCHI: '바이오',
      HANRIV: '2차전지', TTEOK: '게임', SOJU: '핀테크', WEBTOON: '엔터',
      KSTAR: '여행항공', SEOULFD: '푸드외식',
    };
    const up = db.prepare('UPDATE stocks SET tags = ? WHERE code = ?');
    const txTag = db.transaction((rows) => {
      for (const r of rows) up.run(tagMap[r.code] || '일반', r.code);
    });
    txTag(untagged);
    console.log(`[db] backfilled tags for ${untagged.length} stocks`);
  }

  // 4) 대장주 기본값 (아직 bluechip이 하나도 없을 때만: 기존 관리자 설정 덮어쓰지 않음)
  const blueCnt = db.prepare("SELECT COUNT(*) AS c FROM stocks WHERE stock_type = 'bluechip'").get().c;
  if (blueCnt === 0) {
    const r = db.prepare("UPDATE stocks SET stock_type = 'bluechip' WHERE code IN ('SAMSUN','SHELLT','KIMCHI','HANRIV')").run();
    console.log(`[db] default bluechips applied: ${r.changes} stocks`);
  }

  // 5) 기본 지수 (없을 때만)
  const idxCnt = db.prepare('SELECT COUNT(*) AS c FROM indices').get().c;
  if (idxCnt === 0) {
    db.prepare("INSERT INTO indices (name, kind, tag, base_value) VALUES ('Rehearsal 종합','전체','',1000)").run();
    console.log('[db] seeded index: Rehearsal 종합');
  }

  // 6) 엔젤펀드 pool 1행
  db.prepare('INSERT OR IGNORE INTO angel_fund (id, balance) VALUES (1, 0)').run();

  // 7) 도박 게임 시드: 크래시만 (홀짝은 제거됨, 관리자 필요시 재추가 가능)
  const gameCnt = db.prepare('SELECT COUNT(*) AS c FROM games').get().c;
  if (gameCnt === 0) {
    db.prepare("INSERT INTO games (code, name, payout_mult, win_prob, min_bet, enabled, descrip, p_up, rng_up, rng_down, max_n, max_mult) VALUES ('crash','크래시',0,0.5,100,1,'목표 단계 도달 배율 게임 (승률 약 45%)',0.49,1.0,1.05,10,10)").run();
    console.log('[db] seeded games: crash');
  }

  // 8) 구매 뱃지 시드 (돈 소비처)
  const badgeCnt = db.prepare('SELECT COUNT(*) AS c FROM badges').get().c;
  if (badgeCnt === 0) {
    db.prepare('INSERT INTO badges (name, descrip, price) VALUES (?,?,?)').run('황금개미', '반짝이는 개미의 증표', 1000000);
    db.prepare('INSERT INTO badges (name, descrip, price) VALUES (?,?,?)').run('다이아손', '전설의 손', 5000000);
    db.prepare('INSERT INTO badges (name, descrip, price) VALUES (?,?,?)').run('존버왕', '버티면 이긴다', 2000000);
    console.log('[db] seeded badges');
  }
}

seed();

module.exports = db;
