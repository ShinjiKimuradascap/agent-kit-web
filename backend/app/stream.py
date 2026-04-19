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


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


async def run_stream(
    user_input: str,
    agent_name: Optional[str] = None,
    session_id: Optional[str] = None,
    resume: bool = False,
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

            final = rt.run(user_input, interrupt_flag=interrupt)
            q.put(("final", {"text": final}))
        except InterruptedError:
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
        interrupt.set()
        raise
    finally:
        interrupt.set()
        done.wait(timeout=2.0)
    yield _sse("done", {})
