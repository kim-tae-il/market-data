// 시세 수집 스크립트 (Node 20+, 외부 패키지 없음)
// GitHub Actions가 주기적으로 실행해서 market.json 을 만들어요.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createSign } from 'node:crypto';

const UA = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 가져올 지수/시세 (Yahoo Finance 심볼)
const SYMBOLS = {
  usdkrw: 'KRW=X',
  gold:   'GC=F',      // 국제 금 선물 (USD/트로이온스)
  kospi:  '^KS11',
  kosdaq: '^KQ11',
  nasdaq: '^IXIC',
  spx:    '^GSPC',
};

async function yahoo(symbol) {
  const tries = [];
  for (const host of ['query1', 'query2']) {
    for (let i = 0; i < UA.length; i++) tries.push([host, UA[i]]);
  }
  let lastErr;
  for (const [host, ua] of tries) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d`;
      const res = await fetch(url, { headers: { 'User-Agent': ua, 'Accept': 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      const price = Number(meta?.regularMarketPrice);
      const prev = Number(meta?.chartPreviousClose ?? meta?.previousClose);
      if (!Number.isFinite(price) || price <= 0) throw new Error('가격 없음');
      return { price, prev: Number.isFinite(prev) && prev > 0 ? prev : null, time: meta?.regularMarketTime ?? null };
    } catch (e) {
      lastErr = e;
      await sleep(800);
    }
  }
  throw lastErr;
}

// 환율은 Yahoo가 막히면 무료 공개 API로 대체 (하루 1회 갱신이라 등락률은 없음)
async function fxFallback() {
  const res = await fetch('https://open.er-api.com/v6/latest/USD');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  const krw = Number(j?.rates?.KRW);
  if (!Number.isFinite(krw) || krw <= 0) throw new Error('환율 없음');
  return { price: krw, prev: null, time: null };
}


// ---- 내 포트폴리오(Firestore, 비공개) ----
// 보안 규칙으로 로그인한 가족만 읽을 수 있어서, 서비스 계정(FIREBASE_SERVICE_ACCOUNT 비밀값)으로 읽고 써요.
// 비밀값이 없으면 개인 데이터는 건드리지 않고 공개 시세(market.json)만 만들어요.
const PROJECT = process.env.FIREBASE_PROJECT || 'dj-portfolio-f5e77';
const DOCS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
// 로그인하지 않은 방문자에게 보여줄 샘플 종목 (공개 시세에 포함돼요)
const DEMO_US = [['AAPL', '애플'], ['NVDA', '엔비디아'], ['TSLA', '테슬라']];
const DEMO_KR = [['005930', '삼성전자'], ['000660', 'SK하이닉스']];

function fsVal(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsVal);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fsVal(x)]));
  return null;
}
let TOKEN = null;
async function fsAuth() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return false;
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3000,
  });
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }),
  });
  const j = await res.json();
  if (!res.ok || !j.access_token) throw new Error('서비스 계정 인증 실패: ' + (j.error_description || j.error || res.status));
  TOKEN = j.access_token;
  return true;
}
// 문서 읽기: 없으면 null, 그 외 오류는 throw
async function fsGet(path) {
  const res = await fetch(`${DOCS}/${path}`, { headers: { Authorization: 'Bearer ' + TOKEN } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore ${path} HTTP ${res.status}`);
  const j = await res.json();
  return Object.fromEntries(Object.entries(j.fields || {}).map(([k, x]) => [k, fsVal(x)]));
}
// 문서 쓰기: 값은 JSON 문자열 하나(json)로 저장 (보안 규칙상 클라이언트는 읽기만 가능)
async function fsSetJson(path, obj, extra = {}) {
  const fields = { json: { stringValue: JSON.stringify(obj) } };
  for (const [k, v] of Object.entries(extra)) fields[k] = { stringValue: String(v) };
  const res = await fetch(`${DOCS}/${path}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`Firestore 쓰기 ${path} HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}
async function loadPortfolio() { return fsGet('portfolio/data'); }
// 한국 종목: 6자리 코드면 .KS/.KQ 순서로 시도, 코드가 없거나 이상하면 종목명으로 Yahoo 검색
async function krQuote(h) {
  const code = String(h.ticker || '').trim();
  const cands = [];
  if (/^[0-9A-Za-z]{6}$/.test(code)) cands.push(code.toUpperCase() + '.KS', code.toUpperCase() + '.KQ');
  else if (/\.(KS|KQ)$/i.test(code)) cands.push(code.toUpperCase());
  else {
    try {
      const r = await fetch('https://query2.finance.yahoo.com/v1/finance/search?lang=ko-KR&region=KR&quotesCount=8&newsCount=0&q=' + encodeURIComponent(code || h.name), { headers: { 'User-Agent': UA[0] } });
      const j = await r.json();
      for (const q of j.quotes || []) if (/\.(KS|KQ)$/.test(q.symbol || '')) cands.push(q.symbol);
    } catch (_) {}
  }
  let err = new Error('종목을 찾지 못함');
  for (const sym of cands.slice(0, 3)) {
    try { return { ...(await yahoo(sym)), symbol: sym }; } catch (e) { err = e; }
  }
  throw err;
}


// ---- 순자산 계산 (페이지의 renderSummary와 같은 방식) → 하루 1개씩 기록 ----
function netWorth(pf, qo) {
  const num = x => parseFloat(x) || 0;
  const rows = (pf.fx || []).filter(f => num(f.krw) > 0 && num(f.usd) > 0);
  let fxKrw = 0, usdTot = 0;
  rows.forEach(f => { fxKrw += num(f.krw); usdTot += num(f.usd); });
  const avg = usdTot ? fxKrw / usdTot : 0;
  const rate = qo.fx > 0 ? qo.fx : avg;
  let stCost = 0, stVal = 0;
  (pf.holdings || []).forEach(h => {
    const c = num(h.avg) * num(h.qty); stCost += c;
    const q = qo.us[String(h.ticker || '').trim().toUpperCase()];
    stVal += q && q.price > 0 ? q.price * num(h.qty) : c;
  });
  let gG = 0, gK = 0;
  (pf.gold || []).forEach(r => { gG += num(r.grams); gK += num(r.krw); });
  const gVal = qo.goldPerG > 0 ? gG * qo.goldPerG : gK;
  let krCost = 0, krVal = 0;
  (pf.kr || []).forEach(h => {
    const c = num(h.avg) * num(h.qty); krCost += c;
    const q = qo.kr[String(h.ticker || h.name || '').trim()];
    krVal += q && q.price > 0 ? q.price * num(h.qty) : c;
  });
  const cash = usdTot - stCost;
  const P = (usdTot > 0 ? cash * avg : 0) + gK + stCost * avg + krCost;
  const V = (usdTot > 0 ? cash * rate : 0) + gVal + stVal * rate + krVal;
  return { p: Math.round(P), v: Math.round(V) };
}

const nf = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pctOf = q => (q && q.prev ? Math.round(((q.price - q.prev) / q.prev) * 10000) / 100 : null);

function loadPrev() {
  try {
    const f = process.env.PREV_FILE;
    if (f && existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  } catch (_) {}
  return null;
}

async function main() {
  const prevData = loadPrev();                       // 공개 market.json (이전)
  const errors = {};

  // 비공개 저장소 연결 (가족 데이터)
  let priv = false, prevLive = null, pf = null, histDoc = null, histOk = false;
  try { priv = await fsAuth(); } catch (e) { errors.auth = String(e.message || e); }
  if (priv) {
    try { pf = await loadPortfolio(); } catch (e) { errors.portfolio = String(e.message || e); }
    try { const d = await fsGet('portfolio/live'); prevLive = d && d.json ? JSON.parse(d.json) : null; } catch (e) { errors.live = String(e.message || e); }
    try { histDoc = await fsGet('portfolio/history'); histOk = true; } catch (e) { errors.historyRead = String(e.message || e); }
  } else if (!errors.auth) {
    console.log('FIREBASE_SERVICE_ACCOUNT 비밀값이 없어서 공개 시세만 만들어요.');
  }
  const prevItem = key => prevData?.items?.find(i => i.key === key) || prevLive?.items?.find(i => i.key === key) || null;

  const quotes = {};
  for (const [key, sym] of Object.entries(SYMBOLS)) {
    try { quotes[key] = await yahoo(sym); }
    catch (e) {
      errors[key] = String(e.message || e);
      if (key === 'usdkrw') {
        try { quotes[key] = await fxFallback(); delete errors[key]; } catch (e2) { errors[key] = String(e2.message || e2); }
      }
    }
    await sleep(300);
  }

  const items = [];
  const push = (key, label, build) => {
    const q = quotes[key];
    if (q) {
      items.push({ key, label, ...build(q), stale: false });
    } else {
      const old = prevItem(key);
      if (old) items.push({ ...old, stale: true });
    }
  };

  push('usdkrw', '원/달러', q => ({ value: nf(q.price, 2), unit: '원', pct: pctOf(q) }));

  // 금: 국제 금 선물(USD/oz) × 환율 → 원화 1돈(3.75g) 가격으로 환산 (한국 현물 시세와는 프리미엄·부가세 차이가 있어요)
  if (quotes.gold && quotes.usdkrw) {
    const won = quotes.gold.price * quotes.usdkrw.price / 31.1034768 * 3.75;
    items.push({
      key: 'gold', label: '금', value: nf(Math.round(won), 0), unit: '원/돈 (국제시세 환산)',
      sub: '$' + nf(quotes.gold.price, 1) + '/oz', pct: pctOf(quotes.gold), stale: false,
    });
  } else {
    const old = prevItem('gold');
    if (old) items.push({ ...old, stale: true });
  }

  push('kospi',  '코스피',   q => ({ value: nf(q.price, 2), unit: '', pct: pctOf(q) }));
  push('kosdaq', '코스닥',   q => ({ value: nf(q.price, 2), unit: '', pct: pctOf(q) }));
  push('nasdaq', '나스닥',   q => ({ value: nf(q.price, 2), unit: '', pct: pctOf(q) }));
  push('spx',    'S&P 500', q => ({ value: nf(q.price, 2), unit: '', pct: pctOf(q) }));
  const baseItems = items.slice();                    // 시장 공통 항목 (공개)

  // ---- 종목 시세 조회 (같은 종목은 한 번만) ----
  const prevQP = prevData?.quotes || { us: {}, kr: {} };
  const prevQL = prevLive?.quotes || { us: {}, kr: {} };
  const usC = new Map(), krC = new Map();
  const getUS = async t => {
    if (!usC.has(t)) { try { usC.set(t, await yahoo(t)); } catch (e) { usC.set(t, { err: String(e.message || e) }); } await sleep(300); }
    return usC.get(t);
  };
  const getKR = async (k, h) => {
    if (!krC.has(k)) { try { krC.set(k, await krQuote(h)); } catch (e) { krC.set(k, { err: String(e.message || e) }); } await sleep(300); }
    return krC.get(k);
  };
  const fxPrice = quotes.usdkrw ? quotes.usdkrw.price : null;
  const goldPerG = (quotes.gold && quotes.usdkrw) ? Math.round(quotes.gold.price * quotes.usdkrw.price / 31.1034768) : null;
  // 한 묶음(공개용 샘플 / 비공개 내 종목)을 만들어요
  const build = async (usList, krList, prevQ, label) => {
    const o = { fx: fxPrice ?? (prevQ.fx ?? null), goldPerG: goldPerG ?? (prevQ.goldPerG ?? null), us: {}, kr: {} };
    const its = [];
    const seen = new Set();
    for (const [t, name] of usList) {
      if (!t || seen.has('u' + t)) continue; seen.add('u' + t);
      const q = await getUS(t);
      if (q.price) {
        o.us[t] = { price: q.price, pct: pctOf(q) };
        its.push({ key: 'us:' + t, label: name || t, value: '$' + nf(q.price, 2), unit: '', pct: pctOf(q), stale: false, mine: true });
      } else {
        errors[label + 'us:' + t] = q.err;
        if (prevQ.us?.[t]) o.us[t] = prevQ.us[t];
        const old = prevItem('us:' + t); if (old) its.push({ ...old, stale: true });
      }
    }
    for (const [k, name, h] of krList) {
      if (!k || seen.has('k' + k)) continue; seen.add('k' + k);
      const q = await getKR(k, h);
      if (q.price) {
        o.kr[k] = { price: q.price, pct: pctOf(q), symbol: q.symbol };
        its.push({ key: 'kr:' + k, label: name || k, value: nf(Math.round(q.price), 0), unit: '원', pct: pctOf(q), stale: false, mine: true });
      } else {
        errors[label + 'kr:' + k] = q.err;
        if (prevQ.kr?.[k]) o.kr[k] = prevQ.kr[k];
        const old = prevItem('kr:' + k); if (old) its.push({ ...old, stale: true });
      }
    }
    return { q: o, items: its };
  };

  // 1) 공개 market.json: 시장 시세 + 샘플 종목만 (개인 정보 없음)
  const pub = await build(DEMO_US, DEMO_KR.map(([c, n]) => [c, n, { ticker: c, name: n }]), prevQP, 'demo:');
  const pubOut = { updated: new Date().toISOString(), items: [...baseItems, ...pub.items], quotes: pub.q, errors: {} };
  for (const k of Object.keys(errors)) if (!/^(auth|portfolio|live|historyRead|history|private)/.test(k)) pubOut.errors[k] = errors[k];
  writeFileSync(process.env.OUT_FILE || 'market.json', JSON.stringify(pubOut, null, 2));

  // 2) 비공개: 내 종목 시세 + 순자산 기록 → Firestore (가족만 읽기 가능)
  if (priv && pf) {
    try {
      const mine = await build(
        (pf.holdings || []).map(h => [String(h.ticker || '').trim().toUpperCase(), h.name]),
        (pf.kr || []).map(h => [String(h.ticker || h.name || '').trim(), h.name, h]),
        prevQL, '');
      let history = [];
      try { if (histDoc?.json) history = JSON.parse(histDoc.json).history || []; } catch (_) {}
      let intraday = (Array.isArray(prevLive?.intraday) ? prevLive.intraday : []).filter(x => Date.now() - x.t < 48 * 3600e3);
      const nw = netWorth(pf, mine.q);
      let histWrite = histOk;                         // 기록을 못 읽었으면 덮어쓰지 않아요 (기록 보호)
      if (nw.p > 0) {
        const d = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);   // 한국 날짜
        const pt = { d, v: nw.v, p: nw.p };
        if (history.length && history[history.length - 1].d === d) history[history.length - 1] = pt; else history.push(pt);
        intraday.push({ t: Date.now(), v: nw.v });
      }
      const live = { updated: pubOut.updated, items: [...baseItems, ...mine.items], quotes: mine.q, intraday };
      await fsSetJson('portfolio/live', live, { updated: live.updated });
      if (histWrite && history.length) await fsSetJson('portfolio/history', { history });
      else if (!histWrite) errors.history = '기록을 읽지 못해 이번에는 기록 저장을 건너뜀';
    } catch (e) { errors.private = String(e.message || e); console.error('비공개 저장 실패:', errors.private); process.exitCode = 1; }
  }
  console.log(JSON.stringify({ ...pubOut, privateErrors: Object.fromEntries(Object.entries(errors).filter(([k]) => /^(auth|portfolio|live|historyRead|history|private)/.test(k))) }, null, 2));
  if (errors.auth || errors.portfolio) process.exitCode = 1;

  // 하나도 못 가져왔고 이전 값도 없으면 실패로 표시 (Actions 탭에서 빨간 불로 알 수 있게)
  if (pubOut.items.length === 0) { console.error('시세를 하나도 가져오지 못했어요.'); process.exit(1); }
}
main();
