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
  const { data: cmp } = trpc.performance.comparison.useQuery(undefined, { refetchInterval: 60000 });

  // Merge every book's curve plus the benchmark onto a shared time axis so they
  // can be read against each other. Each series is already normalised to % from
  // the common anchor, which is what makes books of different sizes comparable.
  const curveData = useMemo(() => {
    if (!cmp) return [];
    const byTs = new Map<number, Record<string, number | string>>();
    const put = (name: string, pts: Array<{ ts: number; pct: number }>) => {
      for (const p of pts) {
        const row = byTs.get(p.ts) ?? { ts: p.ts, time: new Date(p.ts).toLocaleDateString() };
        row[name] = Number(p.pct.toFixed(2));
        byTs.set(p.ts, row);
      }
    };
    for (const b of cmp.books) put(b.venue, b.curve);
    put("buy & hold", cmp.benchmark.curve);
    return Array.from(byTs.values()).sort((a, b) => (a.ts as number) - (b.ts as number));
  }, [cmp]);

  const SERIES_COLOR: Record<string, string> = {
    "internal": "oklch(0.82 0.18 195)",
    "okx-demo": "oklch(0.72 0.25 350)",
    "shadow-engine": "oklch(0.85 0.20 85)",
    "buy & hold": "oklch(0.65 0.02 260)",
  };

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
      {(summary?.signalsAreAdvisory || (summary?.equityPoints ?? 0) < 3
        || summary?.riskMeanNegative || summary?.sharpeRatio == null) && (
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
          {summary?.riskMeanNegative && (
            <div>
              &dagger; Mean return over this window is negative, where <strong>Sharpe inverts</strong>:
              cutting volatility makes it more negative, so it penalises exactly the risk reduction
              a defensive strategy exists to provide. Showing <strong>Calmar</strong> (annualised
              return &divide; max drawdown) instead, which stays meaningful.
            </div>
          )}
          {summary?.sharpeRatio == null && !summary?.riskMeanNegative && (
            <div>
              Risk ratios need at least 30 return samples over 14 days
              ({summary?.riskSamples ?? 0} samples, {(summary?.riskSpanDays ?? 0).toFixed(1)} days so far).
              Shown as &mdash; rather than a number, since a short window produces a
              confident-looking wrong figure rather than a rough one.
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

      {/* ── Head to head ──────────────────────────────────────────────
          The question this setup exists to answer is whether the static
          allocation beats the engine, and whether either beats doing nothing.
          Answering it needs all books on ONE screen from a COMMON start —
          switching venues to compare makes the reader hold numbers in their
          head, and lifetime returns are not comparable across books that began
          at different times under different strategies. */}
      {cmp && cmp.books.length > 0 && (
        <Card className="hud-panel border-border">
          <CardHeader className="pb-2">
            <CardTitle className="font-hud text-sm tracking-wider">
              HEAD TO HEAD &middot; since {new Date(cmp.since).toLocaleDateString()}
            </CardTitle>
            <p className="text-xs text-muted-foreground font-mono-tech">
              All books normalised from the strategy switch. Buy &amp; hold is the benchmark
              that decides whether running any of this beats doing nothing.
            </p>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono-tech">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="text-left py-1.5">book</th>
                    <th className="text-left">strategy</th>
                    <th className="text-right">return</th>
                    <th className="text-right">max DD</th>
                    <th className="text-right">trades</th>
                    <th className="text-right">BTC wt</th>
                    <th className="text-right">value</th>
                  </tr>
                </thead>
                <tbody>
                  {cmp.books.map((b) => (
                    <tr key={b.venue} className="border-b border-border/40">
                      <td className="py-1.5">
                        <span style={{ color: SERIES_COLOR[b.venue] }}>&#9632;</span>{" "}
                        {b.venue}
                        {!b.isPaper && <span className="text-muted-foreground"> (real orders)</span>}
                      </td>
                      <td className="text-muted-foreground">{b.strategy}</td>
                      <td className={`text-right ${b.returnSince >= 0 ? "text-[oklch(0.82_0.22_145)]" : "text-destructive"}`}>
                        {b.returnSince >= 0 ? "+" : ""}{b.returnSince.toFixed(2)}%
                      </td>
                      <td className="text-right text-muted-foreground">{b.maxDrawdownSince.toFixed(2)}%</td>
                      <td className="text-right text-muted-foreground">{b.tradesSince}</td>
                      <td className="text-right text-muted-foreground">{(b.btcWeight * 100).toFixed(1)}%</td>
                      <td className="text-right">${b.valueNow.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-border">
                    <td className="py-1.5">
                      <span style={{ color: SERIES_COLOR["buy & hold"] }}>&#9632;</span> buy &amp; hold
                    </td>
                    <td className="text-muted-foreground">benchmark</td>
                    <td className={`text-right ${cmp.benchmark.returnSince >= 0 ? "text-[oklch(0.82_0.22_145)]" : "text-destructive"}`}>
                      {cmp.benchmark.returnSince >= 0 ? "+" : ""}{cmp.benchmark.returnSince.toFixed(2)}%
                    </td>
                    <td className="text-right text-muted-foreground">{cmp.benchmark.maxDrawdownSince.toFixed(2)}%</td>
                    <td className="text-right text-muted-foreground">0</td>
                    <td className="text-right text-muted-foreground">100%</td>
                    <td className="text-right text-muted-foreground">&mdash;</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {curveData.length > 1 && (
              <div className="mt-4" style={{ height: 260 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={curveData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.3 0.02 260)" />
                    <XAxis dataKey="time" stroke="oklch(0.6 0.02 260)" fontSize={10} minTickGap={40} />
                    <YAxis stroke="oklch(0.6 0.02 260)" fontSize={10} unit="%" />
                    <Tooltip
                      contentStyle={{ background: "oklch(0.18 0.02 260)", border: "1px solid oklch(0.3 0.02 260)", fontSize: 11 }}
                      formatter={(v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {cmp.books.map((b) => (
                      <Line key={b.venue} type="monotone" dataKey={b.venue} stroke={SERIES_COLOR[b.venue] ?? "#888"}
                            strokeWidth={2} dot={false} connectNulls />
                    ))}
                    <Line type="monotone" dataKey="buy & hold" stroke={SERIES_COLOR["buy & hold"]}
                          strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* For a book that trades once a quarter, the useful daily number is
                not its return — it is how far it is from its next trade. */}
            {cmp.allocation && cmp.mode === "static" && (
              <div className="mt-4 text-xs font-mono-tech border-t border-border pt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <div className="text-muted-foreground uppercase">BTC weight</div>
                  <div className="text-sm mt-0.5">{cmp.allocation.current.toFixed(1)}%</div>
                </div>
                <div>
                  <div className="text-muted-foreground uppercase">Target &plusmn; band</div>
                  <div className="text-sm mt-0.5">
                    {cmp.allocation.target.toFixed(0)}% &plusmn; {cmp.allocation.band.toFixed(0)}pp
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground uppercase">Sells above</div>
                  <div className="text-sm mt-0.5">
                    {cmp.allocation.sellAbovePrice
                      ? `$${cmp.allocation.sellAbovePrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                      : "\u2014"}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground uppercase">Buys below</div>
                  <div className="text-sm mt-0.5">
                    {cmp.allocation.buyBelowPrice
                      ? `$${cmp.allocation.buyBelowPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                      : "\u2014"}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
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
            <div className="text-xs font-mono-tech text-muted-foreground uppercase">
              {summary?.riskMeanNegative ? "Calmar Ratio\u2020" : "Sharpe Ratio"}
            </div>
            <div className={`font-hud text-lg mt-1 ${(() => {
              const v = summary?.riskMeanNegative ? summary?.calmarRatio : summary?.sharpeRatio;
              if (v == null) return "text-muted-foreground";
              return v >= 1 ? "text-[oklch(0.82_0.22_145)]" : v >= 0 ? "text-[oklch(0.82_0.18_195)]" : "text-destructive";
            })()}`}>
              {(() => {
                const v = summary?.riskMeanNegative ? summary?.calmarRatio : summary?.sharpeRatio;
                return v == null ? "\u2014" : v.toFixed(2);
              })()}
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
