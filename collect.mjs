// 시세 수집 스크립트 (Node 20+, 외부 패키지 없음)
// GitHub Actions가 주기적으로 실행해서 market.json 을 만들어요.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

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
  const prevData = loadPrev();
  const prevItem = key => prevData?.items?.find(i => i.key === key) || null;

  const quotes = {};
  const errors = {};
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

  const out = { updated: new Date().toISOString(), items, errors };
  writeFileSync(process.env.OUT_FILE || 'market.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));

  // 하나도 못 가져왔고 이전 값도 없으면 실패로 표시 (Actions 탭에서 빨간 불로 알 수 있게)
  if (items.length === 0) { console.error('시세를 하나도 가져오지 못했어요.'); process.exit(1); }
}
main();

