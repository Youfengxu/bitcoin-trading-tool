/**
 * Market Data Service
 * Primary: Binance REST API for BTC/USDT
 * Fallback: CoinGecko API for price and 24h stats when Binance is unavailable
 */

const BINANCE_API = "https://api.binance.com/api/v3";
const COINGECKO_API = "https://api.coingecko.com/api/v3";

export interface BinanceCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

/**
 * Fetch current BTC/USDT ticker price.
 * Tries Binance first, falls back to CoinGecko.
 */
export async function fetchCurrentPrice(): Promise<{ price: number; ts: number; source: string }> {
  try {
    const res = await fetch(`${BINANCE_API}/ticker/price?symbol=BTCUSDT`);
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const data = (await res.json()) as { price: string };
    return { price: parseFloat(data.price), ts: Date.now(), source: "binance" };
  } catch (binanceErr) {
    console.warn("[MarketData] Binance price failed, trying CoinGecko:", binanceErr);
    try {
      const res = await fetch(`${COINGECKO_API}/simple/price?ids=bitcoin&vs_currencies=usd`);
      if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
      const data = (await res.json()) as { bitcoin: { usd: number } };
      return { price: data.bitcoin.usd, ts: Date.now(), source: "coingecko" };
    } catch (cgErr) {
      throw new Error(`Both Binance and CoinGecko price fetch failed. Binance: ${binanceErr}. CoinGecko: ${cgErr}`);
    }
  }
}

/**
 * Fetch 24h ticker stats.
 * Tries Binance first, falls back to CoinGecko.
 */
export async function fetch24hStats(): Promise<{
  priceChange: number;
  priceChangePct: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  lastPrice: number;
  source: string;
}> {
  try {
    const res = await fetch(`${BINANCE_API}/ticker/24hr?symbol=BTCUSDT`);
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const data = (await res.json()) as Record<string, string>;
    return {
      priceChange: parseFloat(data.priceChange),
      priceChangePct: parseFloat(data.priceChangePercent),
      high24h: parseFloat(data.highPrice),
      low24h: parseFloat(data.lowPrice),
      volume24h: parseFloat(data.volume),
      lastPrice: parseFloat(data.lastPrice),
      source: "binance",
    };
  } catch (binanceErr) {
    console.warn("[MarketData] Binance 24h stats failed, trying CoinGecko:", binanceErr);
    try {
      const res = await fetch(
        `${COINGECKO_API}/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false`
      );
      if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
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
    } catch (cgErr) {
      throw new Error(`Both Binance and CoinGecko 24h stats failed. Binance: ${binanceErr}. CoinGecko: ${cgErr}`);
    }
  }
}

/**
 * Fetch historical klines/candles from Binance.
 * @param interval - Candle interval: 1m, 5m, 15m, 1h, 4h, 1d
 * @param limit - Number of candles (max 1000)
 */
export async function fetchCandles(
  interval: string = "1h",
  limit: number = 500
): Promise<BinanceCandle[]> {
  const res = await fetch(
    `${BINANCE_API}/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`
  );
  if (!res.ok) throw new Error(`Binance klines fetch failed: ${res.status}`);
  const data = (await res.json()) as Array<Array<string | number>>;

  return data.map((k) => ({
    openTime: k[0] as number,
    open: parseFloat(k[1] as string),
    high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string),
    close: parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string),
    closeTime: k[6] as number,
  }));
}

/**
 * Fetch candles with a start time for backfilling.
 */
export async function fetchCandlesFrom(
  interval: string,
  startTime: number,
  limit: number = 1000
): Promise<BinanceCandle[]> {
  const res = await fetch(
    `${BINANCE_API}/klines?symbol=BTCUSDT&interval=${interval}&startTime=${startTime}&limit=${limit}`
  );
  if (!res.ok) throw new Error(`Binance klines fetch failed: ${res.status}`);
  const data = (await res.json()) as Array<Array<string | number>>;

  return data.map((k) => ({
    openTime: k[0] as number,
    open: parseFloat(k[1] as string),
    high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string),
    close: parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string),
    closeTime: k[6] as number,
  }));
}

/**
 * Fetch order book depth (top bids/asks).
 */
export async function fetchOrderBook(
  limit: number = 10
): Promise<{
  bids: Array<{ price: number; qty: number }>;
  asks: Array<{ price: number; qty: number }>;
}> {
  const res = await fetch(`${BINANCE_API}/depth?symbol=BTCUSDT&limit=${limit}`);
  if (!res.ok) throw new Error(`Binance depth fetch failed: ${res.status}`);
  const data = (await res.json()) as {
    bids: Array<[string, string]>;
    asks: Array<[string, string]>;
  };
  return {
    bids: data.bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
    asks: data.asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
  };
}
