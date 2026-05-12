import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, TrendingUp, TrendingDown, ArrowUpDown, Volume2, Info } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
} from "recharts";
import { useState, useMemo, useEffect } from "react";
import { toast } from "sonner";
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const INTERVALS = [
  { value: "1m",  label: "1M" },
  { value: "5m",  label: "5M" },
  { value: "15m", label: "15M" },
  { value: "1h",  label: "1H" },
  { value: "4h",  label: "4H" },
  { value: "1d",  label: "1D" },
];

export default function LivePrice() {
  // Local state initialised from the persisted strategy setting once loaded
  const [interval, setIntervalState] = useState("1h");
  const [intervalSaving, setIntervalSaving] = useState(false);

  const utils = trpc.useUtils();

  // Load persisted interval from the active strategy
  const { data: strategy } = trpc.strategy.active.useQuery(undefined, {
    refetchInterval: false,
  });

  // Sync local state when the strategy loads for the first time
  useEffect(() => {
    if (strategy?.candleInterval) {
      setIntervalState(strategy.candleInterval);
    }
  }, [strategy?.candleInterval]);

  const updateSettings = trpc.strategy.updateSettings.useMutation({
    onSuccess: (data) => {
      utils.strategy.active.invalidate();
      toast.success(`Signal interval set to ${data.candleInterval.toUpperCase()}`, {
        description: "Affects metric sensitivity and signal conviction per run. Signal frequency is controlled by the heartbeat schedule.",
        duration: 4000,
      });
      setIntervalSaving(false);
    },
    onError: (err) => {
      toast.error("Failed to save interval: " + err.message);
      setIntervalSaving(false);
    },
  });

  const handleIntervalChange = (iv: string) => {
    if (iv === interval || intervalSaving) return;
    setIntervalState(iv);
    setIntervalSaving(true);
    updateSettings.mutate({ candleInterval: iv as "1m" | "5m" | "15m" | "1h" | "4h" | "1d" });
  };

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
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    }));
  }, [candles]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="font-hud text-2xl font-bold tracking-wider neon-glow-cyan text-[oklch(0.82_0.18_195)]">
            LIVE PRICE
          </h1>
          <p className="text-muted-foreground text-sm mt-1 font-mono-tech">
            BTC/USDT &middot; Kraken feed (CoinGecko / Yahoo fallback)
          </p>
        </div>

        {/* Signal Interval Toggle */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-mono-tech text-muted-foreground uppercase tracking-wider">
              Signal Interval
            </span>
            <UITooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                className="max-w-[280px] text-xs font-mono-tech bg-card border-border text-foreground"
              >
                <p className="font-semibold text-[oklch(0.82_0.18_195)] mb-1">Signal Interval</p>
                <p>
                  Controls the candle timeframe used for metric computation (RSI, MACD, Bollinger
                  Bands, Z-score) and signal conviction per run.
                </p>
                <p className="mt-1.5 text-muted-foreground">
                  Shorter intervals (1M, 5M) are more reactive but noisier. Longer intervals (4H,
                  1D) produce fewer, higher-conviction signals.
                </p>
                <p className="mt-1.5 border-t border-border pt-1.5 text-[oklch(0.82_0.22_145)]">
                  ⚠ Does NOT change how often the engine runs. Signal frequency is set by the
                  Heartbeat Schedule on the Strategy page.
                </p>
              </TooltipContent>
            </UITooltip>
          </div>
          <div className="flex gap-1">
            {INTERVALS.map((iv) => (
              <button
                key={iv.value}
                onClick={() => handleIntervalChange(iv.value)}
                disabled={intervalSaving}
                className={`px-3 py-1.5 text-xs font-mono-tech rounded border transition-all disabled:opacity-50 ${
                  interval === iv.value
                    ? "border-primary bg-primary/10 text-primary neon-border-pink"
                    : "border-border text-muted-foreground hover:border-primary/50"
                }`}
              >
                {intervalSaving && interval === iv.value ? (
                  <Loader2 className="h-3 w-3 animate-spin inline" />
                ) : (
                  iv.label
                )}
              </button>
            ))}
          </div>
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
                <span className={`font-hud text-xl font-bold ${
                  stats.priceChangePct >= 0 ? "text-[oklch(0.82_0.22_145)] neon-glow-green" : "text-destructive"
                }`}>
                  {stats.priceChangePct >= 0 ? "+" : ""}{stats.priceChangePct.toFixed(2)}%
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
                  ${stats.low24h.toLocaleString(undefined, { maximumFractionDigits: 0 })} – ${stats.high24h.toLocaleString(undefined, { maximumFractionDigits: 0 })}
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
            PRICE CHART &mdash; {interval.toUpperCase()} CANDLES
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
            VOLUME &mdash; {interval.toUpperCase()}
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
