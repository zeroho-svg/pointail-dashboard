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
 *  ── KV 공유 저장 (Bindings: PT_KV) ──
 *     /exclusions  GET/PUT  → 캠페인 수동 제외목록(excluded_camps)
 *     /marketing   GET/PUT  → 마케팅 성과 입력 데이터(marketing_data)
 *
 *  로그인: POST /stl/users/sign-in  body {userId, userPw, registerSite:"stl"}
 *          → result.token 을 X-Auth-Token 으로 사용.
 * ─────────────────────────────────────────────────────────────
 */

const API_BASE = "https://apia-v2.storelink.io";
const CAMPAIGN_SEARCH = "/pug/jp/campaigns/search";
const ADVERTISER_SEARCH = "/pug/jp/advertiser/search";       // 광고주 회원 목록
const SALES_MANAGER = "/stl/users/sales-manager/pointail";   // 영업담당자(번호→이름)
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

// ── 영업담당자 번호→이름 매핑 ──
async function fetchSalesManagers(token) {
  try {
    const res = await fetch(API_BASE + SALES_MANAGER, { headers: upstreamHeaders({ "X-Auth-Token": token }) });
    if (!res.ok) return {};
    const j = await res.json();
    const users = (j.result && j.result.users) || [];
    const map = {};
    users.forEach(function (u) { if (u && u.userNo != null) map[u.userNo] = u.userNm || ""; });
    return map;
  } catch (e) { return {}; }
}

// ── 포인테일 앱 회원 월별 통계 수집 (누적 totalMemberCnt · 신규 newMemberCnt) ──
async function fetchAppMemberChart(token, beginDate, endDate) {
  try {
    const api = `${API_BASE}/pug/jp/dashboard/members/chart?timeUnit=MONTH&beginDate=${encodeURIComponent(beginDate)}&endDate=${encodeURIComponent(endDate)}`;
    const res = await fetch(api, { headers: upstreamHeaders({ "X-Auth-Token": token }) });
    if (res.status === 401) return { chart: [], unauthorized: true };
    if (!res.ok) return { chart: [], unauthorized: false };
    const j = await res.json();
    const chart = (j.result && j.result.memberChart) || [];
    return { chart, unauthorized: false };
  } catch (e) { return { chart: [], unauthorized: false }; }
}

