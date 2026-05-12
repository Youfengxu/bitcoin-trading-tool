import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Zap, ArrowUpCircle, ArrowDownCircle, MinusCircle, CheckCircle, XCircle, Clock } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function Signals() {
  const { data: signals, isLoading, refetch } = trpc.signals.list.useQuery({ limit: 50 }, { refetchInterval: 30000 });
  const generateMutation = trpc.signals.generate.useMutation({
    onSuccess: (data) => {
      toast.success(`Signal generated: ${data.signal.toUpperCase()} @ $${data.price.toFixed(0)}`);
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });
  const validateMutation = trpc.signals.validate.useMutation({
    onSuccess: (data) => {
      toast.success(`Validated ${data.validated} signals`);
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const [expandedId, setExpandedId] = useState<number | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-hud text-2xl font-bold tracking-wider neon-glow-cyan text-[oklch(0.82_0.18_195)]">
            SIGNALS
          </h1>
          <p className="text-muted-foreground text-sm mt-1 font-mono-tech">
            Automated buy/sell signal log with reasoning
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
            className="font-mono-tech text-xs bg-primary hover:bg-primary/80"
          >
            {generateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Zap className="h-4 w-4 mr-1" />}
            Generate Signal
          </Button>
          <Button
            onClick={() => validateMutation.mutate()}
            disabled={validateMutation.isPending}
            variant="outline"
            className="font-mono-tech text-xs"
          >
            {validateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <CheckCircle className="h-4 w-4 mr-1" />}
            Validate
          </Button>
        </div>
      </div>

      {/* Signal Stats */}
      {signals && signals.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="hud-panel border-border">
            <CardContent className="pt-4">
              <div className="text-xs font-mono-tech text-muted-foreground uppercase">Total Signals</div>
              <div className="font-hud text-xl text-foreground mt-1">{signals.length}</div>
            </CardContent>
          </Card>
          <Card className="hud-panel border-border">
            <CardContent className="pt-4">
              <div className="text-xs font-mono-tech text-muted-foreground uppercase">Buy Signals</div>
              <div className="font-hud text-xl text-[oklch(0.82_0.22_145)] mt-1">
                {signals.filter((s) => s.signal === "buy").length}
              </div>
            </CardContent>
          </Card>
          <Card className="hud-panel border-border">
            <CardContent className="pt-4">
              <div className="text-xs font-mono-tech text-muted-foreground uppercase">Sell Signals</div>
              <div className="font-hud text-xl text-destructive mt-1">
                {signals.filter((s) => s.signal === "sell").length}
              </div>
            </CardContent>
          </Card>
          <Card className="hud-panel border-border">
            <CardContent className="pt-4">
              <div className="text-xs font-mono-tech text-muted-foreground uppercase">Win Rate</div>
              <div className="font-hud text-xl text-[oklch(0.82_0.18_195)] mt-1">
                {(() => {
                  const resolved = signals.filter((s) => s.outcome !== "pending" && s.signal !== "hold");
                  const wins = resolved.filter((s) => s.outcome === "win").length;
                  return resolved.length > 0 ? `${((wins / resolved.length) * 100).toFixed(1)}%` : "—";
                })()}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Signal Log */}
      <Card className="hud-panel relative hud-corner border-border">
        <CardHeader>
          <CardTitle className="font-hud text-sm tracking-wider text-[oklch(0.82_0.18_195)]">
            SIGNAL LOG
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center h-40">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : !signals || signals.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground font-mono-tech">
              No signals generated yet. Click "Generate Signal" to start.
            </div>
          ) : (
            <div className="space-y-2">
              {signals.map((sig) => (
                <div
                  key={sig.id}
                  className="border border-border rounded-lg p-3 hover:border-primary/30 transition-colors cursor-pointer"
                  onClick={() => setExpandedId(expandedId === sig.id ? null : sig.id)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {sig.signal === "buy" && <ArrowUpCircle className="h-5 w-5 text-[oklch(0.82_0.22_145)]" />}
                      {sig.signal === "sell" && <ArrowDownCircle className="h-5 w-5 text-destructive" />}
                      {sig.signal === "hold" && <MinusCircle className="h-5 w-5 text-muted-foreground" />}
                      <div>
                        <span className={`font-mono-tech text-sm font-semibold ${
                          sig.signal === "buy" ? "text-[oklch(0.82_0.22_145)]" :
                          sig.signal === "sell" ? "text-destructive" : "text-muted-foreground"
                        }`}>
                          {sig.signal.toUpperCase()}
                        </span>
                        <span className="text-muted-foreground font-mono-tech text-xs ml-2">
                          @ ${sig.price.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge variant="outline" className="font-mono-tech text-xs">
                        {((sig.confidence ?? 0) * 100).toFixed(0)}%
                      </Badge>
                      {sig.outcome === "win" && <CheckCircle className="h-4 w-4 text-[oklch(0.82_0.22_145)]" />}
                      {sig.outcome === "loss" && <XCircle className="h-4 w-4 text-destructive" />}
                      {sig.outcome === "pending" && <Clock className="h-4 w-4 text-muted-foreground" />}
                      <span className="text-xs font-mono-tech text-muted-foreground">
                        {new Date(sig.ts).toLocaleString()}
                      </span>
                    </div>
                  </div>
                  {expandedId === sig.id && (
                    <div className="mt-3 pt-3 border-t border-border">
                      <div className="text-xs font-mono-tech text-muted-foreground uppercase mb-2">Reasoning</div>
                      <p className="text-sm text-foreground font-mono-tech whitespace-pre-wrap leading-relaxed">
                        {sig.reasoning}
                      </p>
                      <div className="mt-2 flex gap-4 text-xs font-mono-tech text-muted-foreground">
                        {(sig as any).portfolioValue && (
                          <span>Portfolio: <span className="text-[oklch(0.82_0.18_195)]">${(sig as any).portfolioValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></span>
                        )}
                        {sig.outcomePrice && (
                          <span>Outcome price: ${sig.outcomePrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
