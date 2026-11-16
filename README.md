# LiftAI: AI Workout Trainer

A mobile fitness coach that builds a personalized training plan from a short onboarding quiz, guides you through every set, and adapts the plan as you log workouts and meals. Shipped on the App Store.

<!-- Add a screen recording here, e.g. docs/demo.gif -->
<!-- ![demo](docs/demo.gif) -->

## Features

- **Personalized plans.** A multi-step onboarding quiz (goal, schedule, equipment, injuries) produces a full weekly program filtered to the equipment you own and the injuries you report.
- **Guided workout player.** A swipeable exercise player with set logging, rest timers, a Live Activity / Dynamic Island timer on iOS, and progressive-overload targets based on your history.
- **Conversational coach.** A streaming chat coach that can answer questions, edit your plan, build one-off workouts, analyze your progress and remember preferences across sessions.
- **Nutrition tracking.** Log meals by text, barcode, or photo (vision-model calorie and macro estimates), with goals calculated from your profile.
- **Progress.** Body weight, volume and personal-record trends, plus proactive coach check-ins.

## How it works

```
Expo app (React Native)  ──HTTPS / SSE──▶  Express API (Node)  ──▶  LangGraph supervisor
        │                                        │                    ├─ planner
        │                                        │                    ├─ editor
        ▼                                        ▼                    ├─ analyst
   Supabase Auth  ◀─────────────────────▶  Supabase Postgres          └─ memory
                                           (RLS, pgvector, RPCs)
```

- **App:** Expo Router screens talk to Supabase directly for reads and simple writes, and to the backend for anything that involves a model.
- **Backend:** An Express server hosts a LangGraph supervisor that routes each chat turn to a specialized subgraph (planner, editor, analyst, memory). Tools read and write the user's plan, logs and memories through Supabase. Responses stream to the client over Server-Sent Events.
- **Exercise search:** Exercises carry structured metadata and OpenAI embeddings stored in pgvector. A hybrid (vector + keyword) search RPC grounds plan generation and swaps in real exercises.
- **Quotas and billing:** Per-user AI cost is metered per model call and enforced by a daily quota gate. Subscriptions run through RevenueCat, with a Supabase Edge Function webhook keeping the user's tier in sync.

## Tech stack

- **Frontend:** React Native 0.81 · Expo 54 · Expo Router · Reanimated · Zustand · TanStack Query
- **Backend:** Node · Express · TypeScript · LangGraph / LangChain
- **Database:** Supabase (Postgres, Auth, Storage, Edge Functions, pgvector)
- **AI:** OpenAI (chat, vision, embeddings, realtime voice) · Anthropic (fallback model)
- **Native:** Swift (Live Activity widget, depth-camera module) · Expo config plugins
- **Services:** RevenueCat · PostHog · Sentry · AdMob · Render

## Results

<!-- Add your numbers here (users, downloads, ratings, etc.) so they match your resume. -->

## Running it locally

1. Clone and install:
   ```bash
   git clone https://github.com/Ibrahimkasiim1/LiftAI-AI-Workout-Trainer.git
   cd LiftAI-AI-Workout-Trainer
   npm install
   npm run backend:install
   ```
2. Copy the env templates and fill in your own keys:
   ```bash
   cp .env.example .env
   cp backend/.env.example backend/.env
   ```
3. Create a Supabase project and apply the SQL in `supabase/migrations/` (and `migrations/` for the base schema).
4. Start the backend and the app:
   ```bash
   npm run dev      # backend on :3001
   npx expo start   # app (use a dev build for native modules)
   ```

Tests:

```bash
npm run test:navguards      # app navigation guards
cd backend && npm test      # backend unit tests
```

> The exercise dataset and GIFs come from a third-party source and are not included in this repository.

## Team

Solo project by [Ibrahimkasiim1](https://github.com/Ibrahimkasiim1).
