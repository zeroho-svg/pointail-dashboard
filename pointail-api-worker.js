/**
 * ─────────────────────────────────────────────────────────────
 *  Pointail ↔ Storelink Admin API 프록시 (Cloudflare Worker) — 자동 로그인판
 * ─────────────────────────────────────────────────────────────
 *  Worker가 이메일/비번으로 직접 로그인 → 토큰 획득 → 캠페인 전량 수집
 *  → 대시보드 스키마로 매핑 → CORS 붙여 JSON 제공.
 *  토큰 만료 시 자동 재로그인. 사용자는 대시보드 버튼만 누르면 됨(완전 자동).
 *
 *  ── Cloudflare 시크릿 설정 (Settings → Variables and Secrets, Encrypt) ──
 *     ADMIN_ID = 어드민 로그인 아이디(이메일)      (자동로그인 필수)
 *     ADMIN_PW = 어드민 로그인 비밀번호            (자동로그인 필수)
 *     ALLOW_ORIGIN = https://zeroho-svg.github.io  (선택)
 *     API_TOKEN = <X-Auth-Token>                   (선택·수동 폴백용)
 *  ※ ADMIN_ID/ADMIN_PW가 있으면 자동 로그인, 없으면 API_TOKEN(수동) 사용.
 *
 *  로그인: POST /stl/users/sign-in  body {userId, userPw, registerSite:"stl"}
 *          → result.token 을 X-Auth-Token 으로 사용.
 * ─────────────────────────────────────────────────────────────
 */

const API_BASE = "https://apia-v2.storelink.io";
const CAMPAIGN_SEARCH = "/pug/jp/campaigns/search";
const SIGN_IN = "/stl/users/sign-in";
const REGISTER_SITE = "stl";
const CACHE_TTL_SEC = 600;                 // 데이터 응답 캐시(10분)
const TOKEN_TTL_SEC = 3000;                // 토큰 캐시(50분)
const TOKEN_CACHE_KEY = "https://pointail-token-cache/internal";
const UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36";

function upstreamHeaders(extra) {
  return Object.assign({
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "ko-KR,ko;q=0.9",
    "Origin": "https://admin.storelink.io",
    "Referer": "https://admin.storelink.io/",
    "User-Agent": UA,
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
  }, extra || {});
}

// ── 로그인 → 토큰 발급 ──
async function login(env) {
  if (!env.ADMIN_ID || !env.ADMIN_PW) throw new Error("ADMIN_ID/ADMIN_PW 시크릿이 설정되지 않았습니다.");
  const res = await fetch(API_BASE + SIGN_IN, {
    method: "POST",
    headers: upstreamHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ userId: env.ADMIN_ID, userPw: env.ADMIN_PW, registerSite: REGISTER_SITE }),
  });
  const j = await res.json().catch(() => ({}));
  const token = j && j.result && j.result.token;
  if (!token) throw new Error("로그인 실패: " + (j.message || j.messageCode || ("HTTP " + res.status)));
  return token;
}

// ── 토큰 얻기(캐시 우선, forceNew 시 재로그인) ──
async function getAutoToken(env, ctx, forceNew) {
  const cache = caches.default, key = new Request(TOKEN_CACHE_KEY);
  if (!forceNew) {
    const hit = await cache.match(key);
    if (hit) { const t = await hit.text(); if (t) return t; }
  }
  const token = await login(env);
  ctx.waitUntil(cache.put(key, new Response(token, { headers: { "Cache-Control": "max-age=" + TOKEN_TTL_SEC } })));
  return token;
}

// ── 캠페인 전 페이지 수집 ──
async function fetchAllCampaigns(token, dateType, pageSize) {
  const all = [];
  let page = 1, totalPage = 1, guard = 0, unauthorized = false;
  do {
    const api = `${API_BASE}${CAMPAIGN_SEARCH}?campaignDateSearchType=${dateType}&page=${page}&pageSize=${pageSize}`;
    const res = await fetch(api, { headers: upstreamHeaders({ "X-Auth-Token": token }) });
    if (res.status === 401) { unauthorized = true; break; }
    if (!res.ok) throw new Error("상위 API 오류 " + res.status);
    const body = await res.json();
    const list = (body.result && body.result.campaigns) || [];
    all.push.apply(all, list);
    totalPage = (body.page && body.page.totalPage) || (list.length < pageSize ? page : page + 1);
    page++; guard++;
  } while (page <= totalPage && guard < 100);
  return { all, unauthorized };
}

