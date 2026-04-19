"""App settings (env-driven)."""

from __future__ import annotations

import os
from pathlib import Path
from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

# Load local .env first (backend-specific overrides, CORS, etc.)
load_dotenv(Path(__file__).parent.parent / ".env")

# Then load workspace .env (agent-kit's env: DATABASE_URL, API keys) — non-overriding
_ws = os.environ.get("WORKSPACE_DIR", str(Path.home() / ".agent-kit"))
load_dotenv(Path(_ws) / ".env", override=False)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Where agent-kit's config.yaml / agents/ / skills/ live.
    # Override with WORKSPACE_DIR env var or backend/.env.
    workspace_dir: str = str(Path.home() / ".agent-kit")

    # Default agent to use when no orchestrator is specified
    default_agent_name: str = "orchestrator"

    # CORS origins (Next.js dev server)
    cors_origins: list[str] = ["http://localhost:3000"]

    # Postgres DSN — agent-kit reads its own via env var, we reuse the same.
    # This is only used by /api/sessions listing queries.
    database_url: str = "postgresql://localhost:5432/agent_kit"


settings = Settings()
