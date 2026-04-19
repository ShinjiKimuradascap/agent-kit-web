"""Session list/detail endpoints — thin wrapper over agent-kit's SessionStore."""

from __future__ import annotations

from agent_kit.store import SessionStore, _get_conn


def list_sessions(limit: int = 50) -> list[dict]:
    """Recent sessions with first-user-message preview."""
    return SessionStore.list_sessions(limit=limit, with_preview=True)


def load_messages(session_id: str) -> list[dict]:
    """Load full message history for a session (read-only, doesn't advance turn counter)."""
    import json
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT role, content, tool_calls, tool_call_id, created_at "
                "FROM messages WHERE session_id = %s ORDER BY turn_id",
                (session_id,),
            )
            out = []
            for role, content, tool_calls_json, tool_call_id, created_at in cur.fetchall():
                msg = {
                    "role": role,
                    "content": content or "",
                    "created_at": str(created_at),
                }
                if tool_calls_json:
                    msg["tool_calls"] = (
                        json.loads(tool_calls_json) if isinstance(tool_calls_json, str)
                        else tool_calls_json
                    )
                if tool_call_id:
                    msg["tool_call_id"] = tool_call_id
                out.append(msg)
            return out
    finally:
        conn.close()
