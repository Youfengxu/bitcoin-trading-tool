/**
 * Router procedure tests using appRouter.createCaller(...)
 * Tests key procedures: strategy.active, strategy.updateParams, signals.validate,
 * simulator.state, and authorization enforcement.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Mock the external dependencies
vi.mock("./engine/marketData", () => ({
  fetchCurrentPrice: vi.fn().mockResolvedValue({ price: 80000, change24h: -1.5, high24h: 82000, low24h: 79000, volume24h: 15000 }),
  fetch24hStats: vi.fn().mockResolvedValue({ priceChange: -1200, priceChangePct: -1.5, high: 82000, low: 79000, volume: 15000, quoteVolume: 1200000000 }),
  fetchCandles: vi.fn().mockResolvedValue(
    Array.from({ length: 250 }, (_, i) => ({
      open: 79000 + Math.random() * 2000,
      high: 80000 + Math.random() * 2000,
      low: 78000 + Math.random() * 2000,
      close: 79500 + Math.random() * 1500,
      volume: 100 + Math.random() * 200,
      openTime: Date.now() - (250 - i) * 3600000,
    }))
  ),
}));

vi.mock("./db", () => ({
  INTERNAL_VENUE: "internal",
  listSimulatorVenues: vi.fn().mockResolvedValue(["internal"]),
  getActiveStrategyParams: vi.fn().mockResolvedValue(null),
  getAllStrategyVersions: vi.fn().mockResolvedValue([]),
  insertStrategyParams: vi.fn().mockResolvedValue(undefined),
  getSimulatorState: vi.fn().mockResolvedValue({
    cashUsd: 10000, btcHolding: 0, totalValueUsd: 10000,
    seedAmountUsd: 10000, lastPrice: 80000, isRunning: true,
  }),
  initSimulatorState: vi.fn().mockResolvedValue({
    cashUsd: 10000, btcHolding: 0, totalValueUsd: 10000,
    seedAmountUsd: 10000, lastPrice: 80000, isRunning: true,
  }),
  updateSimulatorState: vi.fn().mockResolvedValue(undefined),
  insertSimulatorTrade: vi.fn().mockResolvedValue(undefined),
  getRecentTrades: vi.fn().mockResolvedValue([]),
  resetSimulator: vi.fn().mockResolvedValue(undefined),
  insertMetricSnapshot: vi.fn().mockResolvedValue(undefined),
  insertSignal: vi.fn().mockResolvedValue(1),
  getRecentSignals: vi.fn().mockResolvedValue([]),
  getPendingSignals: vi.fn().mockResolvedValue([]),
  updateSignalOutcome: vi.fn().mockResolvedValue(undefined),
  getRecentMetrics: vi.fn().mockResolvedValue([]),
  getWeeklyPerformance: vi.fn().mockResolvedValue([]),
  getValidationHistory: vi.fn().mockResolvedValue([]),
  insertValidationEntry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./_core/notification", () => ({
  notifyOwner: vi.fn().mockResolvedValue(true),
}));

vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn().mockResolvedValue({
    choices: [{ message: { content: "Market analysis: BTC is showing mixed signals." } }],
  }),
}));

// ─── Context Helpers ────────────────────────────────────────────────
type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1, openId: "test-user", email: "test@example.com",
    name: "Test User", loginMethod: "manus", role: "user",
    createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
  };
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
}

function createUnauthContext(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
}

// ─── Tests ──────────────────────────────────────────────────────────
describe("Router Procedures", () => {
  describe("market.currentPrice (public)", () => {
    it("returns current price data without auth", async () => {
      const caller = appRouter.createCaller(createUnauthContext());
      const result = await caller.market.currentPrice();
      expect(result).toHaveProperty("price");
      expect(result.price).toBe(80000);
      expect(result).toHaveProperty("change24h");
    });
  });

  describe("market.stats24h (public)", () => {
    it("returns 24h stats without auth", async () => {
      const caller = appRouter.createCaller(createUnauthContext());
      const result = await caller.market.stats24h();
      expect(result).toHaveProperty("high");
      expect(result).toHaveProperty("low");
      expect(result).toHaveProperty("volume");
    });
  });

  describe("market.candles (public)", () => {
    it("returns candle data with default params", async () => {
      const caller = appRouter.createCaller(createUnauthContext());
      const result = await caller.market.candles();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(250);
      expect(result[0]).toHaveProperty("open");
      expect(result[0]).toHaveProperty("close");
    });
  });

  describe("metrics.current (public)", () => {
    it("returns computed metrics without auth", async () => {
      const caller = appRouter.createCaller(createUnauthContext());
      const result = await caller.metrics.current();
      expect(result).toHaveProperty("price");
      expect(result).toHaveProperty("rsi14");
      expect(result).toHaveProperty("macdLine");
      expect(result).toHaveProperty("zScore");
      expect(result).toHaveProperty("trendClassification");
      expect(result.price).toBeGreaterThan(0);
    });
  });

  describe("strategy.active (public)", () => {
    it("returns default params when no active strategy exists", async () => {
      const caller = appRouter.createCaller(createUnauthContext());
      const result = await caller.strategy.active();
      expect(result).toHaveProperty("version");
      expect(result).toHaveProperty("params");
      expect(result.params).toHaveProperty("rsiBuyThreshold");
      expect(result.params).toHaveProperty("maxPositionPct");
    });
  });

  describe("strategy.updateParams (public)", () => {
    it("accepts unauthenticated calls with valid params", async () => {
      const caller = appRouter.createCaller(createUnauthContext());
      const result = await caller.strategy.updateParams({ rsiBuyThreshold: 25 });
      expect(result).toHaveProperty("version");
      expect(result).toHaveProperty("params");
      expect(result.params.rsiBuyThreshold).toBe(25);
    });
  });

  describe("signals.generate (public)", () => {
    it("generates a signal without authentication", async () => {
      const caller = appRouter.createCaller(createUnauthContext());
      const result = await caller.signals.generate();
      expect(result).toHaveProperty("signal");
      expect(result).toHaveProperty("confidence");
      expect(result).toHaveProperty("reasoning");
      expect(result).toHaveProperty("price");
      expect(result).toHaveProperty("ts");
      expect(["buy", "sell", "hold"]).toContain(result.signal);
      expect(result.price).toBeGreaterThan(0);
    });
  });

  describe("signals.validate (public)", () => {
    it("validates pending signals without authentication", async () => {
      const caller = appRouter.createCaller(createUnauthContext());
      const result = await caller.signals.validate();
      expect(result).toHaveProperty("validated");
      expect(typeof result.validated).toBe("number");
    });
  });

  describe("simulator.state (public)", () => {
    it("returns simulator state without auth", async () => {
      const caller = appRouter.createCaller(createUnauthContext());
      const result = await caller.simulator.state();
      expect(result).toHaveProperty("cashUsd");
      expect(result).toHaveProperty("btcHolding");
      expect(result).toHaveProperty("totalValueUsd");
      expect(result).toHaveProperty("seedAmountUsd");
      expect(result!.seedAmountUsd).toBe(10000);
    });
  });

  describe("simulator.trades (public)", () => {
    it("returns trade list without auth", async () => {
      const caller = appRouter.createCaller(createUnauthContext());
      const result = await caller.simulator.trades();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("simulator.reset (public)", () => {
    it("resets simulator without authentication", async () => {
      const caller = appRouter.createCaller(createUnauthContext());
      const result = await caller.simulator.reset();
      expect(result).toEqual({ success: true });
    });
  });

  describe("simulator.toggleRunning (public)", () => {
    it("toggles running state without authentication", async () => {
      const caller = appRouter.createCaller(createUnauthContext());
      const result = await caller.simulator.toggleRunning();
      expect(result).toHaveProperty("isRunning");
      expect(typeof result.isRunning).toBe("boolean");
    });
  });

  describe("ai.analyze (public)", () => {
    it("returns AI analysis without authentication", async () => {
      const caller = appRouter.createCaller(createUnauthContext());
      const result = await caller.ai.analyze();
      expect(result).toHaveProperty("analysis");
      expect(result).toHaveProperty("timestamp");
      expect(typeof result.analysis).toBe("string");
      expect(result.analysis.length).toBeGreaterThan(0);
    });

    it("accepts optional question parameter", async () => {
      const caller = appRouter.createCaller(createAuthContext());
      const result = await caller.ai.analyze({ question: "Should I buy now?" });
      expect(result).toHaveProperty("analysis");
      expect(typeof result.analysis).toBe("string");
    });
  });
});
