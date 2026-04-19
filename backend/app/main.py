"""FastAPI app — chat + sessions + agents catalog."""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .agents import list_available_agents
from .catalog import Kind, delete_item, list_items, read_item, write_item
from .config import settings
from .sessions import list_sessions, load_messages
from .stream import cancel_run, resolve_approval, run_stream

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="agent-kit-web")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str
    agent: Optional[str] = None
    session_id: Optional[str] = None
    resume: bool = False


@app.get("/api/health")
def health():
    return {"ok": True, "workspace": settings.workspace_dir}


@app.get("/api/agents")
def agents():
    return {"agents": list_available_agents()}


@app.get("/api/sessions")
def sessions(limit: int = Query(50, ge=1, le=200)):
    return {"sessions": list_sessions(limit=limit)}


@app.get("/api/sessions/{session_id}/messages")
def session_messages(session_id: str):
    msgs = load_messages(session_id)
    if not msgs:
        raise HTTPException(404, "Session not found or empty")
    return {"session_id": session_id, "messages": msgs}


@app.post("/api/chat/stream")
async def chat_stream(req: ChatRequest):
    return StreamingResponse(
        run_stream(
            user_input=req.message,
            agent_name=req.agent,
            session_id=req.session_id,
            resume=req.resume or bool(req.session_id),
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable nginx buffering
        },
    )


@app.delete("/api/chat/{session_id}")
def chat_cancel(session_id: str):
    ok = cancel_run(session_id)
    if not ok:
        raise HTTPException(404, "No active run for this session")
    return {"cancelled": True}


class ApprovalDecision(BaseModel):
    approval_id: str
    approved: bool
    edited_args: Optional[dict] = None
    reason: str = ""


# ---- Catalog: skills & agents ----

def _kind(kind: str) -> Kind:
    if kind not in ("skills", "agents"):
        raise HTTPException(400, "kind must be 'skills' or 'agents'")
    return kind  # type: ignore[return-value]


@app.get("/api/catalog/{kind}")
def catalog_list(kind: str):
    return {"items": list_items(_kind(kind))}


@app.get("/api/catalog/{kind}/{name}")
def catalog_get(kind: str, name: str):
    try:
        return read_item(_kind(kind), name)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


class CatalogWriteBody(BaseModel):
    content: str


@app.put("/api/catalog/{kind}/{name}")
def catalog_put(kind: str, name: str, body: CatalogWriteBody):
    try:
        return write_item(_kind(kind), name, body.content)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/catalog/{kind}/{name}")
def catalog_delete(kind: str, name: str):
    try:
        return delete_item(_kind(kind), name)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/chat/{session_id}/approve")
def chat_approve(session_id: str, body: ApprovalDecision):
    ok = resolve_approval(
        session_id, body.approval_id,
        approved=body.approved,
        edited_args=body.edited_args,
        reason=body.reason,
    )
    if not ok:
        raise HTTPException(404, "No pending approval with that id")
    return {"ok": True}
