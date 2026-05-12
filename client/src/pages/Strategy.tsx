import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Cpu, Save, Brain, MessageSquare } from "lucide-react";
import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { Streamdown } from "streamdown";

export default function Strategy() {
  const { data: active, isLoading, refetch } = trpc.strategy.active.useQuery(undefined, { refetchInterval: 60000 });
  const { data: versions } = trpc.strategy.versions.useQuery();

  const [params, setParams] = useState<Record<string, number>>({});
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiResponse, setAiResponse] = useState<string | null>(null);

  useEffect(() => {
    if (active?.params) {
      setParams(active.params as unknown as Record<string, number>);
    }
  }, [active]);

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

  const aiMutation = trpc.ai.analyze.useMutation({
    onSuccess: (data) => setAiResponse(data.analysis),
    onError: (err) => toast.error(err.message),
  });

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-hud text-2xl font-bold tracking-wider neon-glow-cyan text-[oklch(0.82_0.18_195)]">
            STRATEGY
          </h1>
          <p className="text-muted-foreground text-sm mt-1 font-mono-tech">
            Parameter tuning &middot; Walk-forward optimization
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
      </div>

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
