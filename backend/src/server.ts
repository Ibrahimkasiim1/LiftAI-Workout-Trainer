/**
 * Main Server Setup
 * 
 * Properly mounts all routes including the onboarding plan generation
 */

/** Load .env before any other imports read process.env (Gemini, Supabase auth, etc.). */
import "dotenv/config";

import cors from 'cors';
import express from 'express';

// Error tracking initializes before routes import so early failures are captured.
import { captureException, initErrorTracking } from './services/errorTracking';
initErrorTracking();

import { createCorsOptions } from './corsConfig';
import { requireAuth } from './middleware/auth';
import { requireAiBudget } from './middleware/quotaGate';

// Import routes
import chatRoutes from './routes/chat';
import checkinsRouter from './routes/checkins';
import memoriesRouter from './routes/memories';
import planGenerationRoute from './routes/generatePlan';
import missedDayRouter from "./routes/missedDay";
import nutritionRouter from "./routes/nutrition";
import nutritionPhotoRouter from "./routes/nutritionPhoto";
// import testToolsRouter from "./routes/test-tools"; // Development only
import voiceRouter from "./routes/voice";
import workoutContextRouter from "./routes/workoutContext";
import workoutSwapRouter from "./routes/workoutSwap";

// Import services
import { initLangGraph } from "./agents/langgraphRuntime";
import { initializeCleanupScheduler } from "./services/cronJobs";
import { initializeProactiveCoach } from "./services/proactiveCheckins";
import { initializePushDelivery } from "./services/pushNotifications";
import { supabase } from "./services/db";
import { runExerciseDataGuardrail } from "./services/exerciseDataGuardrail";

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors(createCorsOptions()));
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: true }));

// Health check (lightweight — used by Render's autohealth probe; must stay fast)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    service: 'liftai-backend'
  });
});

// Deep health: verifies Supabase reachability. Use this for human checks /
// status pages — keep it OFF the autohealth path so a transient Supabase
// blip doesn't kill the whole pod.
app.get('/health/deep', async (_req, res) => {
  try {
    const { error } = await supabase.from('user_profiles').select('id').limit(1);
    if (error) {
      res.status(503).json({ status: 'degraded', supabase: error.message });
      return;
    }
    res.json({ status: 'ok', supabase: 'reachable', timestamp: new Date().toISOString() });
  } catch (err: any) {
    res.status(503).json({ status: 'degraded', error: err?.message ?? 'unknown' });
  }
});

// Root route - API info
app.get('/', (req, res) => {
  res.json({
    service: 'LiftAI Backend API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: 'GET /health',
      healthDeep: 'GET /health/deep',
      planGeneration: 'POST /api/generate-plan',
      chat: 'POST /chat',
      chatStream: 'POST /chat/stream',
      nutritionLog: 'POST /nutrition/log',
      workoutContext: 'POST /api/workout-context',
      missedDay: 'POST /api/missed-day',
      voiceSession: 'POST /voice/session',
      voiceSessionEnd: 'POST /voice/session/end',
    },
    documentation: 'https://github.com/Ibrahimkasiim1/LiftAI-AI-Workout-Trainer'
  });
});


// ============================================================================
// MOUNT ROUTES
// ============================================================================

// Require a valid Supabase session for all privileged APIs (BOLA fix: never trust body userId).
app.use('/api/generate-plan', requireAuth);
app.use('/chat', requireAuth);
app.use('/nutrition', requireAuth);
app.use('/missed-day', requireAuth);
app.use('/workout-context', requireAuth);
app.use('/api/workout', requireAuth);
app.use('/voice', requireAuth);
app.use('/checkins', requireAuth);
app.use('/memories', requireAuth);

