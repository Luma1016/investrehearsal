// 시간 기준: 한국 wall-clock(KST, UTC+9) 문자열 'YYYY-MM-DD HH:MM:SS'
// Render 등 해외 서버(TZ=UTC)에서도 시간이 어긋나지 않도록 JS 생성 시각은 전부 KST로 통일.
// DB DEFAULT(datetime('now','localtime'))는 서버 로컬과만 비교하므로 그대로 둠.
const KST_OFFSET = 9 * 60 * 60 * 1000;

function kDate(d) {
  return new Date((d || new Date()).getTime() + KST_OFFSET);
}
function pad(n) {
  return String(n).padStart(2, '0');
}
// KST 현재 시각 문자열 (Date 전달 시 그 시각의 KST 표기)
function kNow(d) {
  const k = kDate(d);
  return `${k.getUTCFullYear()}-${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())} ${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}:${pad(k.getUTCSeconds())}`;
}
// KST 오늘 날짜
function kToday() {
  const d = kDate();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
// KST 문자열 + N분 → KST 문자열
function kPlusMinutes(iso, mins) {
  const d = new Date(String(iso).replace(' ', 'T') + '+09:00');
  if (isNaN(d)) return null;
  return kNow(new Date(d.getTime() + mins * 60000));
}
// KST 문자열 → Date (표시·비교용)
function kParse(s) {
  return new Date(String(s).replace(' ', 'T') + '+09:00');
}

module.exports = { kNow, kToday, kPlusMinutes, kParse };
