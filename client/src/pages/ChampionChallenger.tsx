import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, FlaskConical, TrendingUp, TrendingDown, Crown } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from "recharts";
import { useMemo } from "react";

type VariantName = "aggressive" | "conservative";

function formatPct(n: number, digits = 3): string {
  return `${(n * 100).toFixed(digits)}%`;
}

function formatNumber(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function formatPValue(p: number): string {
  if (p < 0.0001) return "<0.0001";
  if (p < 0.001) return p.toExponential(2);
  return p.toFixed(4);
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export default function ChampionChallenger() {
  const { data, isLoading } = trpc.championChallenger.status.useQuery(undefined, {
    refetchInterval: 30000,
  });

  const chartData = useMemo(() => {
    if (!data?.rewardSeries) return [];
    return data.rewardSeries.map((p) => ({
      time: new Date(p.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
      champion: Number((p.champion * 100).toFixed(4)),
      aggressive: Number((p.aggressive * 100).toFixed(4)),
      conservative: Number((p.conservative * 100).toFixed(4)),
    }));
  }, [data]);

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const variants: VariantName[] = ["aggressive", "conservative"];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="font-hud text-2xl font-bold tracking-wider neon-glow-cyan text-[oklch(0.82_0.18_195)]">
          CHAMPION-CHALLENGER
        </h1>
        <p className="text-muted-foreground text-sm mt-1 font-mono-tech">
          Shadow strategies running alongside champion · Paired t-test promotion gate
          (n ≥ {data.thresholds.minN}, p &lt; {data.thresholds.pValue}, mean diff &gt; 0)
        </p>
      </div>

      {/* Champion card */}
      <Card className="hud-panel relative hud-corner border-border">
        <CardHeader className="pb-3">
          <CardTitle className="font-hud text-sm tracking-wider text-[oklch(0.82_0.18_195)] flex items-center gap-2">
            <Crown className="h-4 w-4" /> ACTIVE CHAMPION · v{data.champion.version}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm font-mono-tech">
            <div>
              <div className="text-muted-foreground uppercase tracking-wider text-xs">Active for</div>
              <div className="font-hud text-lg text-primary">{formatDuration(data.champion.ageMs)}</div>
            </div>
            <div>
              <div className="text-muted-foreground uppercase tracking-wider text-xs">Signals emitted</div>
              <div className="font-hud text-lg">{data.champion.aggregates.totalSignals}</div>
            </div>
            <div>
              <div className="text-muted-foreground uppercase tracking-wider text-xs">Win rate (acted)</div>
              <div className="font-hud text-lg">
                {data.champion.aggregates.actedWinRate != null
                  ? `${(data.champion.aggregates.actedWinRate * 100).toFixed(1)}%`
                  : "—"}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground uppercase tracking-wider text-xs">Cumulative reward</div>
              <div className={`font-hud text-lg ${data.champion.aggregates.cumulativeReward >= 0 ? "text-[oklch(0.82_0.22_145)]" : "text-destructive"}`}>
                {formatPct(data.champion.aggregates.cumulativeReward)}
              </div>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs font-mono-tech text-muted-foreground">
            <div>minConfidence: <span className="text-foreground">{data.champion.params.minConfidence.toFixed(3)}</span></div>
            <div>zScoreTrend: <span className="text-foreground">{data.champion.params.zScoreTrendThreshold.toFixed(2)}</span></div>
            <div>rsiBuy/Sell: <span className="text-foreground">{data.champion.params.rsiBuyThreshold.toFixed(0)}/{data.champion.params.rsiSellThreshold.toFixed(0)}</span></div>
            <div>maxPosition: <span className="text-foreground">{(data.champion.params.maxPositionPct * 100).toFixed(0)}%</span></div>
          </div>
        </CardContent>
      </Card>

      {/* Variant comparison cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {variants.map((v) => {
          const variant = data[v];
          const test = variant.test;
          const agg = variant.aggregates;
          const isAggressive = v === "aggressive";
          const derived = isAggressive
            ? data.champion.aggressiveDerivedParams
            : data.champion.conservativeDerivedParams;
          const VariantIcon = isAggressive ? TrendingUp : TrendingDown;
          const variantColor = isAggressive ? "oklch(0.72 0.25 350)" : "oklch(0.82 0.18 85)";

          return (
            <Card key={v} className="hud-panel relative hud-corner border-border">
              <CardHeader className="pb-3">
                <CardTitle className="font-hud text-sm tracking-wider flex items-center gap-2 uppercase" style={{ color: variantColor }}>
                  <VariantIcon className="h-4 w-4" /> {v} challenger
                  {test.shouldPromote ? (
                    <Badge className="ml-auto bg-[oklch(0.82_0.22_145)] text-black font-mono-tech text-xs">PROMOTE</Badge>
                  ) : (
                    <Badge variant="outline" className="ml-auto font-mono-tech text-xs text-muted-foreground border-border">
                      {test.n}/{data.thresholds.minN} pairs
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Test statistics */}
                <div className="grid grid-cols-2 gap-3 text-sm font-mono-tech">
                  <div>
                    <div className="text-muted-foreground uppercase tracking-wider text-xs">Mean diff</div>
                    <div className={`font-hud text-base ${test.meanDiff > 0 ? "text-[oklch(0.82_0.22_145)]" : "text-destructive"}`}>
                      {formatPct(test.meanDiff, 4)}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground uppercase tracking-wider text-xs">p-value (one-tailed)</div>
                    <div className={`font-hud text-base ${test.p < data.thresholds.pValue ? "text-[oklch(0.82_0.22_145)]" : "text-foreground"}`}>
                      {formatPValue(test.p)}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground uppercase tracking-wider text-xs">t-statistic</div>
                    <div className="font-hud text-base">{formatNumber(test.t)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground uppercase tracking-wider text-xs">Paired n</div>
                    <div className="font-hud text-base">{test.n}</div>
                  </div>
                </div>

                <div className="text-xs font-mono-tech text-muted-foreground border-l-2 border-border pl-2">
                  {test.reason}
                </div>

                {/* Variant aggregates */}
                <div className="grid grid-cols-3 gap-3 text-xs font-mono-tech border-t border-border pt-3">
                  <div>
                    <div className="text-muted-foreground uppercase tracking-wider">Signals</div>
                    <div className="font-hud text-sm">{agg.totalSignals}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground uppercase tracking-wider">Cum reward</div>
                    <div className={`font-hud text-sm ${agg.cumulativeReward >= 0 ? "text-[oklch(0.82_0.22_145)]" : "text-destructive"}`}>
                      {formatPct(agg.cumulativeReward)}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground uppercase tracking-wider">Win rate</div>
                    <div className="font-hud text-sm">
                      {agg.actedWinRate != null ? `${(agg.actedWinRate * 100).toFixed(1)}%` : "—"}
                    </div>
                  </div>
                </div>

                {/* Signal distribution */}
                <div className="text-xs font-mono-tech">
                  <div className="text-muted-foreground uppercase tracking-wider mb-1">Signal distribution</div>
                  <div className="flex gap-2">
                    <span className="text-[oklch(0.82_0.22_145)]">buy {agg.counts.buy}</span>
                    <span className="text-destructive">sell {agg.counts.sell}</span>
                    <span className="text-muted-foreground">hold {agg.counts.hold}</span>
                    <span className="text-[oklch(0.82_0.22_145)] ml-auto">✓{agg.holdCorrect}</span>
                    <span className="text-destructive">✗{agg.holdMissed}</span>
                  </div>
                </div>

                {/* Derived params (just the deltas vs champion) */}
                <div className="text-xs font-mono-tech text-muted-foreground border-t border-border pt-3">
                  <div className="uppercase tracking-wider mb-1">Derived params</div>
                  <div>minConf <span className="text-foreground">{derived.minConfidence.toFixed(3)}</span> · zTrend <span className="text-foreground">{derived.zScoreTrendThreshold.toFixed(2)}</span></div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Cumulative reward chart */}
      <Card className="hud-panel relative hud-corner border-border">
        <CardHeader>
          <CardTitle className="font-hud text-sm tracking-wider text-[oklch(0.82_0.18_195)] flex items-center gap-2">
            <FlaskConical className="h-4 w-4" /> CUMULATIVE REWARD · CHAMPION VS CHALLENGERS
          </CardTitle>
        </CardHeader>
        <CardContent>
          {chartData.length < 2 ? (
            <div className="flex items-center justify-center h-[300px] text-muted-foreground font-mono-tech text-sm">
              Need ≥ 2 paired observations to plot. Currently: {chartData.length}.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.03 280)" />
                <XAxis
                  dataKey="time"
                  tick={{ fill: "oklch(0.6 0.02 280)", fontSize: 10, fontFamily: "Share Tech Mono" }}
                  stroke="oklch(0.25 0.03 280)"
                />
                <YAxis
                  tick={{ fill: "oklch(0.6 0.02 280)", fontSize: 10, fontFamily: "Share Tech Mono" }}
                  stroke="oklch(0.25 0.03 280)"
                  tickFormatter={(v) => `${v}%`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "oklch(0.12 0.015 280)",
                    border: "1px solid oklch(0.82 0.18 195 / 40%)",
                    borderRadius: "8px",
                    fontFamily: "Share Tech Mono",
                    color: "oklch(0.92 0.01 280)",
                  }}
                  formatter={(value: number) => `${value.toFixed(4)}%`}
                />
                <Legend wrapperStyle={{ fontFamily: "Share Tech Mono", fontSize: 12 }} />
                <Line type="monotone" dataKey="champion" stroke="oklch(0.82 0.18 195)" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="aggressive" stroke="oklch(0.72 0.25 350)" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="conservative" stroke="oklch(0.82 0.18 85)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Promotion history */}
      <Card className="hud-panel relative hud-corner border-border">
        <CardHeader>
          <CardTitle className="font-hud text-sm tracking-wider text-[oklch(0.82_0.18_195)]">
            PROMOTION HISTORY
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.promotionHistory.length === 0 ? (
            <div className="text-sm font-mono-tech text-muted-foreground">
              No automatic promotions yet. The current champion was set manually or by the walk-forward optimizer.
            </div>
          ) : (
            <div className="space-y-2">
              {data.promotionHistory.map((p) => (
                <div key={p.version} className="border-l-2 border-primary/40 pl-3 py-1 text-xs font-mono-tech">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="font-mono-tech text-xs border-primary/40 text-primary">v{p.version}</Badge>
                    <span className="text-muted-foreground">{new Date(p.ts).toLocaleString()}</span>
                  </div>
                  <div className="text-foreground mt-1">{p.notes}</div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
