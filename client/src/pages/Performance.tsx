import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, TrendingUp, Target, BarChart3, Brain } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, BarChart, Bar, Legend, ReferenceLine,
} from "recharts";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Streamdown } from "streamdown";
import { toast } from "sonner";

export default function Performance() {
  // Books are selectable because there are now three with different strategies:
  // internal/okx-demo run the static allocation, shadow-engine runs the engine.
  // A single hardcoded book would silently report one strategy's numbers as if
  // they were the app's.
  const [venue, setVenue] = useState("internal");
  const { data: venues } = trpc.simulator.venues.useQuery(undefined, { refetchInterval: 60000 });
  const { data: summary, isLoading } = trpc.performance.summary.useQuery({ venue }, { refetchInterval: 30000 });
  const { data: weekly } = trpc.performance.weekly.useQuery({ limit: 52 }, { refetchInterval: 60000 });
  const { data: validation } = trpc.performance.validation.useQuery({ limit: 20 }, { refetchInterval: 60000 });
  const { data: trades } = trpc.simulator.trades.useQuery({ limit: 200, venue }, { refetchInterval: 60000 });

  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
  const analyzeMutation = trpc.ai.analyze.useMutation({
    onSuccess: (data) => setAiAnalysis(data.analysis),
    onError: (err) => toast.error(err.message),
  });

  const weeklyChartData = useMemo(() => {
    if (!weekly) return [];
    return [...weekly].reverse().map((w) => ({
      week: new Date(w.weekEnd).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      strategy: Number(w.returnPct.toFixed(2)),
      buyHold: Number(w.btcBuyHoldReturnPct.toFixed(2)),
    }));
  }, [weekly]);

  const portfolioGrowthData = useMemo(() => {
    if (!trades || trades.length === 0) return [];
    const sorted = [...trades].reverse();
    return sorted.map((t) => ({
      time: new Date(t.ts).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit" }),
      value: Number(t.totalValueAfter.toFixed(2)),
    }));
  }, [trades]);

  const validationChartData = useMemo(() => {
    if (!validation) return [];
    return [...validation].reverse().map((v) => ({
      period: new Date(v.periodEnd).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      winRate: Number((v.winRate * 100).toFixed(1)),
      signals: v.totalSignals,
      sharpe: v.sharpeRatio != null ? Number(v.sharpeRatio.toFixed(2)) : null,
      drawdown: v.maxDrawdown != null ? Number((v.maxDrawdown * 100).toFixed(1)) : null,
    }));
  }, [validation]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-hud text-2xl font-bold tracking-wider neon-glow-cyan text-[oklch(0.82_0.18_195)]">
            PERFORMANCE
          </h1>
          <p className="text-muted-foreground text-sm mt-1 font-mono-tech">
            Weekly returns &middot; Validation &middot; AI analysis
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={venue}
            onChange={(e) => setVenue(e.target.value)}
            className="bg-background border border-border rounded px-2 py-1 text-xs font-mono-tech"
          >
            {(venues ?? ["internal"]).map((v: string) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
          <Button
            onClick={() => analyzeMutation.mutate({})}
            disabled={analyzeMutation.isPending}
            className="font-mono-tech text-xs bg-primary hover:bg-primary/80"
          >
            {analyzeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Brain className="h-4 w-4 mr-1" />}
            AI Analysis
          </Button>
        </div>
      </div>

      {/* Caveats that would otherwise make these numbers quietly wrong to read.
          The internal book's history spans a strategy change, so its lifetime
          return blends two strategies rather than measuring either. */}
      {(summary?.signalsAreAdvisory || (summary?.equityPoints ?? 0) < 3) && (
        <div className="text-xs font-mono-tech text-amber-500 border border-amber-500/30 rounded px-3 py-2 space-y-1">
          {summary?.signalsAreAdvisory && (
            <div>
              * <strong>{venue}</strong> runs the STATIC allocation. Signals are advisory and
              do not trade it, so Signal Win Rate measures the engine&apos;s accuracy, not this
              book&apos;s performance. Select <strong>shadow-engine</strong> to see the engine
              traded on paper.
            </div>
          )}
          {venue === "internal" && (
            <div>
              This book&apos;s history spans a strategy change (engine until 2026-08-16, static
              after), so its lifetime return blends both. Compare books from 2026-08-16 onward.
            </div>
          )}
          {(summary?.equityPoints ?? 0) < 3 && (
            <div>
              * Max Drawdown is based on {summary?.equityPoints ?? 0} equity point(s) — too few
              to be meaningful yet. It becomes reliable as price history accumulates.
            </div>
          )}
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
        <Card className="hud-panel relative hud-corner border-border">
          <CardContent className="pt-4">
            <div className="text-xs font-mono-tech text-muted-foreground uppercase">Portfolio</div>
            <div className="font-hud text-lg text-primary neon-glow-pink mt-1">
              ${summary?.portfolioValue?.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </div>
          </CardContent>
        </Card>
        <Card className="hud-panel border-border">
          <CardContent className="pt-4">
            <div className="text-xs font-mono-tech text-muted-foreground uppercase">Total Return</div>
            <div className={`font-hud text-lg mt-1 ${(summary?.totalReturn ?? 0) >= 0 ? "text-[oklch(0.82_0.22_145)]" : "text-destructive"}`}>
              {(summary?.totalReturn ?? 0) >= 0 ? "+" : ""}{summary?.totalReturn?.toFixed(2)}%
            </div>
          </CardContent>
        </Card>
        <Card className="hud-panel border-border">
          <CardContent className="pt-4">
            <div className="text-xs font-mono-tech text-muted-foreground uppercase">
              {summary?.signalsAreAdvisory ? "Signal Win Rate*" : "Win Rate"}
            </div>
            <div className="font-hud text-lg text-[oklch(0.82_0.18_195)] mt-1">
              {((summary?.winRate ?? 0) * 100).toFixed(1)}%
            </div>
          </CardContent>
        </Card>
        <Card className="hud-panel border-border">
          <CardContent className="pt-4">
            <div className="text-xs font-mono-tech text-muted-foreground uppercase">Total Trades</div>
            <div className="font-hud text-lg text-foreground mt-1">{summary?.totalTrades ?? 0}</div>
          </CardContent>
        </Card>
        <Card className="hud-panel border-border">
          <CardContent className="pt-4">
            <div className="text-xs font-mono-tech text-muted-foreground uppercase">Signals</div>
            <div className="font-hud text-lg text-foreground mt-1">{summary?.totalSignals ?? 0}</div>
          </CardContent>
        </Card>
        <Card className="hud-panel border-border">
          <CardContent className="pt-4">
            <div className="text-xs font-mono-tech text-muted-foreground uppercase">Sharpe Ratio</div>
            <div className={`font-hud text-lg mt-1 ${(summary?.sharpeRatio ?? 0) >= 1 ? "text-[oklch(0.82_0.22_145)]" : (summary?.sharpeRatio ?? 0) >= 0 ? "text-[oklch(0.82_0.18_195)]" : "text-destructive"}`}>
              {(summary?.sharpeRatio ?? 0).toFixed(2)}
            </div>
          </CardContent>
        </Card>
        <Card className="hud-panel border-border">
          <CardContent className="pt-4">
            <div className="text-xs font-mono-tech text-muted-foreground uppercase">
              Max Drawdown{(summary?.equityPoints ?? 0) < 3 ? "*" : ""}
            </div>
            <div className="font-hud text-lg text-destructive mt-1">
              {(summary?.maxDrawdown ?? 0).toFixed(2)}%
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Portfolio Growth Chart */}
      <Card className="hud-panel relative hud-corner border-border">
        <CardHeader>
          <CardTitle className="font-hud text-sm tracking-wider text-[oklch(0.72_0.25_350)]">
            PORTFOLIO GROWTH
          </CardTitle>
        </CardHeader>
        <CardContent>
          {portfolioGrowthData.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground font-mono-tech">
              No trade data yet. Portfolio growth tracks after trades execute.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={portfolioGrowthData}>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.03 280)" />
                <XAxis dataKey="time" tick={{ fill: "oklch(0.6 0.02 280)", fontSize: 10, fontFamily: "Share Tech Mono" }} stroke="oklch(0.25 0.03 280)" />
                <YAxis tick={{ fill: "oklch(0.6 0.02 280)", fontSize: 10, fontFamily: "Share Tech Mono" }} stroke="oklch(0.25 0.03 280)" tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`} />
                <Tooltip contentStyle={{ backgroundColor: "oklch(0.12 0.015 280)", border: "1px solid oklch(0.72 0.25 350 / 40%)", borderRadius: "8px", fontFamily: "Share Tech Mono", color: "oklch(0.92 0.01 280)" }} formatter={(value: number) => [`$${value.toLocaleString()}`]} />
                <ReferenceLine y={10000} stroke="oklch(0.6 0.02 280)" strokeDasharray="5 5" label={{ value: "Seed $10k", fill: "oklch(0.6 0.02 280)", fontSize: 10 }} />
                <Line type="monotone" dataKey="value" name="Portfolio Value" stroke="oklch(0.72 0.25 350)" strokeWidth={2} dot={{ fill: "oklch(0.72 0.25 350)", r: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Weekly Performance Chart */}
      <Card className="hud-panel relative hud-corner border-border">
        <CardHeader>
          <CardTitle className="font-hud text-sm tracking-wider text-[oklch(0.82_0.18_195)]">
            WEEKLY RETURNS: STRATEGY vs BUY-HOLD
          </CardTitle>
        </CardHeader>
        <CardContent>
          {weeklyChartData.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground font-mono-tech">
              No weekly data yet. Reports generate automatically each Sunday.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={weeklyChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.03 280)" />
                <XAxis dataKey="week" tick={{ fill: "oklch(0.6 0.02 280)", fontSize: 10, fontFamily: "Share Tech Mono" }} stroke="oklch(0.25 0.03 280)" />
                <YAxis tick={{ fill: "oklch(0.6 0.02 280)", fontSize: 10, fontFamily: "Share Tech Mono" }} stroke="oklch(0.25 0.03 280)" tickFormatter={(v) => `${v}%`} />
                <Tooltip contentStyle={{ backgroundColor: "oklch(0.12 0.015 280)", border: "1px solid oklch(0.72 0.25 350 / 40%)", borderRadius: "8px", fontFamily: "Share Tech Mono", color: "oklch(0.92 0.01 280)" }} formatter={(value: number) => [`${value}%`]} />
                <Legend wrapperStyle={{ fontFamily: "Share Tech Mono", fontSize: 12, color: "oklch(0.6 0.02 280)" }} />
                <Bar dataKey="strategy" name="Strategy" fill="oklch(0.72 0.25 350)" />
                <Bar dataKey="buyHold" name="BTC Buy-Hold" fill="oklch(0.82 0.18 195 / 60%)" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Validation History */}
      <Card className="hud-panel relative hud-corner border-border">
        <CardHeader>
          <CardTitle className="font-hud text-sm tracking-wider text-[oklch(0.82_0.18_195)]">
            SIGNAL VALIDATION HISTORY
          </CardTitle>
        </CardHeader>
        <CardContent>
          {validationChartData.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground font-mono-tech">
              No validation data yet. Signals are validated automatically after 1 hour.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={validationChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.03 280)" />
                <XAxis dataKey="period" tick={{ fill: "oklch(0.6 0.02 280)", fontSize: 10, fontFamily: "Share Tech Mono" }} stroke="oklch(0.25 0.03 280)" />
                <YAxis yAxisId="left" domain={[0, 100]} tick={{ fill: "oklch(0.6 0.02 280)", fontSize: 10, fontFamily: "Share Tech Mono" }} stroke="oklch(0.25 0.03 280)" tickFormatter={(v) => `${v}%`} />
                <YAxis yAxisId="right" orientation="right" tick={{ fill: "oklch(0.6 0.02 280)", fontSize: 10, fontFamily: "Share Tech Mono" }} stroke="oklch(0.25 0.03 280)" />
                <Tooltip contentStyle={{ backgroundColor: "oklch(0.12 0.015 280)", border: "1px solid oklch(0.82 0.18 195 / 40%)", borderRadius: "8px", fontFamily: "Share Tech Mono", color: "oklch(0.92 0.01 280)" }} />
                <Legend wrapperStyle={{ fontFamily: "Share Tech Mono", fontSize: 11, color: "oklch(0.6 0.02 280)" }} />
                <Line yAxisId="left" type="monotone" dataKey="winRate" name="Win Rate %" stroke="oklch(0.82 0.22 145)" strokeWidth={2} dot={{ fill: "oklch(0.82 0.22 145)", r: 3 }} />
                <Line yAxisId="left" type="monotone" dataKey="drawdown" name="Drawdown %" stroke="oklch(0.72 0.25 350)" strokeWidth={2} dot={{ fill: "oklch(0.72 0.25 350)", r: 3 }} />
                <Line yAxisId="right" type="monotone" dataKey="sharpe" name="Sharpe Ratio" stroke="oklch(0.82 0.18 195)" strokeWidth={2} dot={{ fill: "oklch(0.82 0.18 195)", r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* AI Analysis */}
      {aiAnalysis && (
        <Card className="hud-panel relative hud-corner border-border">
          <CardHeader>
            <CardTitle className="font-hud text-sm tracking-wider text-[oklch(0.72_0.25_350)]">
              AI MARKET ANALYSIS
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="prose prose-invert prose-sm max-w-none font-mono-tech">
              <Streamdown>{aiAnalysis}</Streamdown>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
