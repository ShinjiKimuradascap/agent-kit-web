# agent-kit-web

Web UI for [agent-kit](https://github.com/ShinjiKimuradascap/agent-kit).

```
┌─────────────────────────────────┐
│ Next.js (chat UI, catalog)      │   :3000
├─────────────────────────────────┤
│ FastAPI (SSE streaming)         │   :8765
├─────────────────────────────────┤
│ agent-kit (pip install -e ../)  │   ← unmodified dependency
├─────────────────────────────────┤
│ Postgres (sessions)             │
└─────────────────────────────────┘
```

## Features

- **Chat UI** — per-token SSE streaming, reasoning collapsed auto-reveal, IME-safe Enter, ⌘K palette
- **Catalog** — `/skills` and `/agents` pages to browse / edit the markdown files the runtime loads
- **Approval gate** — tool calls flagged by agent.md `permissions:` produce an editable card in the chat
- **Session picker** — resume any past conversation from the sidebar, grouped by Today / Yesterday / …
- **Linear-style theme** — dark panel, 5,500-loc-of-code energy

## Layout

```
agent-kit-web/
├── backend/         FastAPI + agent-kit glue (SSE + approval provider)
│   └── app/
│       ├── main.py        REST + SSE endpoints
│       ├── stream.py      agent-kit → SSE bridge, ApprovalProvider
│       ├── agents.py      build_runtime() from workspace/agents/*.md
│       ├── catalog.py     skills/agents markdown CRUD
│       └── sessions.py    sessions list/resume
└── frontend/        Next.js 15 (turbopack) + Tailwind + React 19
    ├── app/               chat, skills, agents pages
    └── components/        CommandPalette, CatalogView, StreamedMarkdown …
```

## Run locally

```bash
# 1. Install agent-kit first (sibling dir or `pip install agent-kit`)
git clone https://github.com/ShinjiKimuradascap/agent-kit
git clone https://github.com/ShinjiKimuradascap/agent-kit-web

# 2. Backend
cd agent-kit-web/backend
python3.12 -m venv .venv && source .venv/bin/activate
pip install -e ../../agent-kit      # agent-kit core
pip install -e .                     # web backend
uvicorn app.main:app --reload --port 8765

# 3. Frontend
cd ../frontend
npm install
npm run dev                          # http://localhost:3000
```

## Workspace

`backend/app/config.py` looks for agent definitions under `~/.agent-kit/` by default. Override with `WORKSPACE_DIR`:

```bash
export WORKSPACE_DIR=/path/to/your/workspace
```

Workspace shape (same as agent-kit CLI):

```
<workspace>/
├── config.yaml       # main_model / summary_model / runtime
├── agents/           # orchestrator.md, researcher.md, …
├── skills/           # domain knowledge loaded via load_skill()
└── .env              # API keys, DATABASE_URL (DB auto-detected by agent-kit)
```

## Dev notes

- **Dev streaming**: Next.js rewrites buffer SSE. The frontend hits `http://localhost:8765` directly on localhost and uses same-origin in prod (CORS allowlisted via `cors_origins` setting).
- **No auth** — single-user local tool. Putting this behind nginx + OAuth is left as an exercise.
- **Approval**: policy lives in agent.md `permissions:` (Claude Code-compatible). The web backend plugs an `ApprovalProvider` that emits SSE `approval_needed` events and resumes on POST.

## License

MIT.
