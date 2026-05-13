import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { handleHeartbeat } from "../heartbeatHandler";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);

  // Scheduled endpoint for heartbeat cron
  app.post("/api/scheduled/heartbeat", async (_req, res) => {
    try {
      await handleHeartbeat();
      res.json({ ok: true });
    } catch (error) {
      console.error("[Scheduled] Heartbeat error:", error);
      res.status(500).json({ error: "Heartbeat failed" });
    }
  });
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });

  startInternalScheduler();
}

// Self-hosted scheduler. Manus deployments rely on the platform cron to POST
// /api/scheduled/heartbeat; without it the signal engine never runs.
// handleHeartbeat() already gates its own work by heartbeatScheduleMinutes
// (read from the DB on each tick) and by per-task day/hour markers, so a
// uniform 1-minute tick is safe and matches Manus's minimum cron resolution.
function startInternalScheduler() {
  if (process.env.DISABLE_INTERNAL_SCHEDULER === "1") {
    console.log("[Scheduler] Disabled via DISABLE_INTERNAL_SCHEDULER=1");
    return;
  }
  const tickMs = 60_000;
  console.log(`[Scheduler] Internal heartbeat tick every ${tickMs / 1000}s`);
  setInterval(() => {
    handleHeartbeat().catch((err) => {
      console.error("[Scheduler] Heartbeat error:", err);
    });
  }, tickMs);
}

startServer().catch(console.error);
