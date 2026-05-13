import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Cpu, Save, Brain, MessageSquare, Clock, Info, Zap, ZapOff } from "lucide-react";
import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { Streamdown } from "streamdown";
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const SCHEDULE_OPTIONS = [
  { minutes: 0,   label: "OFF",   description: "Automation disabled — manual only" },
  { minutes: 5,   label: "5 min", description: "Very high frequency — reactive, noisy" },
  { minutes: 15,  label: "15 min",description: "High frequency — suitable for 1M–15M candles" },
  { minutes: 30,  label: "30 min",description: "Medium frequency" },
  { minutes: 60,  label: "1 hr",  description: "Default — balanced for 1H candles" },
  { minutes: 240, label: "4 hr",  description: "Low frequency — suitable for 4H candles" },
  { minutes: 720, label: "12 hr", description: "Macro — suitable for 1D candles" },
];

const INTERVAL_LABELS: Record<string, string> = {
  "5m": "5M", "15m": "15M", "30m": "30M", "1h": "1H", "4h": "4H", "1d": "1D",
};

export default function Strategy() {
  const utils = trpc.useUtils();
  const { data: active, isLoading, refetch } = trpc.strategy.active.useQuery(undefined, { refetchInterval: 60000 });
  const { data: versions } = trpc.strategy.versions.useQuery();

  const [params, setParams] = useState<Record<string, number>>({});
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiResponse, setAiResponse] = useState<string | null>(null);
  const [scheduleSaving, setScheduleSaving] = useState(false);

  useEffect(() => {
    if (active?.params) {
      setParams(active.params as unknown as Record<string, number>);
    }
  }, [active]);

  const currentScheduleMinutes = active?.heartbeatScheduleMinutes ?? 60;
  const currentInterval = active?.candleInterval ?? "1h";

  const optimizeMutation = trpc.strategy.optimize.useMutation({
    onSuccess: (data) => {
      toast.success(`Optimized! v${data.version}: Weekly return ${data.weeklyReturn.toFixed(2)}%, Win rate ${data.winRate.toFixed(1)}%`);
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const updateMutation = trpc.strategy.updateParams.useMutation({
    onSuccess: (data) => {
      toast.success(`Parameters saved as v${data.version}`);
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const updateSettings = trpc.strategy.updateSettings.useMutation({
    onSuccess: (data) => {
      utils.strategy.active.invalidate();
      const opt = SCHEDULE_OPTIONS.find((o) => o.minutes === data.heartbeatScheduleMinutes);

      // If the platform cron update failed, show a warning instead of a plain success
      if (data.cronUpdateWarning) {
        toast.warning("Schedule saved locally", {
          description: data.cronUpdateWarning,
          duration: 8000,
        });
      } else if (data.heartbeatScheduleMinutes === 0) {
        toast.success("Automation turned OFF", {
          description: "The signal engine will only run when you press Generate Signal manually.",
          duration: 5000,
        });
      } else {
        const nextStr = data.nextExecutionAt
          ? ` · Next run: ${new Date(data.nextExecutionAt).toLocaleTimeString()}`
          : "";
        toast.success(`Heartbeat schedule set to ${opt?.label ?? data.heartbeatScheduleMinutes + " min"}`, {
          description: `Platform cron updated.${nextStr} Signal frequency is independent of the candle interval.`,
          duration: 6000,
        });
      }
      setScheduleSaving(false);
    },
    onError: (err) => {
      toast.error("Failed to save schedule: " + err.message);
      setScheduleSaving(false);
    },
  });

  const aiMutation = trpc.ai.analyze.useMutation({
    onSuccess: (data) => setAiResponse(data.analysis),
    onError: (err) => toast.error(err.message),
  });

  const handleScheduleChange = (minutes: number) => {
    if (minutes === currentScheduleMinutes || scheduleSaving) return;
    setScheduleSaving(true);
    // Pass the session cookie so the server can call updateHeartbeatJob on the platform
    const sessionToken = document.cookie
      .split("; ")
      .find((row) => row.startsWith("app_session_id="))
      ?.split("=")[1] ?? "";
    updateSettings.mutate({ heartbeatScheduleMinutes: minutes, sessionToken });
  };

  const paramFields = useMemo(() => [
    { key: "rsiBuyThreshold", label: "RSI Buy Threshold", min: 10, max: 50, step: 1 },
    { key: "rsiSellThreshold", label: "RSI Sell Threshold", min: 50, max: 90, step: 1 },
    { key: "macdBuyThreshold", label: "MACD Buy Threshold", min: -500, max: 0, step: 10 },
    { key: "macdSellThreshold", label: "MACD Sell Threshold", min: 0, max: 500, step: 10 },
    { key: "bbBuyDeviation", label: "BB Buy Deviation", min: -3, max: 0, step: 0.1 },
    { key: "bbSellDeviation", label: "BB Sell Deviation", min: 0, max: 3, step: 0.1 },
    { key: "zScoreTrendThreshold", label: "Z-Score Trend Threshold", min: 1, max: 4, step: 0.1 },
    { key: "zScoreBlipThreshold", label: "Z-Score Blip Threshold", min: 0.1, max: 2, step: 0.1 },
    { key: "volumeRatioThreshold", label: "Volume Ratio Threshold", min: 0.5, max: 3, step: 0.1 },
    { key: "emaCrossoverWeight", label: "EMA Crossover Weight", min: 0, max: 2, step: 0.1 },
    { key: "maxPositionPct", label: "Max Position %", min: 0.1, max: 1, step: 0.05 },
    { key: "minConfidence", label: "Min Confidence", min: 0.1, max: 0.9, step: 0.05 },
  ], []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="font-hud text-2xl font-bold tracking-wider neon-glow-cyan text-[oklch(0.82_0.18_195)]">
            STRATEGY
          </h1>
          <p className="text-muted-foreground text-sm mt-1 font-mono-tech">
            Parameter tuning &middot; Walk-forward optimization &middot; Automation
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => optimizeMutation.mutate()}
            disabled={optimizeMutation.isPending}
            className="font-mono-tech text-xs bg-primary hover:bg-primary/80"
          >
            {optimizeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Cpu className="h-4 w-4 mr-1" />}
            Run Optimization
          </Button>
          <Button
            onClick={() => updateMutation.mutate(params as any)}
            disabled={updateMutation.isPending}
            variant="outline"
            className="font-mono-tech text-xs"
          >
            {updateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
            Save Params
          </Button>
        </div>
      </div>

      {/* Active Version */}
      <div className="flex items-center gap-3">
        <Badge className="bg-primary/20 text-primary border-primary/30 font-mono-tech">
          v{active?.version ?? 0}
        </Badge>
        <span className="text-xs font-mono-tech text-muted-foreground">
          {active?.isActive ? "Active" : "Default parameters"}
        </span>
        <span className="text-xs font-mono-tech text-muted-foreground">
          &middot; Signal Interval: <span className="text-[oklch(0.82_0.18_195)]">{INTERVAL_LABELS[currentInterval] ?? currentInterval}</span>
          &nbsp;(change on Live Price page)
        </span>
      </div>

      {/* ── Automation Section ──────────────────────────────────────────── */}
      <Card className="hud-panel relative hud-corner border-border">
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle className="font-hud text-sm tracking-wider text-[oklch(0.82_0.18_195)]">
              AUTOMATION
            </CardTitle>
            <UITooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent
                side="right"
                className="max-w-[300px] text-xs font-mono-tech bg-card border-border text-foreground"
              >
                <p className="font-semibold text-[oklch(0.82_0.18_195)] mb-1">Heartbeat Schedule</p>
                <p>
                  Controls how often the signal engine fires automatically — fetching the latest
                  candles, computing metrics, generating a signal, and executing a simulator trade
                  if the signal is BUY or SELL.
                </p>
                <p className="mt-1.5 text-muted-foreground">
                  This is independent of the Signal Interval (candle timeframe). You can run a 15M
                  candle strategy every 15 minutes, or a 1H candle strategy every hour.
                </p>
                <p className="mt-1.5 border-t border-border pt-1.5 text-[oklch(0.82_0.22_145)]">
                  Tip: Match the schedule to the candle interval for best results. E.g. 1H candles
                  → 1 hr schedule.
                </p>
              </TooltipContent>
            </UITooltip>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label className="text-xs font-mono-tech text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              Heartbeat Schedule
              <span className="text-muted-foreground font-normal normal-case tracking-normal">
                — how often the signal engine runs automatically
              </span>
            </Label>
            <div className="flex flex-wrap gap-2">
              {SCHEDULE_OPTIONS.map((opt) => {
                const isActive = currentScheduleMinutes === opt.minutes;
                const isOff = opt.minutes === 0;
                return (
                  <UITooltip key={opt.minutes}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => handleScheduleChange(opt.minutes)}
                        disabled={scheduleSaving}
                        className={`px-4 py-2 text-xs font-mono-tech rounded border transition-all flex items-center gap-1.5 disabled:opacity-50 ${
                          isActive
                            ? isOff
                              ? "border-destructive bg-destructive/10 text-destructive"
                              : "border-[oklch(0.82_0.22_145)] bg-[oklch(0.82_0.22_145)]/10 text-[oklch(0.82_0.22_145)]"
                            : "border-border text-muted-foreground hover:border-primary/50"
                        }`}
                      >
                        {scheduleSaving && isActive ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : isOff ? (
                          <ZapOff className="h-3 w-3" />
                        ) : (
                          <Zap className="h-3 w-3" />
                        )}
                        {opt.label}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent
                      side="bottom"
                      className="text-xs font-mono-tech bg-card border-border text-foreground"
                    >
                      {opt.description}
                    </TooltipContent>
                  </UITooltip>
                );
              })}
            </div>
          </div>

          {/* Status summary */}
          <div className={`rounded-lg border px-4 py-3 text-xs font-mono-tech flex items-start gap-3 ${
            currentScheduleMinutes === 0
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-[oklch(0.82_0.22_145)]/30 bg-[oklch(0.82_0.22_145)]/5 text-[oklch(0.82_0.22_145)]"
          }`}>
            {currentScheduleMinutes === 0 ? (
              <ZapOff className="h-4 w-4 mt-0.5 shrink-0" />
            ) : (
              <Zap className="h-4 w-4 mt-0.5 shrink-0" />
            )}
            <div>
              {currentScheduleMinutes === 0 ? (
                <>
                  <p className="font-semibold">Automation is OFF</p>
                  <p className="text-muted-foreground mt-0.5">
                    The signal engine will only run when you press the Generate Signal button manually.
                    No automatic trades will be executed.
                  </p>
                </>
              ) : (
                <>
                  <p className="font-semibold">
                    Running every {SCHEDULE_OPTIONS.find((o) => o.minutes === currentScheduleMinutes)?.label ?? currentScheduleMinutes + " min"}
                    {" "}on {INTERVAL_LABELS[currentInterval] ?? currentInterval} candles
                  </p>
                  <p className="text-muted-foreground mt-0.5">
                    Each run fetches the latest {INTERVAL_LABELS[currentInterval] ?? currentInterval} candles, computes all metrics, and generates a
                    signal. BUY/SELL signals execute a simulator trade and send a Telegram notification.
                    HOLD signals are logged but do not trade.
                  </p>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Parameter Grid */}
      <Card className="hud-panel relative hud-corner border-border">
        <CardHeader>
          <CardTitle className="font-hud text-sm tracking-wider text-[oklch(0.82_0.18_195)]">
            STRATEGY PARAMETERS
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {paramFields.map((field) => (
              <div key={field.key} className="space-y-2">
                <Label className="text-xs font-mono-tech text-muted-foreground uppercase tracking-wider">
                  {field.label}
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    value={params[field.key] ?? ""}
                    onChange={(e) => setParams({ ...params, [field.key]: parseFloat(e.target.value) || 0 })}
                    className="font-mono-tech text-sm bg-background border-border"
                  />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Version History */}
      <Card className="hud-panel relative hud-corner border-border">
        <CardHeader>
          <CardTitle className="font-hud text-sm tracking-wider text-[oklch(0.82_0.18_195)]">
            VERSION HISTORY
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!versions || versions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground font-mono-tech">
              No versions yet. Run optimization or save parameters to create the first version.
            </div>
          ) : (
            <div className="space-y-2">
              {versions.map((v) => (
                <div key={v.id} className="border border-border rounded-lg p-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Badge variant={v.isActive ? "default" : "outline"} className="font-mono-tech text-xs">
                      v{v.version}
                    </Badge>
                    <span className="text-xs font-mono-tech text-muted-foreground">
                      {new Date(v.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-xs font-mono-tech">
                    {v.backtestReturnPct !== null && (
                      <span className={`${v.backtestReturnPct >= 0 ? "text-[oklch(0.82_0.22_145)]" : "text-destructive"}`}>
                        Return: {v.backtestReturnPct.toFixed(2)}%
                      </span>
                    )}
                    {v.backtestSharpe !== null && (
                      <span className="text-[oklch(0.82_0.18_195)]">Sharpe: {v.backtestSharpe.toFixed(2)}</span>
                    )}
                    {v.backtestWinRate !== null && (
                      <span className="text-[oklch(0.82_0.18_85)]">Win: {v.backtestWinRate.toFixed(1)}%</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* AI Strategy Assistant */}
      <Card className="hud-panel relative hud-corner border-border">
        <CardHeader>
          <CardTitle className="font-hud text-sm tracking-wider text-[oklch(0.72_0.25_350)]">
            AI STRATEGY ASSISTANT
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="Ask about strategy, market conditions, parameter tuning..."
              value={aiQuestion}
              onChange={(e) => setAiQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && aiQuestion.trim()) {
                  aiMutation.mutate({ question: aiQuestion });
                }
              }}
              className="font-mono-tech text-sm bg-background border-border"
            />
            <Button
              onClick={() => aiQuestion.trim() && aiMutation.mutate({ question: aiQuestion })}
              disabled={aiMutation.isPending || !aiQuestion.trim()}
              className="font-mono-tech text-xs bg-primary hover:bg-primary/80"
            >
              {aiMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />}
            </Button>
          </div>
          {aiResponse && (
            <div className="prose prose-invert prose-sm max-w-none font-mono-tech border-t border-border pt-4">
              <Streamdown>{aiResponse}</Streamdown>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
