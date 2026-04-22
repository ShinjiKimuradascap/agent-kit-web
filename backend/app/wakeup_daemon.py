"""Wakeup daemon: poll wakeups.json, POST due entries back to /api/chat/stream.

Runs as a single daemon thread started on backend boot (main.py startup).
Every POLL_INTERVAL seconds, claims due wake-ups and fires them by calling
the local chat stream endpoint with the stored session_id + prompt.
"""

from __future__ import annotations

import logging
import threading
import time
import requests

from agent_kit.tools.wakeup import claim_due_wakeups

logger = logging.getLogger("app.wakeup_daemon")

POLL_INTERVAL = 10  # seconds
_LOCAL_API = "http://127.0.0.1:8765/api/chat/stream"


def _fire(entry: dict) -> None:
    """POST a wakeup's prompt to the local chat stream endpoint."""
    sid = entry.get("session_id")
    prompt = entry.get("prompt", "")
    if not sid or not prompt:
        logger.warning(f"skipping malformed wakeup: {entry}")
        return
    body = {
        "message": f"[autonomous wakeup] {prompt}",
        "session_id": sid,
        "resume": True,
    }
    try:
        # Fire and forget — don't wait for the stream to complete.
        # Use a short read-timeout; the server will keep processing after we
        # disconnect (StreamingResponse runs independently).
        resp = requests.post(_LOCAL_API, json=body, timeout=(5, 3))
        logger.info(f"wakeup {entry.get('wakeup_id')} fired for session {sid}: "
                    f"HTTP {resp.status_code}")
    except requests.exceptions.ReadTimeout:
        # Expected — server keeps working, we just stopped listening.
        logger.info(f"wakeup {entry.get('wakeup_id')} fired for session {sid} "
                    "(server still processing)")
    except Exception as e:
        logger.warning(f"wakeup fire failed for {entry.get('wakeup_id')}: {e}")


def _loop() -> None:
    logger.info("wakeup daemon started (poll every %ds)", POLL_INTERVAL)
    while True:
        try:
            due = claim_due_wakeups()
            for entry in due:
                logger.info(f"firing wakeup: {entry.get('wakeup_id')}")
                _fire(entry)
        except Exception as e:
            logger.warning(f"wakeup poll error: {e}")
        time.sleep(POLL_INTERVAL)


def start_wakeup_daemon() -> threading.Thread:
    """Start the daemon thread (idempotent)."""
    t = threading.Thread(target=_loop, daemon=True, name="wakeup-daemon")
    t.start()
    return t
