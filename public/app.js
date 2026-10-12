async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    if (!location.pathname.endsWith('login.html')) {
      location.href = '/login.html';
    }
    throw new Error('LOGIN_REQUIRED');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || ('HTTP_' + res.status));
  }
  return data;
}

function toast(msg) {
  alert(msg);
}

function fmt(n) {
  return Number(n || 0).toLocaleString('ko-KR') + '원';
}
