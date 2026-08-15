import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Play, Pause, RotateCcw, Wallet, ArrowUpCircle, ArrowDownCircle } from "lucide-react";
import { toast } from "sonner";

export default function Simulator() {
  // Which book to show. `internal` is the paper ledger; `okx-demo` / `okx-live`
  // are the real venues. Books only appear once they exist.
  const [venue, setVenue] = useState("internal");
  const [inSgd, setInSgd] = useState(false);

  const { data: venues } = trpc.simulator.venues.useQuery(undefined, { refetchInterval: 60000 });
  const { data: venueStatus } = trpc.simulator.venueStatus.useQuery(undefined, { refetchInterval: 30000 });
  const { data: sgd } = trpc.simulator.sgdRate.useQuery(undefined, { refetchInterval: 300000 });

  const { data: state, isLoading, refetch } = trpc.simulator.state.useQuery({ venue }, { refetchInterval: 15000 });
  const { data: trades, refetch: refetchTrades } = trpc.simulator.trades.useQuery({ limit: 50, venue }, { refetchInterval: 30000 });

  // Display conversion. Falls back to USD when the rate is unavailable rather
  // than showing USD figures labelled SGD.
  const rate = sgd?.rate ?? null;
  const showSgd = inSgd && rate !== null;
  const cur = (n: number | null | undefined) =>
    n == null ? "—"
      : (showSgd ? n * (rate as number) : n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sym = showSgd ? "S$" : "$";
  const toggleMutation = trpc.simulator.toggleRunning.useMutation({
    onSuccess: (data) => {
      toast.success(data.isRunning ? "Simulator started" : "Simulator paused");
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });
  const resetMutation = trpc.simulator.reset.useMutation({
    onSuccess: () => {
      toast.success("Simulator reset to $10,000");
      refetch();
      refetchTrades();
    },
    onError: (err) => toast.error(err.message),
  });

  const totalReturn = state ? ((state.totalValueUsd - state.seedAmountUsd) / state.seedAmountUsd) * 100 : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-hud text-2xl font-bold tracking-wider neon-glow-cyan text-[oklch(0.82_0.18_195)]">
            SIMULATOR
          </h1>
          <p className="text-muted-foreground text-sm mt-1 font-mono-tech">
            {venue === "internal" ? "Paper ledger \u00b7 analysis baseline" : `${venue} \u00b7 real orders`}
            {venueStatus && venueStatus.requested !== venueStatus.active && (
              <span className="text-destructive"> &middot; {venueStatus.requested} did not take effect</span>
            )}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <select
            value={venue}
            onChange={(e) => setVenue(e.target.value)}
            className="bg-background border border-border rounded px-2 py-1.5 text-xs font-mono-tech"
            aria-label="Book"
          >
            {(venues ?? ["internal"]).map((v: string) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
          <Button
            onClick={() => setInSgd((v) => !v)}
            variant="outline"
            disabled={rate === null}
            title={rate === null ? "USDT-SGD rate unavailable" : `1 USDT = ${rate} SGD`}
            className="font-mono-tech text-xs"
          >
            {showSgd ? "SGD" : "USD"}
          </Button>
          <Button
            onClick={() => toggleMutation.mutate({ venue })}
            disabled={toggleMutation.isPending}
            className={`font-mono-tech text-xs ${state?.isRunning ? "bg-[oklch(0.82_0.18_85)] hover:bg-[oklch(0.82_0.18_85)]/80" : "bg-[oklch(0.82_0.22_145)] hover:bg-[oklch(0.82_0.22_145)]/80"}`}
          >
            {state?.isRunning ? <Pause className="h-4 w-4 mr-1" /> : <Play className="h-4 w-4 mr-1" />}
            {state?.isRunning ? "Pause" : "Start"}
          </Button>
          <Button
            onClick={() => resetMutation.mutate({ venue })}
            disabled={resetMutation.isPending}
            variant="outline"
            className="font-mono-tech text-xs text-destructive border-destructive/30 hover:bg-destructive/10"
          >
            <RotateCcw className="h-4 w-4 mr-1" />
            Reset
          </Button>
        </div>
      </div>

      {/* Portfolio Overview */}
      {isLoading ? (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="hud-panel relative hud-corner border-border md:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-mono-tech text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                <Wallet className="h-4 w-4" />
                Portfolio Value
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="font-hud text-3xl font-bold neon-glow-pink text-primary">
                {sym}{cur(state?.totalValueUsd)}
              </div>
              <div className={`font-mono-tech text-sm mt-1 ${totalReturn >= 0 ? "text-[oklch(0.82_0.22_145)]" : "text-destructive"}`}>
                {totalReturn >= 0 ? "+" : ""}{totalReturn.toFixed(2)}% from seed
              </div>
            </CardContent>
          </Card>

          <Card className="hud-panel border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-mono-tech text-muted-foreground uppercase tracking-wider">
                Cash ({showSgd ? "SGD" : "USD"})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="font-hud text-xl text-[oklch(0.82_0.22_145)]">
                {sym}{cur(state?.cashUsd)}
              </div>
            </CardContent>
          </Card>

          <Card className="hud-panel border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-mono-tech text-muted-foreground uppercase tracking-wider">
                BTC Holdings
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="font-hud text-xl text-[oklch(0.82_0.18_85)]">
                {state?.btcHolding?.toFixed(6) ?? "0.000000"}
              </div>
              {state?.lastPrice && (
                <div className="text-xs font-mono-tech text-muted-foreground mt-1">
                  ≈ {sym}{cur((state.btcHolding ?? 0) * state.lastPrice)}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Status */}
      <div className="flex items-center gap-3">
        <Badge className={`font-mono-tech ${state?.isRunning ? "bg-[oklch(0.82_0.22_145)]/20 text-[oklch(0.82_0.22_145)] border-[oklch(0.82_0.22_145)]/30" : "bg-muted text-muted-foreground"}`}>
          {state?.isRunning ? "RUNNING" : "PAUSED"}
        </Badge>
        <span className="text-xs font-mono-tech text-muted-foreground">
          Seed: ${state?.seedAmountUsd?.toLocaleString() ?? "10,000"} &middot;
          Started: {state?.createdAt ? new Date(state.createdAt).toLocaleDateString() : "—"}
        </span>
      </div>

      {/* Trade History */}
      <Card className="hud-panel relative hud-corner border-border">
        <CardHeader>
          <CardTitle className="font-hud text-sm tracking-wider text-[oklch(0.82_0.18_195)]">
            TRADE HISTORY
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!trades || trades.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground font-mono-tech">
              No trades executed yet. Start the simulator and generate signals.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm font-mono-tech">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                    <th className="text-left py-2 px-2">Time</th>
                    <th className="text-left py-2 px-2">Action</th>
                    <th className="text-right py-2 px-2">Price</th>
                    <th className="text-right py-2 px-2">BTC Amount</th>
                    <th className="text-right py-2 px-2">USD Value</th>
                    <th className="text-right py-2 px-2">Portfolio After</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={t.id} className="border-b border-border/50 hover:bg-accent/20">
                      <td className="py-2 px-2 text-xs text-muted-foreground">
                        {new Date(t.ts).toLocaleString()}
                      </td>
                      <td className="py-2 px-2">
                        <div className="flex items-center gap-1">
                          {t.action === "buy" ? (
                            <ArrowUpCircle className="h-3.5 w-3.5 text-[oklch(0.82_0.22_145)]" />
                          ) : (
                            <ArrowDownCircle className="h-3.5 w-3.5 text-destructive" />
                          )}
                          <span className={t.action === "buy" ? "text-[oklch(0.82_0.22_145)]" : "text-destructive"}>
                            {t.action.toUpperCase()}
                          </span>
                        </div>
                      </td>
                      <td className="py-2 px-2 text-right">${t.price.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                      <td className="py-2 px-2 text-right">{t.btcAmount.toFixed(6)}</td>
                      <td className="py-2 px-2 text-right">${t.usdValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                      <td className="py-2 px-2 text-right text-primary">${t.totalValueAfter.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
