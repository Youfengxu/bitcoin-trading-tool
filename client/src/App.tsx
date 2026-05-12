import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import DashboardLayout from "./components/DashboardLayout";
import LivePrice from "./pages/LivePrice";
import Metrics from "./pages/Metrics";
import Signals from "./pages/Signals";
import Simulator from "./pages/Simulator";
import Performance from "./pages/Performance";
import Strategy from "./pages/Strategy";
import {
  Activity,
  BarChart3,
  Zap,
  Wallet,
  TrendingUp,
  Settings2,
} from "lucide-react";

const navItems = [
  { label: "Live Price", href: "/", icon: Activity },
  { label: "Metrics", href: "/metrics", icon: BarChart3 },
  { label: "Signals", href: "/signals", icon: Zap },
  { label: "Simulator", href: "/simulator", icon: Wallet },
  { label: "Performance", href: "/performance", icon: TrendingUp },
  { label: "Strategy", href: "/strategy", icon: Settings2 },
];

function Router() {
  return (
    <DashboardLayout>
      <Switch>
        <Route path="/" component={LivePrice} />
        <Route path="/metrics" component={Metrics} />
        <Route path="/signals" component={Signals} />
        <Route path="/simulator" component={Simulator} />
        <Route path="/performance" component={Performance} />
        <Route path="/strategy" component={Strategy} />
        <Route path="/404" component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </DashboardLayout>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
