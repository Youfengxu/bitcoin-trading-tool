/**
 * OKX v5 REST Client
 *
 * Minimal, dependency-free client for the endpoints this tool needs:
 * market data (public) and spot trading + balances (private).
 *
 * ── Authentication ────────────────────────────────────────────────────
 * Private endpoints take four headers:
 *   OK-ACCESS-KEY        the API key
 *   OK-ACCESS-SIGN       base64(HMAC-SHA256(timestamp + METHOD + path + body, secret))
 *   OK-ACCESS-TIMESTAMP  ISO-8601 UTC with milliseconds, e.g. 2026-08-15T09:08:57.715Z
 *   OK-ACCESS-PASSPHRASE the passphrase chosen when the key was created
 *
 * `path` in the prehash string must include the query string, and `body` must be
 * the exact serialized JSON sent on the wire — sign the same string you send or
 * OKX returns 50113 (invalid signature).
 *
 * ── Demo trading ──────────────────────────────────────────────────────
 * OKX runs a full simulated environment on the same host. Set OKX_DEMO=1 and
 * every request carries `x-simulated-trading: 1`. Demo requires a *separate*
 * API key created under Demo Trading — a live key will not authenticate against
 * the simulated environment and vice versa.
 *
 * ── Regional sites ────────────────────────────────────────────────────
 * OKX operates independent regional sites and an account only authenticates
 * against the site it was registered on. A key from the wrong site fails with
 * 50119 "API key doesn't exist" — the key is real, just not real *here*.
 *
 * Do not infer the site from the country. Read it from the URL bar while logged
 * in: an account managing keys at my.okx.com/en-sg is on my.okx.com, whatever
 * "Singapore" might suggest about the global site. OKX_BASE_URL must match.
 *
 *   https://www.okx.com   global
 *   https://my.okx.com    used by EEA and SG accounts among others
 *   https://app.okx.com   US
 *   https://tr.okx.com    TR
 *
 * Credentials are read from the environment only. They are never logged, never
 * written to the database, and never included in error messages.
 */

import { createHmac } from "crypto";

// ─── Config ───────────────────────────────────────────────────────────

export interface OkxConfig {
  apiKey: string;
  secretKey: string;
  passphrase: string;
  /** true → x-simulated-trading: 1 (OKX demo environment) */
  demo: boolean;
  baseUrl: string;
  /** Spot instrument, e.g. BTC-USDT */
  instId: string;
}

/** Reads OKX config from the environment. Returns null when credentials are absent. */
export function getOkxConfig(): OkxConfig | null {
  const apiKey = process.env.OKX_API_KEY;
  const secretKey = process.env.OKX_SECRET_KEY;
  const passphrase = process.env.OKX_PASSPHRASE;
  if (!apiKey || !secretKey || !passphrase) return null;
  return {
    apiKey,
    secretKey,
    passphrase,
    demo: process.env.OKX_DEMO === "1",
    baseUrl: process.env.OKX_BASE_URL ?? "https://www.okx.com",
    instId: process.env.OKX_INST_ID ?? "BTC-USDT",
  };
}

/** Public market-data base URL — usable with no credentials at all. */
export function getPublicBaseUrl(): string {
  return process.env.OKX_BASE_URL ?? "https://www.okx.com";
}

export function getInstId(): string {
  return process.env.OKX_INST_ID ?? "BTC-USDT";
}

// ─── Errors ───────────────────────────────────────────────────────────

/** An error carrying OKX's own error code, which is far more useful than the HTTP status. */
export class OkxApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly endpoint: string
  ) {
    super(`OKX ${code}: ${message} (${endpoint})`);
    this.name = "OkxApiError";
  }
}

interface OkxEnvelope<T> {
  code: string;
  msg: string;
  data: T[];
}

/**
 * OKX authentication error codes, mapped to what actually causes them.
 *
 * These arrive on HTTP 401 responses whose body carries the real code. Each one
 * points at a different fix, and telling them apart is the difference between a
 * two-minute correction and an afternoon of guessing.
 */
export const AUTH_HINTS: Record<string, string> = {
  "50100": "API key is frozen or the account is restricted",
  "50101": "the key belongs to a DIFFERENT REGIONAL SITE. An account registered on one OKX site (global / EEA / US / TR) cannot authenticate against another. Check OKX_BASE_URL",
  "50102": "request timestamp expired — the host clock is more than 30s from OKX's",
  "50103": "request header OK-ACCESS-KEY is missing",
  "50104": "request header OK-ACCESS-PASSPHRASE is missing",
  "50105": "passphrase is incorrect — this is the phrase you chose when creating the key, not your login password",
  "50111": "OK-ACCESS-KEY is invalid — wrong key string, or a live key used against demo (or vice versa)",
  "50112": "OK-ACCESS-TIMESTAMP is invalid",
  "50113": "signature mismatch — usually a wrong secret key, or whitespace pasted into the value",
  "50114": "invalid authorization — the key lacks the required permission (Read is the minimum)",
  "50110": "your IP is not on the key's allowlist",
  "50119":
    "the API key does not exist on this site+environment. The key string is " +
    "well-formed but OKX has no record of it here — it was created on a " +
    "different regional site, created in the other environment (demo keys and " +
    "live keys are separate), deleted since, or only partially pasted",
};

