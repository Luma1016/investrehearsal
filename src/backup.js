// Supabase Storage 백업/복구 (A안)
// - 부팅 시: 로컬 DB가 없으면(무료 플랜 재시작 등) 원격 스냅샷 다운로드 후 시작
// - 주기 업로드: db.backup() 일관 스냅샷을 N분마다 업로드 (WAL 불일치 없음)
// - 환경변수 미설정 시 전부 스킵 → 기존 로컬 동작 그대로
// 필요 env: SUPABASE_URL, SUPABASE_SERVICE_KEY(service_role),
//   BACKUP_BUCKET(기본 db-backups), BACKUP_KEY(기본 db.sqlite),
//   BACKUP_INTERVAL_MIN(기본 5), RESTORE_OVERWRITE=1(로컬 있어도 덮어쓰기)
const fs = require('fs');
const path = require('path');
const os = require('os');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db.sqlite');
const BUCKET = process.env.BACKUP_BUCKET || 'db-backups';
const KEY = process.env.BACKUP_KEY || 'db.sqlite';
const INTERVAL_MIN = Number(process.env.BACKUP_INTERVAL_MIN) || 5;

function configured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

function client() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
}

async function ensureBucket(sb) {
  const { error } = await sb.storage.createBucket(BUCKET, { public: false });
  if (error && !/exists|duplicate|already/i.test(error.message || '')) throw error;
}

// 부팅 시 복구: 반드시 db 로드보다 먼저 호출될 것
async function restoreIfNeeded() {
  if (!configured()) {
    console.log('[backup] supabase 미설정 → 로컬 DB 사용');
    return;
  }
  const sb = client();
  await ensureBucket(sb);
  if (fs.existsSync(DB_PATH) && process.env.RESTORE_OVERWRITE !== '1') {
    console.log('[backup] 로컬 DB 존재 → 복구 생략');
    return;
  }
  const { data, error } = await sb.storage.from(BUCKET).download(KEY);
  if (error || !data) {
    console.log('[backup] 원격 백업 없음 → 새로 시작 (' + (error ? error.message : 'empty') + ')');
    return;
  }
  const buf = Buffer.from(await data.arrayBuffer());
  for (const s of ['-shm', '-wal']) {
    try {
      fs.unlinkSync(DB_PATH + s);
    } catch (e) { /* 없음 */ }
  }
  fs.writeFileSync(DB_PATH, buf);
  console.log(`[backup] 복구 완료 (${(buf.length / 1024).toFixed(0)}KB)`);
}

let uploading = false;
async function uploadOnce() {
  if (!configured() || uploading) return;
  uploading = true;
  const tmp = path.join(os.tmpdir(), `sw-backup-${Date.now()}.sqlite`);
  try {
    const db = require('./db');
    await db.backup(tmp);
    const sb = client();
    await ensureBucket(sb);
    const { error } = await sb.storage.from(BUCKET).upload(KEY, fs.readFileSync(tmp), {
      upsert: true,
      contentType: 'application/octet-stream',
    });
    if (error) throw error;
    console.log('[backup] 업로드 완료');
  } catch (e) {
    console.error('[backup] 업로드 실패:', e.message);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (e) { /* 무시 */ }
    uploading = false;
  }
}

function startBackupLoop() {
  if (!configured()) return null;
  uploadOnce(); // 부팅 직후 1회
  const t = setInterval(uploadOnce, Math.max(1, INTERVAL_MIN) * 60000);
  if (t.unref) t.unref();
  console.log(`[backup] 주기 업로드 ${Math.max(1, INTERVAL_MIN)}분 간격`);
  return t;
}

module.exports = { restoreIfNeeded, startBackupLoop, uploadOnce, configured };
