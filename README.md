# MemHub — Frontend

MemHub is a company knowledge/memory platform. This is the frontend: an AI assistant that
answers questions with cited sources, a document library with upload + indexing status, a
knowledge graph to explore how docs/people/projects connect, and basic usage analytics.

This repo is just the UI — it currently runs on mock data (see `src/data/mockData.js`) so it
can be developed and demoed without a backend.

## Tech stack

- React 19 + Vite
- React Router for routing
- Tailwind CSS (with the shadcn/ui-style component pattern under `src/components/ui`)
- Radix UI primitives (dialog, dropdown, tooltip, etc.) under the hood of those components
- Recharts for the dashboard/analytics charts
- Sonner for toast notifications

## Project structure

```
src/
  components/     shared UI (Sidebar, TopBar, StatCard, etc.) and components/ui (button, input, ...)
  pages/          one file per route (Dashboard, AIAssistant, Documents, Search, ...)
  contexts/       ThemeContext (light/dark/system)
  data/           mockData.js — all the fake data the UI runs on right now
  lib/            small utils (cn helper)
  App.jsx         routes
  main.jsx        entry point
```

## Getting started

```bash
npm install
npm run dev
```

The app runs at `http://localhost:5173`. `/` is the marketing landing page, `/login` and
`/register` are demo auth screens (they don't hit a real API — they just fake a delay and
redirect), and everything under `/app` is the actual product.

Other scripts:

```bash
npm run build     # production build
npm run preview   # preview the production build locally
npm run lint      # oxlint
```

## Notes

- There's no backend yet — uploading a document in the Documents page just adds a fake row
  and "processes" it with a `setTimeout`.
- Auth is not implemented; logging in just navigates to `/app`.
