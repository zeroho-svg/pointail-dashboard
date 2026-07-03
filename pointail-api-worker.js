/**
 * ─────────────────────────────────────────────────────────────
 *  Pointail ↔ Storelink Admin API 프록시 (Cloudflare Worker)
 * ─────────────────────────────────────────────────────────────
 *  apia-v2 캠페인 API를 인증 호출 → 전량 수집 → 대시보드 스키마로 매핑
 *  → CORS 붙여 포인테일 대시보드에 JSON 제공. (구글시트 수작업 대체)
 *
 *  ── 인증: X-Auth-Token 헤더 ────────────────────────────────
 *  이 API는 `X-Auth-Token: <JWT>` 커스텀 헤더로 인증합니다.
 *  토큰 = 어드민 로그인 세션의 토큰(어드민 쿠키 a_prod_token 값과 동일).
 *
 *  ── 배포 ──────────────────────────────────────────────────
 *  1) Cloudflare → Workers & Pages → Create → Worker → 이 코드 붙여넣고 Deploy
 *  2) Settings → Variables and Secrets 에 시크릿 추가:
 *        API_TOKEN    = <X-Auth-Token 값>                (필수)
 *        ALLOW_ORIGIN = https://zeroho-svg.github.io      (선택)
 *     ※ 토큰 구하는 법: 어드민 F12 → Network → campaigns/search 요청 →
 *        Headers → Request Headers → `x-auth-token` 값 복사.
 *  3) 배포된 Worker URL 을 대시보드에서 fetch.
 *
 *  ── 만료(반자동) ──────────────────────────────────────────
 *  토큰은 약 12시간 유효 → 401 나면 위 토큰만 다시 복사해 교체.
 * ─────────────────────────────────────────────────────────────
 */

const API_BASE = "https://apia-v2.storelink.io";
const CAMPAIGN_SEARCH = "/pug/jp/campaigns/search";
const CACHE_TTL_SEC = 600;

export default {
  async fetch(request, env, ctx) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const TOKEN = (env.API_TOKEN || "").trim();          // 공백/개행 제거(붙여넣기 방어)
    if (!TOKEN) return json({ error: "API_TOKEN 시크릿이 설정되지 않았습니다." }, 500, cors);

    const url = new URL(request.url);
    if (url.searchParams.get("diag") === "1") {           // 자가진단(값 노출 안 함)
      return json({ tokenLen: TOKEN.length, tokenPrefix: TOKEN.slice(0, 2), looksJwt: /^ey/.test(TOKEN) }, 200, cors);
    }
    const raw = url.searchParams.get("raw") === "1";     // raw=1 → 원본 필드 그대로
    const noCache = url.searchParams.get("refresh") === "1";
    const cache = caches.default, cacheKey = new Request(url.toString(), request);
    if (!noCache) { const hit = await cache.match(cacheKey); if (hit) return withCors(hit, cors); }

    try {
      const pageSize = clampInt(url.searchParams.get("pageSize"), 200, 1, 200);
      const dateType = url.searchParams.get("campaignDateSearchType") || "CREATE_DATE";
      const all = [];
      let page = 1, totalPage = 1, guard = 0;
      do {
        const api = `${API_BASE}${CAMPAIGN_SEARCH}?campaignDateSearchType=${dateType}&page=${page}&pageSize=${pageSize}`;
        const res = await fetch(api, { headers: {
          "X-Auth-Token": TOKEN,
          "Accept": "application/json, text/plain, */*",
          "Origin": "https://admin.storelink.io",
          "Referer": "https://admin.storelink.io/",
        } });
        if (res.status === 401) return json({ error: "인증 실패(401): 토큰 만료. API_TOKEN을 새로 복사해 교체하세요." }, 401, cors);
        if (!res.ok) return json({ error: `상위 API 오류 ${res.status}` }, 502, cors);
        const body = await res.json();
        const list = (body.result && body.result.campaigns) || [];
        all.push(...list);
        totalPage = (body.page && body.page.totalPage) || (list.length < pageSize ? page : page + 1);
        page++; guard++;
      } while (page <= totalPage && guard < 100);

      const campaigns = raw ? all : all.map(mapCampaign);
      const payload = { source: "storelink-apia-v2", fetchedAt: new Date().toISOString(), count: campaigns.length, campaigns };
      const response = json(payload, 200, cors);
      ctx.waitUntil(cache.put(cacheKey, json(payload, 200, { ...cors, "Cache-Control": `max-age=${CACHE_TTL_SEC}` })));
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
  return {
    campaignNo:        c.campaignNo,
    marketingType:     SVC_MAP[c.campaignServiceType] || c.campaignServiceType || "",
    campaignStatus:    STATE_MAP[c.campaignState] || c.campaignState || "",
    payStatus:         PAYSTATE_MAP[c.paymentState] || "",
    campaignType:      TYPE_MAP[c.campaignType] || c.campaignType || "",
    campaignTitle:     c.campaignNm || "",
    storeName:         c.storeNm || "",
    corpName:          c.corporateNm || "",
    advertiserCountry: COUNTRY_MAP[c.corporateCountry] || "",
    companyType:       MEMBER_MAP[c.advMemberType] || "",
    shoppingChannel:   c.storeChnnlNm || "",
    opManager:         c.opManagerNm || "",
    salesManager:      c.salesManagerNm || "",
    payRequested:      yn(c.paymentYn),          // 결제 요청 여부
    hidden:            yn(c.campaignHiddenYn),   // 숨김 여부
    pointRevenue:      c.campaignPointAmt || 0,
    // (계약) 금액
    contractSaleSum:   amt(c.totalCampaignCostAmt),
    contractMktCost:   amt(c.subtotalCampaignCostAmt),
    contractVat:       amt(c.vatAmt),
    contractFinal:     amt(c.totalCampaignPaymentAmt),   // = 소계+부가세 (계약 최종)
    // (실행) 금액  ※ 부가세 미포함 기준(대시보드가 ×1.1 처리)
    execNetAmount:     amt(c.currentSubtotalCampaignCostAmt),
    execDiscount:      amt(c.currentDiscountAmt),
    execTotalAmount:   amt(c.currentTotalCampaignPaymentAmt),
    // 일시
    createdAt:         dt(c.createDt),
    recruitStartAt:    dt(c.recruitBeginDt),
    campaignNoText:    String(c.campaignNo),
  };
}

// ── 유틸 ────────────────────────────────────────────────────
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...(headers || {}) } });
}
function withCors(res, cors) { const h = new Headers(res.headers); for (const k in cors) h.set(k, cors[k]); return new Response(res.body, { status: res.status, headers: h }); }
function clampInt(v, d, min, max) { const n = parseInt(v || d, 10); return isNaN(n) ? d : Math.max(min, Math.min(max, n)); }
