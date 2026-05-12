/**
 * Market Data Service
 *
 * Candle data source priority (geo-restriction aware):
 *   1. Kraken REST API  — no geo-restrictions, reliable OHLCV
 *   2. CoinGecko OHLC   — free tier, 4-hour granularity minimum
 *   3. Yahoo Finance     — via Manus built-in Data API hub
 *
 * Price / 24h stats source priority:
 *   1. Binance REST API  — fastest, most accurate
 *   2. CoinGecko         — fallback when Binance is geo-blocked (451)
 */

import { callDataApi } from "../_core/dataApi";

const BINANCE_API = "https://api.binance.com/api/v3";
const KRAKEN_API  = "https://api.kraken.com/0/public";
const COINGECKO_API = "https://api.coingecko.com/api/v3";

// ─── Types ────────────────────────────────────────────────────────────
export interface BinanceCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

// ─── Interval Mapping ─────────────────────────────────────────────────
/** Map our internal interval strings to Kraken interval minutes */
function toKrakenInterval(interval: string): number {
  const map: Record<string, number> = {
    "1m": 1, "5m": 5, "15m": 15, "30m": 30,
    "1h": 60, "4h": 240, "1d": 1440,
  };
  return map[interval] ?? 60;
}

/** Map our internal interval strings to CoinGecko days param */
function toCoinGeckoDays(interval: string, limit: number): number {
  const hoursPerCandle: Record<string, number> = {
    "1m": 1/60, "5m": 5/60, "15m": 15/60, "30m": 0.5,
    "1h": 1, "4h": 4, "1d": 24,
  };
  const hours = (hoursPerCandle[interval] ?? 1) * limit;
  const days = Math.ceil(hours / 24);
  return Math.max(1, Math.min(days, 365));
}

/** Map our internal interval strings to Yahoo Finance interval */
function toYahooInterval(interval: string): string {
  const map: Record<string, string> = {
    "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "60m", "4h": "60m", "1d": "1d",
  };
  return map[interval] ?? "60m";
}

// ─── Current Price ────────────────────────────────────────────────────
export async function fetchCurrentPrice(): Promise<{
  price: number; ts: number; source: string;
  change24h?: number; high24h?: number; low24h?: number; volume24h?: number;
}> {
  // 1. Try Binance ticker
  try {
    const res = await fetch(`${BINANCE_API}/ticker/price?symbol=BTCUSDT`);
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const data = (await res.json()) as { price: string };
    return { price: parseFloat(data.price), ts: Date.now(), source: "binance" };
  } catch (binanceErr) {
    console.warn("[MarketData] Binance price failed:", binanceErr);
  }

  // 2. Try Kraken ticker
  try {
    const res = await fetch(`${KRAKEN_API}/Ticker?pair=XBTUSD`);
    if (!res.ok) throw new Error(`Kraken ${res.status}`);
    const data = (await res.json()) as { result: Record<string, { c: string[] }> };
    const pair = Object.values(data.result)[0];
    if (!pair) throw new Error("Kraken: no pair data");
    return { price: parseFloat(pair.c[0]), ts: Date.now(), source: "kraken" };
  } catch (krakenErr) {
    console.warn("[MarketData] Kraken price failed:", krakenErr);
  }

  // 3. CoinGecko fallback
  const res = await fetch(`${COINGECKO_API}/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true`);
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const data = (await res.json()) as { bitcoin: { usd: number; usd_24h_change: number } };
  return {
    price: data.bitcoin.usd,
    ts: Date.now(),
    source: "coingecko",
    change24h: data.bitcoin.usd_24h_change,
  };
}