export default {
  async fetch(request, env, ctx) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);

    // ── 공유 제외목록 (KV) : 여러 컴퓨터에서 누적 공유 ──
    //   GET  /exclusions          → 저장된 제외목록(JSON) 반환
    //   PUT  /exclusions  body=JSON → 제외목록 저장(덮어쓰기)
    if (url.pathname === "/exclusions") {
      if (!env.PT_KV) return json({ error: "KV(PT_KV) 바인딩이 설정되지 않았습니다." }, 500, cors);
      if (request.method === "GET") {
        const v = await env.PT_KV.get("excluded_camps");
        return new Response(v || "{}", { status: 200, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, cors) });
      }
      if (request.method === "PUT") {
        const body = await request.text();
        try { JSON.parse(body || "{}"); } catch (e) { return json({ error: "잘못된 JSON" }, 400, cors); }
        await env.PT_KV.put("excluded_camps", body || "{}");
        return json({ ok: true }, 200, cors);
      }
      return json({ error: "허용되지 않은 메서드" }, 405, cors);
    }

    const autoMode = !!(env.ADMIN_ID && env.ADMIN_PW);

    if (url.searchParams.get("diag") === "1") {
      return json({ mode: autoMode ? "auto-login" : "manual-token", hasId: !!env.ADMIN_ID, hasPw: !!env.ADMIN_PW, hasApiToken: !!env.API_TOKEN, hasKV: !!env.PT_KV, registerSite: REGISTER_SITE }, 200, cors);
    }

    const raw = url.searchParams.get("raw") === "1";
    const noCache = url.searchParams.get("refresh") === "1";
    const cache = caches.default, cacheKey = new Request(url.toString(), request);
    if (!noCache) { const hit = await cache.match(cacheKey); if (hit) return withCors(hit, cors); }

    try {
      const pageSize = clampInt(url.searchParams.get("pageSize"), 200, 1, 200);
      const dateType = url.searchParams.get("campaignDateSearchType") || "CREATE_DATE";

      // 토큰 확보: 자동 로그인 우선, 없으면 수동 API_TOKEN
      let token;
      if (autoMode) token = await getAutoToken(env, ctx, false);
      else token = (env.API_TOKEN || "").trim();
      if (!token) return json({ error: "로그인 정보(ADMIN_ID/ADMIN_PW) 또는 API_TOKEN 시크릿이 필요합니다." }, 500, cors);

      let r = await fetchAllCampaigns(token, dateType, pageSize);
      if (r.unauthorized && autoMode) {            // 토큰 만료 → 재로그인 후 1회 재시도
        token = await getAutoToken(env, ctx, true);
        r = await fetchAllCampaigns(token, dateType, pageSize);
      }
      if (r.unauthorized) return json({ error: "인증 실패(401): 로그인 정보(ADMIN_ID/ADMIN_PW)를 확인하세요." }, 401, cors);

      const campaigns = raw ? r.all : r.all.map(mapCampaign);
      const payload = { source: "storelink-apia-v2", mode: autoMode ? "auto-login" : "manual-token", fetchedAt: new Date().toISOString(), count: campaigns.length, campaigns };
      const response = json(payload, 200, cors);
      ctx.waitUntil(cache.put(cacheKey, json(payload, 200, Object.assign({}, cors, { "Cache-Control": "max-age=" + CACHE_TTL_SEC }))));
      return response;
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500, cors);
    }
  },
};

