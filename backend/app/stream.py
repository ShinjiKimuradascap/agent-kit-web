"""Stream an agent run as SSE events, with approval gate for risky tools.

Runs AgentRuntime.run() on a worker thread. Hooks push events onto a
thread-safe queue; the async generator drains it and yields SSE frames.

Approval gate:
- Runtime owns the policy (agent.md `approval:` + tool side_effect).
- This module supplies the mechanism: an ApprovalProvider that emits a
  SSE `approval_needed` event and blocks on a threading.Event until the
  browser POSTs to /api/chat/{sid}/approve.
- Approved calls may include edited args from the user.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import uuid
from queue import Queue, Empty
from typing import AsyncIterator, Optional

from .agents import build_runtime

logger = logging.getLogger(__name__)

# session_id → { "interrupt": Event, "pending": {approval_id → ApprovalSlot} }
_active_runs: dict[str, dict] = {}


# LLM streaming is forwarded through agent-kit's native `on_text_chunk` /
# `on_reasoning_chunk` hooks (see PR#21). No monkey-patch required.


class ApprovalSlot:
    """One pending approval: worker blocks on event, frontend fills decision."""
    def __init__(self):
        self.event = threading.Event()
        self.approved: Optional[bool] = None
        self.edited_args: Optional[dict] = None
        self.reason: str = ""


def cancel_run(session_id: str) -> bool:
    run = _active_runs.get(session_id)
    if run is None:
        return False
    run["interrupt"].set()
    # Unblock any pending approval so the worker can see the interrupt
    for slot in run.get("pending", {}).values():
        slot.approved = False
        slot.reason = "cancelled"
        slot.event.set()
    return True


def resolve_approval(
    session_id: str, approval_id: str,
    approved: bool, edited_args: Optional[dict] = None,
    reason: str = "",
) -> bool:
    run = _active_runs.get(session_id)
    if run is None:
        return False
    slot = run.get("pending", {}).pop(approval_id, None)
    if slot is None:
        return False
    slot.approved = approved
    slot.edited_args = edited_args
    slot.reason = reason
    slot.event.set()
    return True


def _legacy_fields(event: str, data: dict) -> dict:
    """Translate agent-kit SSE events to open-entity-compatible payload fields.

    The Slack gateway in open-entity ignores the SSE `event:` header and
    dispatches on `data.type` instead (chunk / progress / start / done / error).
    Emitting both shapes keeps new clients (agent-kit-web UI) and legacy
    gateways working against the same endpoint.
    """
    if event == "session":
        return {"type": "start"}
    if event == "text_chunk":
        return {"type": "chunk", "content": data.get("chunk", ""), "agent": ""}
    if event == "tool_start":
        return {
            "type": "progress", "event": "tool",
            "tool": data.get("name", ""), "status": "running",
        }
    if event == "tool_end":
        d = f"{data.get('duration', 0):.1f}s" if data.get("duration") else ""
        return {
            "type": "progress", "event": "tool",
            "tool": data.get("name", ""), "status": "done", "detail": d,
        }
    if event == "final":
        return {"type": "done"}
    if event == "done":
        return {"type": "done"}
    if event == "error":
        return {"type": "error", "message": data.get("message", "")}
    if event == "interrupted":
        return {"type": "done"}
    return {}


def _sse(event: str, data: dict) -> str:
    # Merge legacy open-entity-compatible fields so gateways that dispatch
    # on data.type / data.content keep functioning.
    payload = {**data, **_legacy_fields(event, data)}
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n"


def _persist_attachments(attachments: Optional[list[dict]]) -> list[str]:
    """Save base64-encoded attachments to /tmp and return the file paths.

    Slack gateway delivers each as {type, name, mime_type, data (b64)}.
    Agents consume them by reading the paths we return (analyze_image/read_file).
    """
    if not attachments:
        return []
    import base64 as _b64
    import os as _os
    import uuid as _uuid
    out_dir = "/tmp/slack_attachments"
    _os.makedirs(out_dir, exist_ok=True)
    paths: list[str] = []
    for att in attachments:
        data = att.get("data")
        if not data:
            continue
        name = att.get("name") or f"attachment_{_uuid.uuid4().hex[:8]}"
        # Prefix with uuid to avoid collisions between messages
        safe = f"{_uuid.uuid4().hex[:8]}_{name}"
        path = _os.path.join(out_dir, safe)
        try:
            with open(path, "wb") as f:
                f.write(_b64.b64decode(data))
            paths.append(path)
        except Exception as e:
            logger.warning(f"failed to persist attachment {name}: {e}")
    return paths


async def run_stream(
    user_input: str,
    agent_name: Optional[str] = None,
    session_id: Optional[str] = None,
    resume: bool = False,
    attachments: Optional[list[dict]] = None,
    channel_id: Optional[str] = None,
) -> AsyncIterator[str]:
    """Run an agent turn and stream events as SSE."""
    q: Queue = Queue()
    interrupt = threading.Event()
    done = threading.Event()
    runtime_holder: dict = {}

    def worker():
        from agent_kit.approval import ApprovalDecision

        try:
            rt = build_runtime(agent_name=agent_name, session_id=session_id, resume=resume)
            runtime_holder["rt"] = rt
            runtime_holder["session_id"] = rt.session_id

            # Per-channel tree isolation: when Slack gateway provides a
            # channel_id, shard the tree_id so confidential branches in one
            # channel don't leak across channels. Local CLI / Web UI leaves
            # channel_id=None and keeps the shared agent-level tree.
            # Tree tools are an optional agent-kit feature — silently skip
            # when absent so this backend runs against public agent-kit too.
            if channel_id and rt.cfg.agent.tree_id:
                try:
                    from agent_kit.tools.tree import set_current_tree_id
                    set_current_tree_id(f"{rt.cfg.agent.tree_id}-{channel_id}")
                except ImportError:
                    pass
            if rt.session_id:
                _active_runs[rt.session_id] = {"interrupt": interrupt, "pending": {}}

            # Approval provider: pop a UI-side approval card via SSE and
            # block the agent thread until the browser POSTs a decision.
            # Runtime now owns the policy (`approval:` frontmatter +
            # side_effect); we only supply the mechanism.
            def _web_approval_provider(name: str, args: dict, side_effect: str) -> ApprovalDecision:
                slot = ApprovalSlot()
                approval_id = uuid.uuid4().hex[:8]
                if rt.session_id:
                    _active_runs[rt.session_id]["pending"][approval_id] = slot
                q.put(("approval_needed", {
                    "approval_id": approval_id,
                    "name": name,
                    "args": args,
                    "side_effect": side_effect,
                }))
                while not slot.event.wait(timeout=0.5):
                    if interrupt.is_set():
                        return ApprovalDecision(False, None, "interrupted before approval")
                if not slot.approved:
                    q.put(("approval_rejected", {"approval_id": approval_id, "reason": slot.reason}))
                    return ApprovalDecision(False, None, slot.reason or "user denied")
                q.put(("approval_approved", {
                    "approval_id": approval_id,
                    "edited": slot.edited_args is not None,
                }))
                return ApprovalDecision(True, slot.edited_args, "")

            rt.approval_provider = _web_approval_provider

            # --- Hook → queue bridge ---
            turn_id = {"n": 0}
            # Seed stream_id from monotonic ns so sends never collide with
            # bubbles left over from earlier sends (otherwise turn 1 of a
            # new send would have stream_id=1, matching the previous
            # send's turn 1 bubble and appending into it).
            import time as _time_mod
            streaming_id = {"n": _time_mod.monotonic_ns() // 1000}

            def on_llm_start():
                # Open a new streaming text bubble for this turn
                streaming_id["n"] += 1
                q.put(("llm_start", {"stream_id": streaming_id["n"]}))

            def on_llm_end(duration: float):
                # Close the current streaming bubble
                q.put(("llm_end", {"stream_id": streaming_id["n"], "duration": duration}))

            def on_assistant_text(text: str):
                # Runtime fires this with the consolidated narration (when tool calls follow)
                # We send it as a "commit" — frontend overwrites its accumulated chunks
                # with the canonical text to guarantee correctness.
                q.put(("assistant_text", {"stream_id": streaming_id["n"], "text": text}))

            def on_text_chunk(chunk: str):
                if chunk:
                    q.put(("text_chunk", {"stream_id": streaming_id["n"], "chunk": chunk}))

            def on_reasoning_chunk(chunk: str):
                if chunk:
                    q.put(("reasoning_chunk", {"stream_id": streaming_id["n"], "chunk": chunk}))

            def on_tool_start(name: str, args: dict):
                turn_id["n"] += 1
                q.put(("tool_start", {
                    "id": f"t{turn_id['n']}",
                    "name": name,
                    "args": args,
                }))

            def on_tool_end(name: str, result: str, duration: float):
                q.put(("tool_end", {
                    "id": f"t{turn_id['n']}",
                    "name": name,
                    "result": result,
                    "duration": duration,
                }))

            rt.on_llm_start = on_llm_start
            rt.on_llm_end = on_llm_end
            rt.on_assistant_text = on_assistant_text
            rt.on_text_chunk = on_text_chunk
            rt.on_reasoning_chunk = on_reasoning_chunk
            rt.on_tool_start = on_tool_start
            rt.on_tool_end = on_tool_end

            q.put(("session", {"session_id": rt.session_id, "agent": rt.name}))

            # Inline attachment paths into the user's message so the agent
            # picks them up via analyze_image / read_file without needing
            # multimodal message parts.
            saved_paths = _persist_attachments(attachments)
            effective_input = user_input
            if saved_paths:
                prefix = "\n".join(f"[添付ファイル] {p}" for p in saved_paths)
                effective_input = f"{prefix}\n\n{user_input}" if user_input.strip() else prefix

            final = rt.run(effective_input, interrupt_flag=interrupt)
            logger.info(
                "WEB-RUN-END sid=%s msgs=%d final_len=%d head=%r tail=%r",
                rt.session_id, len(rt.messages), len(final or ""),
                (final or "")[:120], (final or "")[-120:],
            )
            q.put(("final", {"text": final}))
        except InterruptedError:
            logger.info("WEB-RUN-INTERRUPTED sid=%s", runtime_holder.get("session_id"))
            q.put(("interrupted", {}))
        except Exception as e:
            logger.exception("agent run failed")
            q.put(("error", {"message": str(e), "type": type(e).__name__}))
        finally:
            sid = runtime_holder.get("session_id")
            if sid:
                _active_runs.pop(sid, None)
            done.set()

    t = threading.Thread(target=worker, daemon=True)
    t.start()

    loop = asyncio.get_running_loop()

    try:
        while True:
            try:
                event, payload = await loop.run_in_executor(
                    None, lambda: q.get(timeout=0.5)
                )
                yield _sse(event, payload)
                if event in ("final", "error", "interrupted"):
                    break
            except Empty:
                if done.is_set() and q.empty():
                    break
                yield ": keepalive\n\n"
    except asyncio.CancelledError:
        logger.info(
            "WEB-SSE-CANCELLED sid=%s (browser dropped connection mid-run)",
            runtime_holder.get("session_id"),
        )
        interrupt.set()
        raise
    finally:
        interrupt.set()
        done.wait(timeout=2.0)
    yield _sse("done", {})