// ─── 24h Stats ────────────────────────────────────────────────────────
export async function fetch24hStats(): Promise<{
  priceChange: number; priceChangePct: number;
  high24h: number; low24h: number; volume24h: number;
  lastPrice: number; source: string;
}> {
  // 1. Binance
  try {
    const res = await fetch(`${BINANCE_API}/ticker/24hr?symbol=BTCUSDT`);
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const d = (await res.json()) as Record<string, string>;
    return {
      priceChange: parseFloat(d.priceChange),
      priceChangePct: parseFloat(d.priceChangePercent),
      high24h: parseFloat(d.highPrice),
      low24h: parseFloat(d.lowPrice),
      volume24h: parseFloat(d.volume),
      lastPrice: parseFloat(d.lastPrice),
      source: "binance",
    };
  } catch (e) {
    console.warn("[MarketData] Binance 24h stats failed:", e);
  }

  // 2. Kraken
  try {
    const res = await fetch(`${KRAKEN_API}/Ticker?pair=XBTUSD`);
    if (!res.ok) throw new Error(`Kraken ${res.status}`);
    const data = (await res.json()) as {
      result: Record<string, { c: string[]; h: string[]; l: string[]; v: string[]; o: string }>
    };
    const pair = Object.values(data.result)[0];
    if (!pair) throw new Error("Kraken: no pair data");
    const last = parseFloat(pair.c[0]);
    const open = parseFloat(pair.o);
    return {
      priceChange: last - open,
      priceChangePct: ((last - open) / open) * 100,
      high24h: parseFloat(pair.h[1]),
      low24h: parseFloat(pair.l[1]),
      volume24h: parseFloat(pair.v[1]),
      lastPrice: last,
      source: "kraken",
    };
  } catch (e) {
    console.warn("[MarketData] Kraken 24h stats failed:", e);
  }

  // 3. CoinGecko
  const res = await fetch(
    `${COINGECKO_API}/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false`
  );
  if (!res.ok) throw new Error(`CoinGecko 24h stats ${res.status}`);
  const data = (await res.json()) as {
    market_data: {
      current_price: { usd: number };
      price_change_24h: number;
      price_change_percentage_24h: number;
      high_24h: { usd: number };
      low_24h: { usd: number };
      total_volume: { usd: number };
    };
  };
  const md = data.market_data;
  return {
    priceChange: md.price_change_24h,
    priceChangePct: md.price_change_percentage_24h,
    high24h: md.high_24h.usd,
    low24h: md.low_24h.usd,
    volume24h: md.total_volume.usd,
    lastPrice: md.current_price.usd,
    source: "coingecko",
  };
}

// ─── Candle Data ──────────────────────────────────────────────────────
/**
 * Fetch OHLCV candles. Tries sources in order:
 * 1. Kraken  2. CoinGecko OHLC  3. Yahoo Finance (Manus Data API)
 * Binance is intentionally skipped here because it returns 451 on restricted regions.
 */
export async function fetchCandles(
  interval: string = "1h",
  limit: number = 500
): Promise<BinanceCandle[]> {
  // 1. Kraken
  try {
    return await fetchCandlesFromKraken(interval, limit);
  } catch (e) {
    console.warn("[MarketData] Kraken klines failed:", e);
  }

  // 2. CoinGecko OHLC
  try {
    return await fetchCandlesFromCoinGecko(interval, limit);
  } catch (e) {
    console.warn("[MarketData] CoinGecko OHLC failed:", e);
  }

  // 3. Yahoo Finance via Manus Data API
  try {
    return await fetchCandlesFromYahoo(interval, limit);
  } catch (e) {
    console.warn("[MarketData] Yahoo Finance klines failed:", e);
  }

  throw new Error("All candle data sources failed (Kraken, CoinGecko, Yahoo Finance).");
}

// ─── Kraken Candles ───────────────────────────────────────────────────
async function fetchCandlesFromKraken(
  interval: string,
  limit: number
): Promise<BinanceCandle[]> {
  const krakenInterval = toKrakenInterval(interval);
  // Kraken returns up to 720 candles per call; since=0 means most recent
  const since = Math.floor((Date.now() - krakenInterval * 60 * 1000 * limit) / 1000);
  const url = `${KRAKEN_API}/OHLC?pair=XBTUSD&interval=${krakenInterval}&since=${since}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kraken OHLC ${res.status}`);
  const data = (await res.json()) as {
    error: string[];
    result: Record<string, Array<[number, string, string, string, string, string, string, number]>>;
  };
  if (data.error?.length) throw new Error(`Kraken error: ${data.error.join(", ")}`);

  const pairKey = Object.keys(data.result).find((k) => k !== "last");
  if (!pairKey) throw new Error("Kraken: no OHLC pair key found");

  const candles = data.result[pairKey]!;
  // Kraken format: [time, open, high, low, close, vwap, volume, count]
  return candles.slice(-limit).map((k) => ({
    openTime: k[0] * 1000,
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[6]),
    closeTime: k[0] * 1000 + krakenInterval * 60 * 1000 - 1,
  }));
}

// ─── CoinGecko OHLC Candles ───────────────────────────────────────────
async function fetchCandlesFromCoinGecko(
  interval: string,
  limit: number
): Promise<BinanceCandle[]> {
  const days = toCoinGeckoDays(interval, limit);
  // CoinGecko returns [timestamp, open, high, low, close] — no volume
  const res = await fetch(
    `${COINGECKO_API}/coins/bitcoin/ohlc?vs_currency=usd&days=${days}`
  );
  if (!res.ok) throw new Error(`CoinGecko OHLC ${res.status}`);
  const data = (await res.json()) as Array<[number, number, number, number, number]>;

  const intervalMs = toKrakenInterval(interval) * 60 * 1000;
  return data.slice(-limit).map((k) => ({
    openTime: k[0],
    open: k[1],
    high: k[2],
    low: k[3],
    close: k[4],
    volume: 0, // CoinGecko OHLC endpoint does not provide volume
    closeTime: k[0] + intervalMs - 1,
  }));
}