// ── API enum → 대시보드(캠페인DB) 한국어 값 매핑 ──────────────
const TYPE_MAP    = { SHOPPING: "쇼핑", INFLUENCER: "인플루언서", PLACE: "플레이스", REWARD: "리워드" };
const SVC_MAP     = { PUGSHOP: "퍼그샵", POINTAIL_BIZ: "포인테일 비즈", STORELINK: "스토어링크" };
const STATE_MAP   = { SELECT_SUCCESS: "선정 완료", ADD_RECRUIT: "추가 모집중", REGISTER_WAITING: "등록 대기", REGISTER: "등록", REGISTER_CANCEL: "등록 취소", REGISTER_SUCCESS: "등록 완료", RECRUIT: "모집중", STOP: "일시 중지", CAMPAIGN_CLOSE: "캠페인 종료", CAMPAIGN_CANCEL: "캠페인 취소" };
const MEMBER_MAP  = { COMMON_ADVERTISER: "일반 광고주", AGENCY: "대행사" };
const COUNTRY_MAP = { KR: "한국", JP: "일본" };
const PAYSTATE_MAP= { PAYMENT_WAIT: "결제대기", PAYMENT_SUCCESS: "결제완료", PAYMENT_CANCEL: "결제취소" };

function amt(o) { return o && typeof o.amount === "number" ? o.amount : 0; }
function yn(v)  { return v === "Y" ? "예" : (v === "N" ? "아니오" : ""); }
function dt(s)  { return (s || "").replace("T", " ").slice(0, 19); }

function mapCampaign(c) {
  const round = (c.currentSelRndNum != null && c.selRndNum != null)
    ? (c.currentSelRndNum + "/" + c.selRndNum)
    : (c.selRndNum != null ? String(c.selRndNum) : "");
  return {
    campaignNo:        c.campaignNo,
    marketingType:     SVC_MAP[c.campaignServiceType] || c.campaignServiceType || "",
    marketingNo:       c.smNo != null ? c.smNo : "",
    originalCampaignNo: c.originCampaignNo != null ? c.originCampaignNo : "",
    campaignStatus:    STATE_MAP[c.campaignState] || c.campaignState || "",
    payStatus:         PAYSTATE_MAP[c.paymentState] || "",
    campaignType:      TYPE_MAP[c.campaignType] || c.campaignType || "",
    campaignTitle:     c.campaignNm || "",
    storeName:         c.storeNm || "",
    corpName:          c.corporateNm || "",
    advertiserCountry: COUNTRY_MAP[c.corporateCountry] || "",
    companyType:       MEMBER_MAP[c.advMemberType] || "",
    shoppingChannel:   c.storeChnnlNm || "",
    category:          c.prdctClss || "",
    selectionType:     c.selType || "",
    roundInfo:         round,
    recruitCount:      c.totalRecruitNum || 0,
    applicantCount:    c.totalApplyNum || 0,
    selectedCount:     c.totalSelNum || 0,
    missionDoneCount:  c.totalMsnFinishNum || 0,
    opManager:         c.opManagerNm || "",
    salesManager:      c.salesManagerNm || "",
    pointRevenue:      c.campaignPointAmt || 0,
    contractSaleSum:   amt(c.totalCampaignCostAmt),
    contractMktCost:   amt(c.subtotalCampaignCostAmt),
    contractVat:       amt(c.vatAmt),
    contractFinal:     amt(c.totalCampaignPaymentAmt),
    payRequested:      yn(c.paymentYn),
    hidden:            yn(c.campaignHiddenYn),
    contractSalePrice: amt(c.totalPaymentAmt),
    execMissionDone:   c.currentFinishedApplierNum || 0,
    execMktAmount:     amt(c.currentOriginSubtotalCampaignCostAmt),
    execDiscount:      amt(c.currentDiscountAmt),
    execNetAmount:     amt(c.currentSubtotalCampaignCostAmt),
    execTotalAmount:   amt(c.currentTotalCampaignPaymentAmt),
    forceStopType:     c.forceCloseType || "",
    pauseType:         c.campaignStopType || "",
    recruitStartAt:    dt(c.recruitBeginDt),
    createdAt:         dt(c.createDt),
    campaignNoText:    String(c.campaignNo),
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, headers || {}) });
}
function withCors(res, cors) { const h = new Headers(res.headers); for (const k in cors) h.set(k, cors[k]); return new Response(res.body, { status: res.status, headers: h }); }
function clampInt(v, d, min, max) { const n = parseInt(v || d, 10); return isNaN(n) ? d : Math.max(min, Math.min(max, n)); }
