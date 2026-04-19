"""AgentRuntime factory — builds a configured AgentRuntime from workspace dir."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from agent_kit import AgentRuntime, load_config
from agent_kit.config import parse_agent_md, import_tools

from .config import settings


def list_available_agents() -> list[dict]:
    """Scan <workspace>/agents/*.md for agent definitions."""
    agents_dir = Path(settings.workspace_dir) / "agents"
    if not agents_dir.is_dir():
        return []
    out = []
    for md in sorted(agents_dir.glob("*.md")):
        try:
            ad = parse_agent_md(md)
            out.append({"name": ad.name, "description": ad.description, "file": md.name})
        except Exception:
            out.append({"name": md.stem, "description": "", "file": md.name})
    return out


def build_runtime(
    agent_name: Optional[str] = None,
    session_id: Optional[str] = None,
    resume: bool = False,
) -> AgentRuntime:
    """Build AgentRuntime from workspace.

    Loads:
      - <workspace>/config.yaml   → AgentConfig
      - <workspace>/agents/<name>.md → system prompt + tools
      - <workspace>/skills/       → skills catalog (auto-injected into system prompt)
    """
    workspace = Path(settings.workspace_dir).expanduser().resolve()
    os.chdir(str(workspace))

    cfg_path = workspace / "config.yaml"
    cfg = load_config(str(cfg_path) if cfg_path.exists() else None)

    # Resolve agent definition
    name = agent_name or settings.default_agent_name
    agent_md = workspace / "agents" / f"{name}.md"
    if not agent_md.exists():
        # Fall back to listing any agent
        agents = list(sorted((workspace / "agents").glob("*.md"))) if (workspace / "agents").is_dir() else []
        if not agents:
            raise FileNotFoundError(
                f"No agent '{name}.md' found in {workspace/'agents'}. "
                f"Create one with YAML frontmatter."
            )
        agent_md = agents[0]

    ad = parse_agent_md(agent_md)

    # Fill in workspace/skills as default skills_dir when the agent.md didn't set one
    skills_dir = workspace / "skills"
    if not ad.skills_dir and skills_dir.is_dir():
        ad.skills_dir = str(skills_dir)

    # Propagate agent.md fields into the runtime's AgentConfig so the runtime
    # can see approval policy, strict_tools, skills_dir, etc.
    cfg.agent = ad

    # Import tools listed in frontmatter (if any)
    tools = []
    if ad.tool_paths:
        try:
            tools = import_tools(ad.tool_paths, scan_dirs=[str(workspace / "tools")])
        except ImportError as e:
            # Surface the error — bad agent config is not silently ignorable
            raise RuntimeError(f"Agent '{ad.name}' tool import failed: {e}") from e

    runtime = AgentRuntime(
        tools=tools,
        config=cfg,
        system_prompt=ad.system_prompt,
        name=ad.name,
        session_id=session_id,
        resume=resume,
    )
    return runtime
