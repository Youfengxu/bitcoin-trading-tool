import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Info, TrendingUp, TrendingDown, Minus, AlertTriangle } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import { useMemo } from "react";
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const INTERVAL_LABELS: Record<string, string> = {
  "1m": "1M", "5m": "5M", "15m": "15M", "1h": "1H", "4h": "4H", "1d": "1D",
};

function MetricGauge({ label, value, min, max, unit, color }: {
  label: string; value: number | undefined; min: number; max: number; unit?: string; color: string;
}) {
  if (value === undefined) return null;
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <span className="text-xs font-mono-tech text-muted-foreground uppercase tracking-wider">{label}</span>
        <span className="font-mono-tech text-sm" style={{ color }}>{value.toFixed(2)}{unit || ""}</span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

// ─── External Signal helpers ──────────────────────────────────────────────────

function fearGreedMeta(v: number | null): { label: string; color: string; bg: string } {
  if (v === null) return { label: "N/A", color: "oklch(0.6 0.02 280)", bg: "oklch(0.6 0.02 280 / 10%)" };
  if (v >= 80) return { label: "Extreme Greed", color: "oklch(0.65 0.25 25)",  bg: "oklch(0.65 0.25 25 / 10%)" };
  if (v >= 60) return { label: "Greed",         color: "oklch(0.72 0.20 60)",  bg: "oklch(0.72 0.20 60 / 10%)" };
  if (v >= 40) return { label: "Neutral",        color: "oklch(0.82 0.18 195)", bg: "oklch(0.82 0.18 195 / 10%)" };
  if (v >= 21) return { label: "Fear",           color: "oklch(0.82 0.18 195)", bg: "oklch(0.82 0.18 195 / 10%)" };
  return              { label: "Extreme Fear",   color: "oklch(0.82 0.22 145)", bg: "oklch(0.82 0.22 145 / 10%)" };
}

function fundingMeta(v: number | null): { label: string; color: string } {
  if (v === null) return { label: "N/A",            color: "oklch(0.6 0.02 280)" };
  if (v > 0.001)  return { label: "Extreme Long",   color: "oklch(0.65 0.25 25)"  };
  if (v > 0.0005) return { label: "Crowded Long",   color: "oklch(0.72 0.20 60)"  };
  if (v >= 0)     return { label: "Neutral",         color: "oklch(0.82 0.18 195)" };
  return               { label: "Short Bias",       color: "oklch(0.82 0.22 145)" };
}

function ibitMeta(v: number | null): { label: string; color: string; icon: "up" | "down" | "flat" } {
  if (v === null)   return { label: "N/A",           color: "oklch(0.6 0.02 280)",  icon: "flat" };
  if (v > 4000)     return { label: "Strong Inflow", color: "oklch(0.82 0.22 145)", icon: "up"   };
  if (v > 1500)     return { label: "Inflow",        color: "oklch(0.82 0.22 145)", icon: "up"   };
  if (v > -800)     return { label: "Neutral",       color: "oklch(0.82 0.18 195)", icon: "flat" };
  if (v > -2000)    return { label: "Outflow",       color: "oklch(0.72 0.25 350)", icon: "down" };
  return                   { label: "Heavy Outflow", color: "oklch(0.65 0.25 25)",  icon: "down" };
}

function yieldMeta(v: number | null): { label: string; color: string } {
  if (v === null) return { label: "N/A",       color: "oklch(0.6 0.02 280)"  };
  if (v > 0.15)   return { label: "Risk-Off ↑", color: "oklch(0.65 0.25 25)"  };
  if (v > 0.08)   return { label: "Moderate ↑", color: "oklch(0.72 0.20 60)"  };
  if (v > -0.08)  return { label: "Neutral",    color: "oklch(0.82 0.18 195)" };
  return               { label: "Risk-On ↓",  color: "oklch(0.82 0.22 145)" };
}

export default function Metrics() {
  // Read the persisted candle interval from the active strategy so this page
  // stays in sync with the Signal Interval toggle on the Live Price page.
  const { data: activeStrategy } = trpc.strategy.active.useQuery(undefined, { refetchInterval: 30000 });
  const candleInterval = activeStrategy?.candleInterval ?? "1h";

  const { data: metrics, isLoading } = trpc.metrics.current.useQuery(
    { interval: candleInterval },
    { refetchInterval: 60000 }
  );
  const { data: snapshots } = trpc.metrics.history.useQuery({ limit: 50 }, { refetchInterval: 60000 });
  const { data: ext } = trpc.metrics.externalSignals.useQuery(undefined, {
    refetchInterval: 5 * 60 * 1000,  // refresh every 5 min — external APIs don't change faster
    staleTime: 4 * 60 * 1000,
  });

  const historyData = useMemo(() => {
    if (!snapshots) return [];
    return [...snapshots].reverse().map((s) => ({
      time: new Date(s.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      rsi: s.rsi14,
      macdLine: s.macdLine,
      macdSignal: s.macdSignal,
      bbUpper: s.bbUpper,
      bbMiddle: s.bbMiddle,
      bbLower: s.bbLower,
      ema12: s.ema12,
      sma50: s.sma50,
      zScore: s.zScore,
      price: s.price,
    }));
  }, [snapshots]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-hud text-2xl font-bold tracking-wider neon-glow-cyan text-[oklch(0.82_0.18_195)]">
            METRICS
          </h1>
          <p className="text-muted-foreground text-sm mt-1 font-mono-tech">
            Technical indicators &middot; Statistical analysis
          </p>
        </div>
        {/* Show the active candle interval — synced from the Live Price page */}
        <UITooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-[oklch(0.82_0.18_195)]/30 bg-[oklch(0.82_0.18_195)]/5 cursor-default">
              <span className="text-xs font-mono-tech text-[oklch(0.82_0.18_195)]">
                Interval: {INTERVAL_LABELS[candleInterval] ?? candleInterval}
              </span>
              <Info className="h-3 w-3 text-muted-foreground" />
            </div>
          </TooltipTrigger>
          <TooltipContent
            side="left"
            className="max-w-[260px] text-xs font-mono-tech bg-card border-border text-foreground"
          >
            <p className="font-semibold text-[oklch(0.82_0.18_195)] mb-1">Synced from Live Price</p>
            <p>
              All metrics on this page are computed on <strong>{INTERVAL_LABELS[candleInterval] ?? candleInterval}</strong> candles,
              matching the Signal Interval selected on the Live Price page.
            </p>
            <p className="mt-1 text-muted-foreground">
              Change the interval on the Live Price page to update metrics here.
            </p>
          </TooltipContent>
        </UITooltip>
      </div>

      {/* Current Metrics Overview */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="hud-panel relative hud-corner border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-mono-tech text-muted-foreground uppercase tracking-wider">
              Momentum
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <MetricGauge label="RSI (14)" value={metrics?.rsi14 ?? undefined} min={0} max={100} color="oklch(0.72 0.25 350)" />
            <div className="flex gap-2">
              {metrics && (metrics.rsi14 ?? 50) < 30 && <Badge className="bg-[oklch(0.82_0.22_145)]/20 text-[oklch(0.82_0.22_145)] border-[oklch(0.82_0.22_145)]/30">Oversold</Badge>}
              {metrics && (metrics.rsi14 ?? 50) > 70 && <Badge className="bg-destructive/20 text-destructive border-destructive/30">Overbought</Badge>}
              {metrics && (metrics.rsi14 ?? 50) >= 30 && (metrics.rsi14 ?? 50) <= 70 && <Badge variant="outline" className="text-muted-foreground">Neutral</Badge>}
            </div>
          </CardContent>
        </Card>

        <Card className="hud-panel relative hud-corner border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-mono-tech text-muted-foreground uppercase tracking-wider">
              Trend
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-xs font-mono-tech text-muted-foreground">MACD Line</span>
                <span className="font-mono-tech text-sm text-[oklch(0.82_0.18_195)]">{metrics?.macdLine?.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs font-mono-tech text-muted-foreground">Signal Line</span>
                <span className="font-mono-tech text-sm text-[oklch(0.82_0.18_85)]">{metrics?.macdSignal?.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs font-mono-tech text-muted-foreground">Histogram</span>
                <span className={`font-mono-tech text-sm ${(metrics?.macdHist ?? 0) >= 0 ? "text-[oklch(0.82_0.22_145)]" : "text-destructive"}`}>
                  {metrics?.macdHist?.toFixed(2)}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="hud-panel relative hud-corner border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-mono-tech text-muted-foreground uppercase tracking-wider">
              Statistical Significance
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <MetricGauge label="Z-Score" value={metrics?.zScore ?? undefined} min={-4} max={4} color="oklch(0.82 0.18 195)" />
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono-tech text-muted-foreground">Classification:</span>
              {metrics?.trendClassification === "trend" && (
                <Badge className="bg-[oklch(0.72_0.25_350)]/20 text-[oklch(0.72_0.25_350)] border-[oklch(0.72_0.25_350)]/30 font-mono-tech">
                  SIGNIFICANT TREND
                </Badge>
              )}
              {metrics?.trendClassification === "blip" && (
                <Badge variant="outline" className="text-muted-foreground font-mono-tech">NOISE / BLIP</Badge>
              )}
              {metrics?.trendClassification === "neutral" && (
                <Badge className="bg-[oklch(0.82_0.18_85)]/20 text-[oklch(0.82_0.18_85)] border-[oklch(0.82_0.18_85)]/30 font-mono-tech">
                  MODERATE
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* External Market Signals */}
      <Card className="hud-panel relative hud-corner border-border">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="font-hud text-sm tracking-wider text-[oklch(0.82_0.18_195)]">
              EXTERNAL MARKET SIGNALS
            </CardTitle>
            {ext && (
              <span className="text-[10px] font-mono-tech text-muted-foreground">
                updated {Math.max(0, Math.round((Date.now() - ext.fetchedAt) / 60000))}m ago
              </span>
            )}
          </div>
          <p className="text-[11px] font-mono-tech text-muted-foreground mt-0.5">
            Live modifiers applied to signal scores each heartbeat
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {!ext ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-xs font-mono-tech">Fetching external signals…</span>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* ── Funding Rate ─────────────────────────────────── */}
                {(() => {
                  const fm = fundingMeta(ext.fundingRate);
                  return (
                    <div className="p-3 rounded-lg border border-border bg-muted/10 space-y-2">
                      <div className="text-[10px] font-mono-tech text-muted-foreground uppercase tracking-wider">
                        Bybit Funding Rate (8h)
                      </div>
                      <div className="flex items-baseline gap-2">
                        <span className="font-hud text-xl" style={{ color: fm.color }}>
                          {ext.fundingRate !== null
                            ? `${ext.fundingRate >= 0 ? "+" : ""}${(ext.fundingRate * 100).toFixed(4)}%`
                            : "—"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge
                          variant="outline"
                          className="text-[10px] font-mono-tech border-current"
                          style={{ color: fm.color }}
                        >
                          {fm.label}
                        </Badge>
                        {ext.fundingNegDivergence && (
                          <Badge
                            variant="outline"
                            className="text-[10px] font-mono-tech text-[oklch(0.65_0.25_25)] border-[oklch(0.65_0.25_25)]"
                          >
                            <AlertTriangle className="h-2.5 w-2.5 mr-1" />
                            FLIP NEAR HIGH
                          </Badge>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* ── Fear & Greed ──────────────────────────────────── */}
                {(() => {
                  const fgm = fearGreedMeta(ext.fearGreed);
                  const pct = ext.fearGreed !== null ? Math.max(0, Math.min(100, ext.fearGreed)) : 0;
                  return (
                    <div className="p-3 rounded-lg border border-border bg-muted/10 space-y-2">
                      <div className="text-[10px] font-mono-tech text-muted-foreground uppercase tracking-wider">
                        Fear &amp; Greed Index
                      </div>
                      <div className="flex items-baseline gap-2">
                        <span className="font-hud text-xl" style={{ color: fgm.color }}>
                          {ext.fearGreed !== null ? ext.fearGreed : "—"}
                        </span>
                        <span className="text-xs font-mono-tech text-muted-foreground">/ 100</span>
                      </div>
                      {ext.fearGreed !== null && (
                        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "oklch(0.25 0.02 280)" }}>
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{ width: `${pct}%`, backgroundColor: fgm.color }}
                          />
                        </div>
                      )}
                      <Badge
                        variant="outline"
                        className="text-[10px] font-mono-tech border-current"
                        style={{ color: fgm.color }}
                      >
                        {fgm.label}
                      </Badge>
                    </div>
                  );
                })()}

                {/* ── US 10Y Yield Velocity ─────────────────────────── */}
                {(() => {
                  const ym = yieldMeta(ext.yieldVelocity);
                  return (
                    <div className="p-3 rounded-lg border border-border bg-muted/10 space-y-2">
                      <div className="text-[10px] font-mono-tech text-muted-foreground uppercase tracking-wider">
                        US 10Y Yield Velocity
                      </div>
                      <div className="flex items-baseline gap-2">
                        <span className="font-hud text-xl" style={{ color: ym.color }}>
                          {ext.yieldVelocity !== null
                            ? `${ext.yieldVelocity >= 0 ? "+" : ""}${ext.yieldVelocity.toFixed(3)}`
                            : "—"}
                        </span>
                        {ext.yieldVelocity !== null && (
                          <span className="text-xs font-mono-tech text-muted-foreground">ppt / day</span>
                        )}
                      </div>
                      <Badge
                        variant="outline"
                        className="text-[10px] font-mono-tech border-current"
                        style={{ color: ym.color }}
                      >
                        {ym.label}
                      </Badge>
                    </div>
                  );
                })()}

                {/* ── IBIT 7-Day Flow Proxy ─────────────────────────── */}
                {(() => {
                  const im = ibitMeta(ext.ibitFlow7d);
                  const Icon = im.icon === "up" ? TrendingUp : im.icon === "down" ? TrendingDown : Minus;
                  return (
                    <div className="p-3 rounded-lg border border-border bg-muted/10 space-y-2">
                      <div className="text-[10px] font-mono-tech text-muted-foreground uppercase tracking-wider">
                        IBIT 7-Day Flow Proxy
                      </div>
                      <div className="flex items-baseline gap-2">
                        <Icon className="h-4 w-4 mt-0.5 self-center" style={{ color: im.color }} />
                        <span className="font-hud text-xl" style={{ color: im.color }}>
                          {ext.ibitFlow7d !== null
                            ? `${ext.ibitFlow7d >= 0 ? "+" : ""}$${Math.round(Math.abs(ext.ibitFlow7d)).toLocaleString()}M`
                            : "—"}
                        </span>
                      </div>
                      <Badge
                        variant="outline"
                        className="text-[10px] font-mono-tech border-current"
                        style={{ color: im.color }}
                      >
                        {im.label}
                      </Badge>
                    </div>
                  );
                })()}
              </div>

              {/* Active modifier pills — mirrors what the signal engine emits */}
              {ext.activeMods.length > 0 ? (
                <div className="mt-1 p-3 rounded-lg border border-[oklch(0.72_0.25_350)]/30 bg-[oklch(0.72_0.25_350)]/5">
                  <div className="text-[10px] font-mono-tech text-muted-foreground uppercase tracking-wider mb-2">
                    Active Signal Modifiers
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {ext.activeMods.map((mod, i) => (
                      <code
                        key={i}
                        className="text-[10px] font-mono-tech text-[oklch(0.72_0.25_350)] bg-[oklch(0.72_0.25_350)]/10 px-2 py-0.5 rounded"
                      >
                        {mod}
                      </code>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="mt-1 p-2 rounded-lg border border-border bg-muted/5">
                  <span className="text-[10px] font-mono-tech text-muted-foreground">
                    No active modifiers — all signals within neutral thresholds
                  </span>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Moving Averages */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="hud-panel relative hud-corner border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-mono-tech text-muted-foreground uppercase tracking-wider">
              Moving Averages
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between">
              <span className="text-xs font-mono-tech text-muted-foreground">EMA 12</span>
              <span className="font-mono-tech text-sm text-[oklch(0.72_0.25_350)]">${metrics?.ema12?.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs font-mono-tech text-muted-foreground">EMA 26</span>
              <span className="font-mono-tech text-sm text-[oklch(0.82_0.18_195)]">${metrics?.ema26?.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs font-mono-tech text-muted-foreground">SMA 50</span>
              <span className="font-mono-tech text-sm text-[oklch(0.82_0.22_145)]">${metrics?.sma50?.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="hud-panel relative hud-corner border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-mono-tech text-muted-foreground uppercase tracking-wider">
              Bollinger Bands
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between">
              <span className="text-xs font-mono-tech text-muted-foreground">Upper Band</span>
              <span className="font-mono-tech text-sm text-destructive">${metrics?.bbUpper?.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs font-mono-tech text-muted-foreground">Middle Band</span>
              <span className="font-mono-tech text-sm text-[oklch(0.82_0.18_195)]">${metrics?.bbMiddle?.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs font-mono-tech text-muted-foreground">Lower Band</span>
              <span className="font-mono-tech text-sm text-[oklch(0.82_0.22_145)]">${metrics?.bbLower?.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs font-mono-tech text-muted-foreground">Bandwidth</span>
              <span className="font-mono-tech text-sm text-[oklch(0.82_0.18_85)]">{((metrics?.bbUpper && metrics?.bbLower && metrics?.bbMiddle) ? ((metrics.bbUpper - metrics.bbLower) / metrics.bbMiddle).toFixed(4) : '—')}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* RSI History Chart */}
      <Card className="hud-panel relative hud-corner border-border">
        <CardHeader>
          <CardTitle className="font-hud text-sm tracking-wider text-[oklch(0.82_0.18_195)]">RSI HISTORY</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={historyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.03 280)" />
              <XAxis dataKey="time" tick={{ fill: "oklch(0.6 0.02 280)", fontSize: 10, fontFamily: "Share Tech Mono" }} stroke="oklch(0.25 0.03 280)" />
              <YAxis domain={[0, 100]} tick={{ fill: "oklch(0.6 0.02 280)", fontSize: 10, fontFamily: "Share Tech Mono" }} stroke="oklch(0.25 0.03 280)" />
              <Tooltip contentStyle={{ backgroundColor: "oklch(0.12 0.015 280)", border: "1px solid oklch(0.72 0.25 350 / 40%)", borderRadius: "8px", fontFamily: "Share Tech Mono", color: "oklch(0.92 0.01 280)" }} />
              <ReferenceLine y={70} stroke="oklch(0.65 0.25 25)" strokeDasharray="5 5" label={{ value: "Overbought", fill: "oklch(0.65 0.25 25)", fontSize: 10 }} />
              <ReferenceLine y={30} stroke="oklch(0.82 0.22 145)" strokeDasharray="5 5" label={{ value: "Oversold", fill: "oklch(0.82 0.22 145)", fontSize: 10 }} />
              <Line type="monotone" dataKey="rsi" stroke="oklch(0.72 0.25 350)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Z-Score History */}
      <Card className="hud-panel relative hud-corner border-border">
        <CardHeader>
          <CardTitle className="font-hud text-sm tracking-wider text-[oklch(0.82_0.18_195)]">Z-SCORE HISTORY</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={historyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.03 280)" />
              <XAxis dataKey="time" tick={{ fill: "oklch(0.6 0.02 280)", fontSize: 10, fontFamily: "Share Tech Mono" }} stroke="oklch(0.25 0.03 280)" />
              <YAxis tick={{ fill: "oklch(0.6 0.02 280)", fontSize: 10, fontFamily: "Share Tech Mono" }} stroke="oklch(0.25 0.03 280)" />
              <Tooltip contentStyle={{ backgroundColor: "oklch(0.12 0.015 280)", border: "1px solid oklch(0.82 0.18 195 / 40%)", borderRadius: "8px", fontFamily: "Share Tech Mono", color: "oklch(0.92 0.01 280)" }} />
              <ReferenceLine y={2} stroke="oklch(0.72 0.25 350)" strokeDasharray="5 5" label={{ value: "Trend+", fill: "oklch(0.72 0.25 350)", fontSize: 10 }} />
              <ReferenceLine y={-2} stroke="oklch(0.72 0.25 350)" strokeDasharray="5 5" label={{ value: "Trend-", fill: "oklch(0.72 0.25 350)", fontSize: 10 }} />
              <ReferenceLine y={0} stroke="oklch(0.6 0.02 280)" strokeDasharray="3 3" />
              <Line type="monotone" dataKey="zScore" stroke="oklch(0.82 0.18 195)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* MVRV Ratio - On-Chain Metric */}
      <Card className="hud-panel relative hud-corner border-border">
        <CardHeader>
          <CardTitle className="font-hud text-sm tracking-wider text-[oklch(0.72_0.25_350)]">
            MVRV RATIO (ON-CHAIN)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="p-4 rounded-lg border border-border bg-muted/20">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2 h-2 rounded-full bg-[oklch(0.72_0.25_350)] animate-pulse" />
                <span className="font-mono-tech text-xs text-muted-foreground uppercase">Research Metric</span>
              </div>
              <p className="text-sm text-foreground/80 font-mono-tech leading-relaxed">
                The <strong className="text-primary">Market Value to Realized Value (MVRV)</strong> ratio compares
                Bitcoin&apos;s market capitalization to its realized capitalization. An MVRV above 3.5 historically
                indicates overvaluation (potential sell zone), while below 1.0 suggests undervaluation (potential
                accumulation zone).
              </p>
              <div className="mt-3 grid grid-cols-3 gap-3">
                <div className="text-center p-2 rounded border border-[oklch(0.82_0.22_145_/_20%)]">
                  <div className="text-xs font-mono-tech text-muted-foreground">Undervalued</div>
                  <div className="font-hud text-sm text-[oklch(0.82_0.22_145)]">&lt; 1.0</div>
                </div>
                <div className="text-center p-2 rounded border border-[oklch(0.82_0.18_195_/_20%)]">
                  <div className="text-xs font-mono-tech text-muted-foreground">Fair Value</div>
                  <div className="font-hud text-sm text-[oklch(0.82_0.18_195)]">1.0 - 3.5</div>
                </div>
                <div className="text-center p-2 rounded border border-[oklch(0.65_0.25_25_/_20%)]">
                  <div className="text-xs font-mono-tech text-muted-foreground">Overvalued</div>
                  <div className="font-hud text-sm text-[oklch(0.65_0.25_25)]">&gt; 3.5</div>
                </div>
              </div>
              <p className="mt-3 text-xs text-muted-foreground font-mono-tech">
                Data source: On-chain analytics platforms (Glassnode, CryptoQuant). MVRV requires blockchain
                data not available via exchange APIs. Integration planned for future release.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
