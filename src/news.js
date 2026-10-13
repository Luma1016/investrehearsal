const db = require('./db');

// 랜덤 뉴스 시스템 (기획서 5.2 event_rate + 5.6 자동공시 규칙 준수)
// - 5~60분 랜덤 간격으로 종목 1개에 급등/급락 이벤트 부여 (3~10분 지속)
// - stock_events + notices [속보] 자동 발행, price.js tick이 event_rate를 시세에 반영
// - 테이블 추가 없음, 서버만 켜져 있으면 무유저 상태에서도 동작
const TEMPLATES = [
  { type: '급등', dir: 1, titles: ['외국인 대량 매수 포착', '신제품 대박 소식', '실적 서프라이즈 전망', '대형 수주 계약 체결'] },
  { type: '급등', dir: 1, titles: ['유명 유튜버 추천 종목으로 언급', '기관 매수세 유입', '신사업 진출 발표'] },
  { type: '급락', dir: -1, titles: ['실적 쇼크 우려 확산', '대주주 지분 매도 소식', '리콜·하자 논란 발생', '공매도 타깃 포착'] },
  { type: '급락', dir: -1, titles: ['경쟁사 신제품에 밀려 점유율 하락', '임상 실패 소식', '횡령 의혹 보도'] },
];

// 테마주 뉴스: 같은 태그 종목 전체에 동시 이벤트
const THEME_TEMPLATES = [
  { dir: 1, titles: ['정부 지원 정책 발표에 테마 전체 강세', '글로벌 수요 급증 소식에 매수세 몰려', '대형 해외 수주 잭팟 기대감'] },
  { dir: -1, titles: ['규제 강화 우려에 테마 전체 약세', '원자재 가격 급등에 수익성 악화 우려', '해외 악재 여파로 테마 동반 하락'] },
];

function rand(min, max) {
  return Math.random() * (max - min) + min;
}
function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}
function nextDelayMs() {
  // 5~60분 랜덤
  return randInt(5, 60) * 60 * 1000;
}

function distinctTags() {
  try {
    return db.prepare("SELECT DISTINCT tags FROM stocks WHERE status = '정상' AND tags IS NOT NULL AND tags != ''").all().map((r) => r.tags);
  } catch (e) {
    return [];
  }
}

// 테마 뉴스 1건: 같은 태그의 정상 종목 전체에 동일 방향 이벤트 + 종목별 속보 공시
function fireThemeNews() {
  const tags = distinctTags();
  if (!tags.length) return fireNews();
  const live = db.prepare("SELECT COUNT(*) AS c FROM stock_events WHERE status IN ('예약','진행중')").get().c;
  if (live >= 3) return null;
  const tag = tags[randInt(0, tags.length - 1)];
  const stocks = db.prepare("SELECT code, name FROM stocks WHERE status = '정상' AND tags = ?").all(tag);
  if (!stocks.length) return fireNews();
  const t = THEME_TEMPLATES[randInt(0, THEME_TEMPLATES.length - 1)];
  const title = t.titles[randInt(0, t.titles.length - 1)];
  const type = t.dir > 0 ? '급등' : '급락';
  const mag = rand(0.03, 0.1);
  const rate = t.dir > 0 ? mag : -mag;
  const mins = randInt(3, 10);
  const now = new Date();
  const fmt = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const start = fmt(now);
  const end = fmt(new Date(now.getTime() + mins * 60 * 1000));
  const names = stocks.map((s) => s.name).join(', ');
  const tx = db.transaction(() => {
    for (const s of stocks) {
      db.prepare(
        'INSERT INTO stock_events (stock_code, type, rate, status, reason, start_at, end_at) VALUES (?,?,?,?,?,?,?)'
      ).run(s.code, type, Number(rate.toFixed(4)), '진행중', `[자동뉴스][${tag}테마] ${title}`, start, end);
      const arrow = t.dir > 0 ? '📈' : '📉';
      db.prepare(
        'INSERT INTO notices (scope, stock_code, title, body, pinned, by_admin) VALUES (?,?,?,?,0,?)'
      ).run(
        '종목',
        s.code,
        `[속보] [${tag}] ${title} ${arrow}`,
        `자동 테마뉴스: ${tag} 테마(${names}) ${type} 이벤트. 약 ${mins}분간 시세에 ${t.dir > 0 ? '+' : ''}${(rate * 100).toFixed(1)}%/틱 영향.`,
        null
      );
    }
  });
  try {
    tx();
  } catch (e) {
    console.error('[news] theme fire failed:', e.message);
    return null;
  }
  console.log(`[news] THEME ${tag} ${type} ${rate.toFixed(3)} ${mins}분 :: ${stocks.map((s) => s.code).join(',')}`);
  return { theme: tag, type, rate, mins, title, codes: stocks.map((s) => s.code) };
}

function fireNews() {
  try {
    const live = db.prepare("SELECT COUNT(*) AS c FROM stock_events WHERE status IN ('예약','진행중')").get().c;
    if (live >= 3) return null; // 과열 방지: 진행중 3개 이상이면 스킵
    const stocks = db.prepare("SELECT code, name FROM stocks WHERE status = '정상'").all();
    if (!stocks.length) return null;
    const s = stocks[randInt(0, stocks.length - 1)];
    const t = TEMPLATES[randInt(0, TEMPLATES.length - 1)];
    const title = t.titles[randInt(0, t.titles.length - 1)];
    const mag = rand(0.03, 0.12); // 틱당 가산 rate ±3~12%
    const rate = t.dir > 0 ? mag : -mag;
    const mins = randInt(3, 10);
    const now = new Date();
    const fmt = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
    const start = fmt(now);
    const end = fmt(new Date(now.getTime() + mins * 60 * 1000));
    const r = db.prepare(
      'INSERT INTO stock_events (stock_code, type, rate, status, reason, start_at, end_at) VALUES (?,?,?,?,?,?,?)'
    ).run(s.code, t.type, Number(rate.toFixed(4)), '진행중', `[자동뉴스] ${title}`, start, end);
    const arrow = t.dir > 0 ? '📈' : '📉';
    db.prepare(
      'INSERT INTO notices (scope, stock_code, title, body, pinned, by_admin) VALUES (?,?,?,?,0,?)'
    ).run(
      '종목',
      s.code,
      `[속보] ${s.name} ${title} ${arrow}`,
      `자동 뉴스: ${s.name}(${s.code}) ${t.type} 이벤트 발생. 약 ${mins}분간 시세에 ${t.dir > 0 ? '+' : ''}${(rate * 100).toFixed(1)}%/틱 영향. (투자 판단은 본인 책임, 모의투자임)`,
      null
    );
    console.log(`[news] ${s.code} ${t.type} ${rate.toFixed(3)} ${mins}분 :: ${title}`);
    return { id: r.lastInsertRowid, code: s.code, type: t.type, rate, mins, title };
  } catch (e) {
    console.error('[news] fire failed:', e.message);
    return null;
  }
}

function startNewsLoop() {
  const schedule = () => {
    const ms = nextDelayMs();
    const t = setTimeout(() => {
      // 절반 확률로 테마 뉴스, 절반은 단일 종목 뉴스
      if (Math.random() < 0.5) fireThemeNews();
      else fireNews();
      schedule();
    }, ms);
    if (t.unref) t.unref();
  };
  schedule();
  return { fireNews, fireThemeNews, nextDelayMs };
}

module.exports = { fireNews, fireThemeNews, startNewsLoop, nextDelayMs };