// ── 광고주 회원 전 페이지 수집 ──
async function fetchAllAdvertisers(token, pageSize) {
  const all = [];
  let page = 1, totalPage = 1, guard = 0, unauthorized = false;
  do {
    const api = `${API_BASE}${ADVERTISER_SEARCH}?agreeAdvYn=&advMemberState=&salesManagerNo=&page=${page}&pageSize=${pageSize}`;
    const res = await fetch(api, { headers: upstreamHeaders({ "X-Auth-Token": token }) });
    if (res.status === 401) { unauthorized = true; break; }
    if (!res.ok) throw new Error("회원 API 오류 " + res.status);
    const body = await res.json();
    const list = (body.result && body.result.advertisers) || [];
    all.push.apply(all, list);
    totalPage = (body.page && body.page.totalPage) || (list.length < pageSize ? page : page + 1);
    page++; guard++;
  } while (page <= totalPage && guard < 300);
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

    // ── 마케팅 성과 입력 데이터 (KV) : 여러 컴퓨터에서 공유 ──
    //   GET  /marketing            → 저장된 마케팅 데이터(JSON) 반환
    //   PUT  /marketing  body=JSON → 마케팅 데이터 저장(덮어쓰기)
    if (url.pathname === "/marketing") {
      if (!env.PT_KV) return json({ error: "KV(PT_KV) 바인딩이 설정되지 않았습니다." }, 500, cors);
      if (request.method === "GET") {
        const v = await env.PT_KV.get("marketing_data");
        return new Response(v || "{}", { status: 200, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, cors) });
      }
      if (request.method === "PUT") {
        const body = await request.text();
        try { JSON.parse(body || "{}"); } catch (e) { return json({ error: "잘못된 JSON" }, 400, cors); }
        await env.PT_KV.put("marketing_data", body || "{}");
        return json({ ok: true }, 200, cors);
      }
      return json({ error: "허용되지 않은 메서드" }, 405, cors);
    }

    // ── 업체 소통방식 (KV) : 여러 컴퓨터에서 공유 ──
    //   GET  /contacts            → 저장된 소통방식(JSON) 반환
    //   PUT  /contacts  body=JSON → 소통방식 저장(덮어쓰기)
    if (url.pathname === "/contacts") {
      if (!env.PT_KV) return json({ error: "KV(PT_KV) 바인딩이 설정되지 않았습니다." }, 500, cors);
      if (request.method === "GET") {
        const v = await env.PT_KV.get("advertiser_contacts");
        return new Response(v || "{}", { status: 200, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, cors) });
      }
      if (request.method === "PUT") {
        const body = await request.text();
        try { JSON.parse(body || "{}"); } catch (e) { return json({ error: "잘못된 JSON" }, 400, cors); }
        await env.PT_KV.put("advertiser_contacts", body || "{}");
        return json({ ok: true }, 200, cors);
      }
      return json({ error: "허용되지 않은 메서드" }, 405, cors);
    }

    // ── 비용(마케팅비·경비&판매촉진비) 내역 (KV) : 여러 컴퓨터에서 공유 ──
    //   GET  /costs            → 저장된 비용 내역(JSON) 반환
    //   PUT  /costs  body=JSON → 비용 내역 저장(덮어쓰기)
    if (url.pathname === "/costs") {
      if (!env.PT_KV) return json({ error: "KV(PT_KV) 바인딩이 설정되지 않았습니다." }, 500, cors);
      if (request.method === "GET") {
        const v = await env.PT_KV.get("pointail_costs");
        return new Response(v || "{}", { status: 200, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, cors) });
      }
      if (request.method === "PUT") {
        const body = await request.text();
        try { JSON.parse(body || "{}"); } catch (e) { return json({ error: "잘못된 JSON" }, 400, cors); }
        await env.PT_KV.put("pointail_costs", body || "{}");
        return json({ ok: true }, 200, cors);
      }
      return json({ error: "허용되지 않은 메서드" }, 405, cors);
    }

    // ── 광고주 회원 목록 (어드민 /pug/jp/advertiser/search) ──
    //   GET /members  → 회원 전량 수집 + 대시보드 회원가입DB 스키마로 매핑
    if (url.pathname === "/members") {
      const autoM = !!(env.ADMIN_ID && env.ADMIN_PW);
      const rawM = url.searchParams.get("raw") === "1";
      const noCacheM = url.searchParams.get("refresh") === "1";
      const cacheM = caches.default, cacheKeyM = new Request(url.toString(), request);
      if (!noCacheM) { const hit = await cacheM.match(cacheKeyM); if (hit) return withCors(hit, cors); }
      try {
        let token;
        if (autoM) token = await getAutoToken(env, ctx, false);
        else token = (env.API_TOKEN || "").trim();
        if (!token) return json({ error: "로그인 정보(ADMIN_ID/ADMIN_PW) 또는 API_TOKEN 시크릿이 필요합니다." }, 500, cors);
        const pageSizeM = clampInt(url.searchParams.get("pageSize"), 200, 1, 200);
        let sm = await fetchSalesManagers(token);
        let r = await fetchAllAdvertisers(token, pageSizeM);
        if (r.unauthorized && autoM) { token = await getAutoToken(env, ctx, true); sm = await fetchSalesManagers(token); r = await fetchAllAdvertisers(token, pageSizeM); }
        if (r.unauthorized) return json({ error: "인증 실패(401): 로그인 정보(ADMIN_ID/ADMIN_PW)를 확인하세요." }, 401, cors);
        const members = rawM ? r.all : r.all.map(function (a) { return mapMember(a, sm); });
        const payload = { source: "storelink-advertiser", mode: autoM ? "auto-login" : "manual-token", fetchedAt: new Date().toISOString(), count: members.length, members };
        const response = json(payload, 200, cors);
        ctx.waitUntil(cacheM.put(cacheKeyM, json(payload, 200, Object.assign({}, cors, { "Cache-Control": "max-age=" + CACHE_TTL_SEC }))));
        return response;
      } catch (e) {
        return json({ error: String((e && e.message) || e) }, 500, cors);
      }
    }

    // ── 포인테일 앱 회원 월별 통계 (어드민 /pug/jp/dashboard/members/chart) ──
    //   GET /app-members  → 월별 memberChart(누적 totalMemberCnt · 신규 newMemberCnt 등)
    if (url.pathname === "/app-members") {
      const autoA = !!(env.ADMIN_ID && env.ADMIN_PW);
      const noCacheA = url.searchParams.get("refresh") === "1";
      const cacheA = caches.default, cacheKeyA = new Request(url.toString(), request);
      if (!noCacheA) { const hit = await cacheA.match(cacheKeyA); if (hit) return withCors(hit, cors); }
      try {
        const begin = url.searchParams.get("beginDate") || "2023-01-01";
        const end = url.searchParams.get("endDate") || new Date().toISOString().slice(0, 10);
        let token;
        if (autoA) token = await getAutoToken(env, ctx, false);
        else token = (env.API_TOKEN || "").trim();
        if (!token) return json({ error: "로그인 정보(ADMIN_ID/ADMIN_PW) 또는 API_TOKEN 시크릿이 필요합니다." }, 500, cors);
        let r = await fetchAppMemberChart(token, begin, end);
        if (r.unauthorized && autoA) { token = await getAutoToken(env, ctx, true); r = await fetchAppMemberChart(token, begin, end); }
        if (r.unauthorized) return json({ error: "인증 실패(401): 로그인 정보(ADMIN_ID/ADMIN_PW)를 확인하세요." }, 401, cors);
        const payload = { source: "storelink-app-members", fetchedAt: new Date().toISOString(), beginDate: begin, endDate: end, memberChart: r.chart };
        const response = json(payload, 200, cors);
        ctx.waitUntil(cacheA.put(cacheKeyA, json(payload, 200, Object.assign({}, cors, { "Cache-Control": "max-age=" + CACHE_TTL_SEC }))));
        return response;
      } catch (e) {
        return json({ error: String((e && e.message) || e) }, 500, cors);
      }
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
const MEMSTATE_MAP= { NORMAL: "정상", ACTIVE: "정상", STOP: "정지", SUSPEND: "정지", BLOCK: "정지", WITHDRAW: "탈퇴", LEAVE: "탈퇴", DORMANT: "휴면" };
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

// ── 광고주 회원 → 대시보드 회원가입DB(DB.member) 스키마 매핑 ──
function mapMember(a, sm) {
  sm = sm || {};
  return {
    memberNo:        a.advMemberNo != null ? a.advMemberNo : "",
    joinDate:        dt(a.registerEndDate),
    userId:          a.memberId || "",
    memberName:      a.memberNm || "",
    memberNameKana:  a.memberNmFurigana || "",
    phone:           a.mobile || "",
    joinType:        MEMBER_MAP[a.advMemberType] || "기타",
    company:         a.corporateNm || "",
    marketingConsent: a.agreeAdvYn === "Y" ? "동의" : "동의 안함",
    accountStatus:   MEMSTATE_MAP[a.advMemberState] || a.advMemberState || "",
    salesRep:        (a.salesManagerNo != null && sm[a.salesManagerNo]) ? sm[a.salesManagerNo] : "",
    memberNoText:    String(a.advMemberNo != null ? a.advMemberNo : ""),
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, headers || {}) });
}
function withCors(res, cors) { const h = new Headers(res.headers); for (const k in cors) h.set(k, cors[k]); return new Response(res.body, { status: res.status, headers: h }); }
function clampInt(v, d, min, max) { const n = parseInt(v || d, 10); return isNaN(n) ? d : Math.max(min, Math.min(max, n)); }
