const express = require('express');
const session = require('express-session');
const path = require('path');

const db = require('./db'); // 시드 실행용 (import side-effect)
const authRouter = require('./routes/auth');
const stocksRouter = require('./routes/stocks');
const tradeRouter = require('./routes/trade');
const portfolioRouter = require('./routes/portfolio');
const boardRouter = require('./routes/board');
const adminRouter = require('./routes/admin');
const { startPriceLoop } = require('./price');

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
app.use('/api', portfolioRouter);
app.use('/api', boardRouter);
app.use('/api/admin', adminRouter);
startPriceLoop();

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