// ─── Request plumbing ─────────────────────────────────────────────────

/**
 * The exact string OKX signs: timestamp + METHOD + path + body.
 * `path` must include the query string and `body` must be the serialized JSON
 * actually sent — the two most common causes of a 50113 invalid-signature error.
 * Exported for testing, since a wrong prehash fails every private call.
 */
export function buildPrehash(
  timestamp: string,
  method: string,
  path: string,
  body: string
): string {
  return timestamp + method + path + body;
}

export function signPrehash(secretKey: string, prehash: string): string {
  return createHmac("sha256", secretKey).update(prehash).digest("base64");
}

function sign(secretKey: string, prehash: string): string {
  return signPrehash(secretKey, prehash);
}

/**
 * Unauthenticated GET against a public market-data endpoint.
 * `path` must start with /api/v5/ and may include a query string.
 */
export async function publicGet<T>(path: string, timeoutMs = 10_000): Promise<T[]> {
  const res = await fetch(`${getPublicBaseUrl()}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new OkxApiError(String(res.status), res.statusText, path);
  const body = (await res.json()) as OkxEnvelope<T>;
  if (body.code !== "0") throw new OkxApiError(body.code, body.msg, path);
  return body.data;
}

/**
 * Authenticated request. The body is serialized once and both signed and sent,
 * so the signature always matches the payload.
 */
export async function signedRequest<T>(
  cfg: OkxConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  timeoutMs = 15_000
): Promise<T[]> {
  const timestamp = new Date().toISOString();
  const serialized = body === undefined ? "" : JSON.stringify(body);
  const prehash = buildPrehash(timestamp, method, path, serialized);

  const headers: Record<string, string> = {
    "OK-ACCESS-KEY": cfg.apiKey,
    "OK-ACCESS-SIGN": sign(cfg.secretKey, prehash),
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": cfg.passphrase,
    "Content-Type": "application/json",
  };
  if (cfg.demo) headers["x-simulated-trading"] = "1";

  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers,
    body: serialized === "" ? undefined : serialized,
    signal: AbortSignal.timeout(timeoutMs),
  });

  // OKX returns 200 with a non-zero `code` for business errors, and non-200 for
  // auth failures — but a non-200 STILL carries a JSON body with the specific
  // code, and that code is the whole diagnosis. Throwing on res.ok alone
  // discards it and leaves you with a bare "401 Unauthorized" that could be any
  // of half a dozen unrelated causes.
  if (!res.ok) {
    let code = String(res.status);
    let msg = res.statusText;
    try {
      const body = (await res.json()) as { code?: string; msg?: string };
      if (body?.code) code = body.code;
      if (body?.msg) msg = body.msg;
    } catch {
      /* body was not JSON — keep the HTTP status */
    }
    throw new OkxApiError(code, `${msg}${AUTH_HINTS[code] ? ` — ${AUTH_HINTS[code]}` : ""}`, path);
  }
  const envelope = (await res.json()) as OkxEnvelope<T>;
  if (envelope.code !== "0") {
    // Order endpoints report per-order failures inside data[0], which carries a
    // far more specific message than the envelope's generic "operation failed".
    const detail = envelope.data?.[0] as { sCode?: string; sMsg?: string } | undefined;
    if (detail?.sCode && detail.sCode !== "0") {
      throw new OkxApiError(detail.sCode, detail.sMsg ?? envelope.msg, path);
    }
    throw new OkxApiError(envelope.code, envelope.msg, path);
  }
  return envelope.data;
}

// ─── Public market data ───────────────────────────────────────────────

export interface OkxTicker {
  instId: string;
  last: string;
  open24h: string;
  high24h: string;
  low24h: string;
  vol24h: string;      // base ccy (BTC)
  volCcy24h: string;   // quote ccy (USDT)
  ts: string;
}

export async function fetchTicker(instId = getInstId()): Promise<OkxTicker> {
  const data = await publicGet<OkxTicker>(`/api/v5/market/ticker?instId=${instId}`);
  const t = data[0];
  if (!t) throw new OkxApiError("empty", `no ticker for ${instId}`, "/api/v5/market/ticker");
  return t;
}

/**
 * Instrument trading rules. Order sizes must respect these or OKX rejects the
 * order — minSz is the smallest tradable quantity, lotSz the quantity step.
 */
export interface OkxInstrument {
  instId: string;
  minSz: string;
  lotSz: string;
  tickSz: string;
  state: string;
}

export async function fetchInstrument(instId = getInstId()): Promise<OkxInstrument> {
  const data = await publicGet<OkxInstrument>(
    `/api/v5/public/instruments?instType=SPOT&instId=${instId}`
  );
  const i = data[0];
  if (!i) throw new OkxApiError("empty", `no instrument ${instId}`, "/api/v5/public/instruments");
  return i;
}

/** Map this project's interval strings to OKX `bar` values. */
export function toOkxBar(interval: string): string {
  const map: Record<string, string> = {
    "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "1H", "2h": "2H", "4h": "4H", "6h": "6H", "12h": "12H", "1d": "1D",
  };
  return map[interval] ?? "1H";
}

export interface OkxCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** false when the bar is still forming — indicators on an unconfirmed bar repaint. */
  confirmed: boolean;
}

/**
 * Raw OKX candle row: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm].
 * `vol` is base-currency volume (BTC), matching what the other data sources return.
 */
function parseCandleRow(row: string[]): OkxCandle {
  return {
    openTime: parseInt(row[0]),
    open: parseFloat(row[1]),
    high: parseFloat(row[2]),
    low: parseFloat(row[3]),
    close: parseFloat(row[4]),
    volume: parseFloat(row[5]),
    confirmed: row[8] === "1",
  };
}

/**
 * Fetch up to `limit` candles, newest last.
 *
 * OKX caps a single /market/candles call at 300 rows, so anything larger is
 * paginated backwards using `after` (which means "rows older than this ts").
 * The indicator pipeline asks for 336 bars, so pagination is the normal path,
 * not an edge case.
 */
export async function fetchCandles(
  interval: string,
  limit: number,
  instId = getInstId()
): Promise<OkxCandle[]> {
  const bar = toOkxBar(interval);
  const PAGE = 300;
  const collected: OkxCandle[] = [];
  let after: number | undefined;

  while (collected.length < limit) {
    const want = Math.min(PAGE, limit - collected.length);
    const q = new URLSearchParams({ instId, bar, limit: String(want) });
    if (after !== undefined) q.set("after", String(after));

    const rows = await publicGet<string[]>(`/api/v5/market/candles?${q}`);
    if (rows.length === 0) break;

    const page = rows.map(parseCandleRow); // newest first
    collected.push(...page);
    after = page[page.length - 1].openTime; // oldest in this page
    if (rows.length < want) break; // history exhausted
  }

  return collected.sort((a, b) => a.openTime - b.openTime);
}

/**
 * Fetch candles at or after `startTime`, newest last.
 * Uses the history endpoint, which reaches further back than /market/candles.
 */
export async function fetchCandlesFrom(
  interval: string,
  startTime: number,
  limit: number,
  instId = getInstId()
): Promise<OkxCandle[]> {
  const bar = toOkxBar(interval);
  const PAGE = 100; // history-candles caps at 100 per call
  const collected: OkxCandle[] = [];
  let after: number | undefined;

  while (collected.length < limit) {
    const q = new URLSearchParams({ instId, bar, limit: String(PAGE) });
    if (after !== undefined) q.set("after", String(after));

    const rows = await publicGet<string[]>(`/api/v5/market/history-candles?${q}`);
    if (rows.length === 0) break;

    const page = rows.map(parseCandleRow); // newest first
    collected.push(...page);
    after = page[page.length - 1].openTime;
    if (after <= startTime) break; // walked back past the requested start
    if (rows.length < PAGE) break;
  }

  return collected
    .filter((c) => c.openTime >= startTime)
    .sort((a, b) => a.openTime - b.openTime)
    .slice(0, limit);
}

export async function fetchOrderBook(
  depth: number,
  instId = getInstId()
): Promise<{ bids: Array<{ price: number; qty: number }>; asks: Array<{ price: number; qty: number }> }> {
  const data = await publicGet<{ bids: string[][]; asks: string[][] }>(
    `/api/v5/market/books?instId=${instId}&sz=${depth}`
  );
  const book = data[0];
  if (!book) throw new OkxApiError("empty", `no book for ${instId}`, "/api/v5/market/books");
  const toLevel = ([price, qty]: string[]) => ({ price: parseFloat(price), qty: parseFloat(qty) });
  return { bids: book.bids.map(toLevel), asks: book.asks.map(toLevel) };
}

// ─── Private: account ─────────────────────────────────────────────────

export interface OkxBalance {
  /** Free + frozen, per currency. */
  [ccy: string]: number;
}

/** Trading account balances keyed by currency, e.g. { BTC: 0.12, USDT: 4500 }. */
export async function fetchBalances(cfg: OkxConfig): Promise<OkxBalance> {
  const data = await signedRequest<{ details: Array<{ ccy: string; eq: string; cashBal: string }> }>(
    cfg,
    "GET",
    "/api/v5/account/balance"
  );
  const out: OkxBalance = {};
  for (const d of data[0]?.details ?? []) {
    const v = parseFloat(d.cashBal || d.eq || "0");
    if (!isNaN(v)) out[d.ccy] = v;
  }
  return out;
}

/**
 * The account's actual spot fee rates. Returned as positive decimals
 * (OKX reports them as negative strings, e.g. "-0.0008" = 0.08%).
 *
 * This is the number the simulator and the walk-forward optimizer should be
 * charging — not a hardcoded guess.
 */
export async function fetchTradeFee(
  cfg: OkxConfig,
  instId = cfg.instId
): Promise<{ maker: number; taker: number }> {
  const data = await signedRequest<{ maker: string; taker: string }>(
    cfg,
    "GET",
    `/api/v5/account/trade-fee?instType=SPOT&instId=${instId}`
  );
  const f = data[0];
  return {
    maker: Math.abs(parseFloat(f?.maker ?? "0")),
    taker: Math.abs(parseFloat(f?.taker ?? "0")),
  };
}

// ─── Private: trading ─────────────────────────────────────────────────

export interface OkxOrderResult {
  ordId: string;
  clOrdId: string;
  sCode: string;
  sMsg: string;
}

export interface OkxOrderDetail {
  ordId: string;
  state: string;      // live | partially_filled | filled | canceled
  avgPx: string;      // average fill price
  accFillSz: string;  // filled size in base ccy (BTC)
  fillNotionalUsd: string;
  fee: string;        // negative = charged, in feeCcy
  feeCcy: string;
  side: string;
}

/**
 * Place a spot market order.
 *
 * OKX sizes spot market orders differently per side, and getting this wrong is
 * the most common integration bug:
 *   buy  → `sz` is the QUOTE amount (USDT to spend), tgtCcy = quote_ccy
 *   sell → `sz` is the BASE amount (BTC to sell),   tgtCcy = base_ccy
 * Both are set explicitly rather than relying on OKX's per-side defaults.
 */
export async function placeMarketOrder(
  cfg: OkxConfig,
  side: "buy" | "sell",
  size: string,
  clOrdId?: string
): Promise<OkxOrderResult> {
  const body: Record<string, string> = {
    instId: cfg.instId,
    tdMode: "cash", // spot, non-margin
    side,
    ordType: "market",
    sz: size,
    tgtCcy: side === "buy" ? "quote_ccy" : "base_ccy",
  };
  if (clOrdId) body.clOrdId = clOrdId;

  const data = await signedRequest<OkxOrderResult>(cfg, "POST", "/api/v5/trade/order", body);
  const result = data[0];
  if (!result) throw new OkxApiError("empty", "no order result", "/api/v5/trade/order");
  if (result.sCode !== "0") {
    throw new OkxApiError(result.sCode, result.sMsg, "/api/v5/trade/order");
  }
  return result;
}

export async function fetchOrder(cfg: OkxConfig, ordId: string): Promise<OkxOrderDetail | null> {
  const data = await signedRequest<OkxOrderDetail>(
    cfg,
    "GET",
    `/api/v5/trade/order?instId=${cfg.instId}&ordId=${ordId}`
  );
  return data[0] ?? null;
}

/**
 * Poll until the order reaches a terminal state.
 *
 * Market orders normally fill within a few hundred milliseconds, but OKX
 * acknowledges the order before the fill is queryable, so reading avgPx
 * immediately after placement usually returns an empty string.
 */
export async function waitForFill(
  cfg: OkxConfig,
  ordId: string,
  { attempts = 10, delayMs = 400 } = {}
): Promise<OkxOrderDetail | null> {
  let last: OkxOrderDetail | null = null;
  for (let i = 0; i < attempts; i++) {
    last = await fetchOrder(cfg, ordId);
    if (last && (last.state === "filled" || last.state === "canceled")) return last;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}

// ─── Sizing helpers ───────────────────────────────────────────────────

/**
 * Round a base-currency quantity DOWN to the instrument's lot step.
 * Rounding down matters on sells: rounding up can exceed the available balance
 * and get the order rejected for insufficient funds.
 */
export function roundToLot(qty: number, lotSz: string): string {
  const step = parseFloat(lotSz);
  if (!step || step <= 0) return String(qty);
  const rounded = Math.floor(qty / step) * step;
  // Derive decimal places from the step so the string never carries float noise.
  const decimals = (lotSz.split(".")[1] ?? "").length;
  return rounded.toFixed(decimals);
}

/** Round a quote-currency amount down to 2dp — enough precision for USDT. */
export function roundQuote(usd: number): string {
  return (Math.floor(usd * 100) / 100).toFixed(2);
}