// ─── Yahoo Finance Candles (Manus Data API) ───────────────────────────
async function fetchCandlesFromYahoo(
  interval: string,
  limit: number
): Promise<BinanceCandle[]> {
  const yahooInterval = toYahooInterval(interval);
  // Determine range from limit and interval
  const hoursNeeded = toKrakenInterval(interval) * limit / 60;
  let range = "1mo";
  if (hoursNeeded <= 24) range = "5d";
  else if (hoursNeeded <= 24 * 7) range = "1mo";
  else if (hoursNeeded <= 24 * 30) range = "3mo";
  else range = "1y";

  const result = await callDataApi("YahooFinance/get_stock_chart", {
    query: {
      symbol: "BTC-USD",
      region: "US",
      interval: yahooInterval,
      range,
      includeAdjustedClose: false,
    },
  }) as {
    chart?: {
      result?: Array<{
        timestamp: number[];
        indicators: {
          quote: Array<{
            open: number[];
            high: number[];
            low: number[];
            close: number[];
            volume: number[];
          }>;
        };
      }>;
    };
  };

  const chartResult = result?.chart?.result?.[0];
  if (!chartResult) throw new Error("Yahoo Finance: no chart result");

  const { timestamp, indicators } = chartResult;
  const quote = indicators.quote[0];
  if (!quote) throw new Error("Yahoo Finance: no quote data");

  const intervalMs = toKrakenInterval(interval) * 60 * 1000;
  return timestamp.slice(-limit).map((ts, i) => ({
    openTime: ts * 1000,
    open: quote.open[i] ?? 0,
    high: quote.high[i] ?? 0,
    low: quote.low[i] ?? 0,
    close: quote.close[i] ?? 0,
    volume: quote.volume[i] ?? 0,
    closeTime: ts * 1000 + intervalMs - 1,
  })).filter((c) => c.close > 0); // remove null candles
}

// ─── Candles with Start Time ──────────────────────────────────────────
export async function fetchCandlesFrom(
  interval: string,
  startTime: number,
  limit: number = 1000
): Promise<BinanceCandle[]> {
  // For historical backfill, Kraken supports since= parameter
  try {
    const krakenInterval = toKrakenInterval(interval);
    const since = Math.floor(startTime / 1000);
    const url = `${KRAKEN_API}/OHLC?pair=XBTUSD&interval=${krakenInterval}&since=${since}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Kraken OHLC ${res.status}`);
    const data = (await res.json()) as {
      error: string[];
      result: Record<string, Array<[number, string, string, string, string, string, string, number]>>;
    };
    if (data.error?.length) throw new Error(`Kraken error: ${data.error.join(", ")}`);
    const pairKey = Object.keys(data.result).find((k) => k !== "last");
    if (!pairKey) throw new Error("Kraken: no pair key");
    const candles = data.result[pairKey]!;
    return candles.slice(0, limit).map((k) => ({
      openTime: k[0] * 1000,
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[6]),
      closeTime: k[0] * 1000 + krakenInterval * 60 * 1000 - 1,
    }));
  } catch (e) {
    console.warn("[MarketData] Kraken fetchCandlesFrom failed, using fetchCandles:", e);
    return fetchCandles(interval, limit);
  }
}

// ─── Order Book ───────────────────────────────────────────────────────
export async function fetchOrderBook(
  limit: number = 10
): Promise<{
  bids: Array<{ price: number; qty: number }>;
  asks: Array<{ price: number; qty: number }>;
}> {
  // Try Kraken order book (no geo-restriction)
  try {
    const res = await fetch(`${KRAKEN_API}/Depth?pair=XBTUSD&count=${limit}`);
    if (!res.ok) throw new Error(`Kraken depth ${res.status}`);
    const data = (await res.json()) as {
      result: Record<string, { bids: Array<[string, string]>; asks: Array<[string, string]> }>;
    };
    const pair = Object.values(data.result)[0];
    if (!pair) throw new Error("Kraken: no depth data");
    return {
      bids: pair.bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
      asks: pair.asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
    };
  } catch (e) {
    console.warn("[MarketData] Kraken order book failed:", e);
  }

  // Fallback: Binance (may fail on restricted regions)
  const res = await fetch(`${BINANCE_API}/depth?symbol=BTCUSDT&limit=${limit}`);
  if (!res.ok) throw new Error(`Binance depth ${res.status}`);
  const data = (await res.json()) as {
    bids: Array<[string, string]>;
    asks: Array<[string, string]>;
  };
  return {
    bids: data.bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
    asks: data.asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
  };
}