// Quota gates run AFTER requireAuth so req.user.id is set, and only on the
// AI-spending paths. /api/generate-plan is intentionally NOT gated — onboarding
// must always succeed. /api/workout/alternatives is also not gated (no AI).
// Free tier: countable allowances (3 chats/day, 1 AI meal log/day) + a $0.10
// cost backstop; premium: $0.80-per-12h soft abuse cap ('premium_cooldown').
// POST-only: DELETE /chat/thread/:id (conversation cleanup) spends no AI and
// must never consume a chat count.
app.post('/chat', requireAiBudget('chat'));
app.post('/chat/stream', requireAiBudget('chat'));
app.post('/nutrition/log', requireAiBudget('meal'));
// Photo scans share the SAME meal bucket as typed AI logs (one product
// action, one quota concept). "Fix with a note" re-analyses are free — the
// route enforces a cap of 2 per scan against its analysis session, and an
// unknown/forged analysis_id is rejected there without an LLM call, so
// skipping the gate on fix bodies is not a quota bypass.
app.post('/nutrition/log-photo', (req, res, next) => {
  if ((req.body as { fix?: unknown } | undefined)?.fix) return next();
  return requireAiBudget('meal')(req, res, next);
});
// /nutrition/log-photo/confirm is deterministic (no AI) — auth only.
// Plate-card "+ Add item" parse: no meal count (it's inside an already-paid
// scan), but cost-backstop gated so it can't become a free unlimited LLM API.
app.post('/nutrition/parse-item', requireAiBudget());
// /nutrition/log-structured (barcode) stays UNGATED beyond auth: macros come
// from Open Food Facts, no LLM runs, and unlimited free barcode logging is
// deliberate (the daily habit loop) — do not add requireAiBudget here.
app.post('/api/workout/swap-session-exercise', requireAiBudget());
// Mint-time check is cheap; the real cost is accrued post-session via
// /voice/session/end → record_ai_cost. We still gate the mint so users at
// budget can't open new sessions. Escalations are full graph turns and
// must respect the same budget.
app.post('/voice/session', requireAiBudget());
app.post('/voice/escalate', requireAiBudget());

// Onboarding route (does NOT use LangGraph agents - simple plan template creation)
app.use(planGenerationRoute);  // mounts POST /api/generate-plan

// Chat routes (uses LangGraph conversational agent)
app.use(chatRoutes);  // mounts POST /chat and POST /chat/stream

// Additional workout routes
app.use(missedDayRouter);
app.use(nutritionRouter);
app.use(nutritionPhotoRouter);
app.use(workoutContextRouter);
app.use(workoutSwapRouter);
app.use(voiceRouter);
app.use(checkinsRouter);
app.use(memoriesRouter);
// app.use(testToolsRouter); // Development only

// ============================================================================
// ERROR HANDLING
// ============================================================================

// 404 handler
app.use((req, res) => {
  console.log(`404 - Route not found: ${req.method} ${req.path}`);
  res.status(404).json({
    error: 'Route not found',
    path: req.path,
    method: req.method,
    availableRoutes: [
      'POST /api/generate-plan (onboarding)',
      'POST /chat (conversational)',
      'POST /chat/stream (streaming)',
      'POST /nutrition/log',
      'GET /health'
    ]
  });
});

// Global error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Server error:', err);
  captureException(err, { path: req.path, method: req.method });
  const isDev = process.env.NODE_ENV === 'development';
  res.status(500).json({
    error: 'Internal server error',
    ...(isDev ? { message: err.message, stack: err.stack } : { message: 'An unexpected error occurred' }),
  });
});

// ============================================================================
// START SERVER
// ============================================================================

if (require.main === module) {
  initLangGraph()
    .then(() => {
      const server = app.listen(PORT, async () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`Health check: http://localhost:${PORT}/health`);
        console.log(`Plan generation: POST http://localhost:${PORT}/api/generate-plan`);
        console.log(`Chat: POST http://localhost:${PORT}/chat`);
        console.log(`Chat stream: POST http://localhost:${PORT}/chat/stream`);

        await runExerciseDataGuardrail();
        initializeCleanupScheduler();
        initializeProactiveCoach();
        initializePushDelivery();
      });

      // Graceful shutdown: drain in-flight HTTP/SSE connections so checkpoints
      // and cost accruals can finish before the process exits. Render and most
      // PaaS hosts send SIGTERM and wait ~10s before SIGKILL.
      const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 8_000);
      let shuttingDown = false;
      const shutdown = (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`${signal} received; draining (${SHUTDOWN_GRACE_MS}ms grace)…`);
        // unref so the timer doesn't keep the event loop alive after server.close().
        // Cast: the root tsconfig includes both Node + RN libs and resolves
        // setTimeout to the DOM type which lacks .unref().
        const force = setTimeout(() => {
          console.warn("Graceful shutdown timed out, forcing exit");
          process.exit(1);
        }, SHUTDOWN_GRACE_MS) as unknown as NodeJS.Timeout;
        force.unref?.();
        server.close((err) => {
          if (err) {
            console.error("Error closing server:", err);
            process.exit(1);
          }
          console.log("Server closed cleanly");
          process.exit(0);
        });
      };
      process.on("SIGTERM", () => shutdown("SIGTERM"));
      process.on("SIGINT", () => shutdown("SIGINT"));
    })
    .catch((err) => {
      console.error("Failed to initialize LangGraph checkpointer:", err);
      process.exit(1);
    });
}

export default app;
