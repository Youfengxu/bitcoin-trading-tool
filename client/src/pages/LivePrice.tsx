import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, TrendingUp, TrendingDown, ArrowUpDown, Volume2 } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
} from "recharts";
import { useState, useMemo } from "react";

export default function LivePrice() {
  const [interval, setInterval] = useState("1h");
  const { data: price, isLoading: priceLoading } = trpc.market.currentPrice.useQuery(
    undefined, { refetchInterval: 10000 }
  );
  const { data: stats } = trpc.market.stats24h.useQuery(undefined, { refetchInterval: 30000 });
  const { data: candles, isLoading: candlesLoading } = trpc.market.candles.useQuery(
    { interval, limit: 100 }, { refetchInterval: 60000 }
  );

  const chartData = useMemo(() => {
    if (!candles) return [];
    return candles.map((c) => ({
      time: new Date(c.openTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
  }, [candles]);

  const intervals = ["1m", "5m", "15m", "1h", "4h", "1d"];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-hud text-2xl font-bold tracking-wider neon-glow-cyan text-[oklch(0.82_0.18_195)]">
            LIVE PRICE
          </h1>
          <p className="text-muted-foreground text-sm mt-1 font-mono-tech">
            BTC/USDT &middot; Binance Feed (CoinGecko fallback)
          </p>
        </div>
        <div className="flex gap-1">
          {intervals.map((iv) => (
            <button
              key={iv}
              onClick={() => setInterval(iv)}
              className={`px-3 py-1.5 text-xs font-mono-tech rounded border transition-all ${
                interval === iv
                  ? "border-primary bg-primary/10 text-primary neon-border-pink"
                  : "border-border text-muted-foreground hover:border-primary/50"
              }`}
            >
              {iv.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Price Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="hud-panel relative hud-corner border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-mono-tech text-muted-foreground uppercase tracking-wider">
              Current Price
            </CardTitle>
          </CardHeader>
          <CardContent>
            {priceLoading ? (
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            ) : (
              <div className="font-hud text-2xl font-bold neon-glow-pink text-primary">
                ${price?.price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="hud-panel relative hud-corner border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-mono-tech text-muted-foreground uppercase tracking-wider">
              24h Change
            </CardTitle>
          </CardHeader>
          <CardContent>
            {stats ? (
              <div className="flex items-center gap-2">
                {stats.priceChangePct >= 0 ? (
                  <TrendingUp className="h-5 w-5 text-[oklch(0.82_0.22_145)]" />
                ) : (
                  <TrendingDown className="h-5 w-5 text-destructive" />
                )}
                <span
                  className={`font-hud text-xl font-bold ${
                    stats.priceChangePct >= 0 ? "text-[oklch(0.82_0.22_145)] neon-glow-green" : "text-destructive"
                  }`}
                >
                  {stats.priceChangePct >= 0 ? "+" : ""}
                  {stats.priceChangePct.toFixed(2)}%
                </span>
              </div>
            ) : (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            )}
          </CardContent>
        </Card>

        <Card className="hud-panel relative hud-corner border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-mono-tech text-muted-foreground uppercase tracking-wider">
              24h Range
            </CardTitle>
          </CardHeader>
          <CardContent>
            {stats ? (
              <div className="flex items-center gap-2">
                <ArrowUpDown className="h-4 w-4 text-[oklch(0.82_0.18_195)]" />
                <span className="font-mono-tech text-sm text-foreground">
                  ${stats.low24h.toLocaleString(undefined, { maximumFractionDigits: 0 })} - ${stats.high24h.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
              </div>
            ) : (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            )}
          </CardContent>
        </Card>

        <Card className="hud-panel relative hud-corner border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-mono-tech text-muted-foreground uppercase tracking-wider">
              24h Volume
            </CardTitle>
          </CardHeader>
          <CardContent>
            {stats ? (
              <div className="flex items-center gap-2">
                <Volume2 className="h-4 w-4 text-[oklch(0.82_0.18_85)]" />
                <span className="font-mono-tech text-sm text-foreground">
                  {stats.volume24h.toLocaleString(undefined, { maximumFractionDigits: 0 })} BTC
                </span>
              </div>
            ) : (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Price Chart */}
      <Card className="hud-panel relative hud-corner border-border">
        <CardHeader>
          <CardTitle className="font-hud text-sm tracking-wider text-[oklch(0.82_0.18_195)]">
            PRICE CHART
          </CardTitle>
        </CardHeader>
        <CardContent>
          {candlesLoading ? (
            <div className="flex items-center justify-center h-[400px]">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={400}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="oklch(0.72 0.25 350)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="oklch(0.72 0.25 350)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.03 280)" />
                <XAxis
                  dataKey="time"
                  tick={{ fill: "oklch(0.6 0.02 280)", fontSize: 10, fontFamily: "Share Tech Mono" }}
                  stroke="oklch(0.25 0.03 280)"
                />
                <YAxis
                  domain={["auto", "auto"]}
                  tick={{ fill: "oklch(0.6 0.02 280)", fontSize: 10, fontFamily: "Share Tech Mono" }}
                  stroke="oklch(0.25 0.03 280)"
                  tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "oklch(0.12 0.015 280)",
                    border: "1px solid oklch(0.72 0.25 350 / 40%)",
                    borderRadius: "8px",
                    fontFamily: "Share Tech Mono",
                    color: "oklch(0.92 0.01 280)",
                  }}
                  formatter={(value: number) => [`$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`, "Price"]}
                />
                <Area
                  type="monotone"
                  dataKey="close"
                  stroke="oklch(0.72 0.25 350)"
                  strokeWidth={2}
                  fill="url(#priceGradient)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Volume Chart */}
      <Card className="hud-panel relative hud-corner border-border">
        <CardHeader>
          <CardTitle className="font-hud text-sm tracking-wider text-[oklch(0.82_0.18_195)]">
            VOLUME
          </CardTitle>
        </CardHeader>
        <CardContent>
          {candlesLoading ? (
            <div className="flex items-center justify-center h-[200px]">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.03 280)" />
                <XAxis
                  dataKey="time"
                  tick={{ fill: "oklch(0.6 0.02 280)", fontSize: 10, fontFamily: "Share Tech Mono" }}
                  stroke="oklch(0.25 0.03 280)"
                />
                <YAxis
                  tick={{ fill: "oklch(0.6 0.02 280)", fontSize: 10, fontFamily: "Share Tech Mono" }}
                  stroke="oklch(0.25 0.03 280)"
                  tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "oklch(0.12 0.015 280)",
                    border: "1px solid oklch(0.82 0.18 195 / 40%)",
                    borderRadius: "8px",
                    fontFamily: "Share Tech Mono",
                    color: "oklch(0.92 0.01 280)",
                  }}
                />
                <Bar dataKey="volume" fill="oklch(0.82 0.18 195 / 60%)" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
