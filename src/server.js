const express = require('express');
const session = require('express-session');
const path = require('path');

const db = require('./db'); // 시드 실행용 (import side-effect)
const authRouter = require('./routes/auth');
const stocksRouter = require('./routes/stocks');
const { router: tradeRouter } = require('./routes/trade');
const { router: indicesRouter } = require('./routes/indices');
const { router: challengeRouter } = require('./routes/challenge');
const portfolioRouter = require('./routes/portfolio');
const boardRouter = require('./routes/board');
const adminRouter = require('./routes/admin');
const { startPriceLoop } = require('./price');
const { startNewsLoop } = require('./news');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'invest-rehearsal-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    },
  })
);

// 헬스체크 (인증 없이, 라우터보다 먼저 등록해야 requireLogin에 가려지지 않음)
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// 1단계: Auth + 2단계: Stocks/Trade/Portfolio + 3단계: Board + 4단계: Admin
app.use('/api/auth', authRouter);
app.use('/api/stocks', stocksRouter);
app.use('/api/trade', tradeRouter);
// 공개 라우터(board·indices)를 로그인 전용(portfolio)보다 먼저 장착해야
// GET /api/notices·/api/indices 같은 공개 API가 requireLogin에 가로막히지 않음
app.use('/api', boardRouter);
app.use('/api/indices', indicesRouter);
app.use('/api/challenges', challengeRouter);
app.use('/api', portfolioRouter);
app.use('/api/admin', adminRouter);
startPriceLoop(10000); // 10초 틱: 형성 중 봉이 실시간으로 움직임 (분당 변동성은 1분틱과 동일하게 스케일)
startNewsLoop(); // 랜덤 뉴스: 5~60분마다 자동 이벤트+속보 공시 (무유저에도 동작)

// 정적 서빙 (public/*.html)
app.use(express.static(path.join(__dirname, '..', 'public')));

// /api 404 JSON
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'NOT_FOUND' });
});

// 루트는 index.html (static 미들웨어가 처리, 폴백)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] static: public/ | db: db.sqlite`);
});
