"use client";

import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/atom-one-dark.css";

import CommandPalette from "@/components/CommandPalette";
import { SessionItem, groupSessionsByDate } from "@/lib/groupSessions";

type MsgRole = "user" | "assistant";

type ToolBubble = {
  kind: "tool";
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  duration?: number;
  running: boolean;
};

type TextBubble = {
  kind: "text";
  role: MsgRole;
  text: string;
  reasoning?: string;     // LLM thinking / reasoning content (collapsed by default)
  streaming?: boolean;
  streamId?: number;
};

type ApprovalBubble = {
  kind: "approval";
  approvalId: string;
  name: string;
  args: Record<string, unknown>;
  sideEffect: string;
  status: "pending" | "approved" | "rejected";
  editedArgs?: string;
};

type Bubble = TextBubble | ToolBubble | ApprovalBubble;

const EXAMPLES = [
  { title: "今日のニュースを要約", body: "今日の主要な経済ニュースを3行で" },
  { title: "ファイルを読む", body: "/tmp/alpha_scan_20260418.pptx の中身を確認" },
  { title: "Webを検索", body: "Fed の次回会合でのrate decisionの確率を調べて" },
  { title: "deep analysis", body: "deep-analysis を使って NVDA を light で分析" },
];

// Dev-mode: bypass Next.js rewrite proxy (buffers SSE / streaming responses).
// Prod: use relative URLs so same-origin deployment works.
function apiBase(): string {
  if (typeof window === "undefined") return "";
  if (window.location.hostname === "localhost" && window.location.port === "3000") {
    return "http://localhost:8765";
  }
  return "";
}

export default function Page() {
  const [input, setInput] = useState("");
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [agent, setAgent] = useState<string>("");
  const [agents, setAgents] = useState<{ name: string; description: string }[]>([]);
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([]);
  const [running, setRunning] = useState(false);
  // Queued messages: typed while a run is active. Auto-drained when the
  // current run finishes (`done` SSE), or individually removed via the
  // cancel × on each card.
  const [queue, setQueue] = useState<string[]>([]);
  const queueRef = useRef<string[]>([]);
  useEffect(() => { queueRef.current = queue; }, [queue]);
  const [thinking, setThinking] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollBottom = () => {
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  };

  const loadSessions = useCallback(async () => {
    const r = await fetch("/api/sessions");
    if (r.ok) setSessions((await r.json()).sessions);
  }, []);

  useEffect(() => {
    (async () => {
      const [a, s] = await Promise.all([
        fetch("/api/agents").then((r) => r.json()),
        fetch("/api/catalog/skills").then((r) => r.json()),
      ]);
      setAgents(a.agents);
      if (a.agents[0]) setAgent(a.agents[0].name);
      setSkills((s.items || []).map((i: any) => ({ name: i.name, description: i.description })));
      await loadSessions();
    })();
  }, [loadSessions]);

  // ⌘K command palette
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const openSession = async (sid: string) => {
    if (running) return;
    const r = await fetch(`/api/sessions/${sid}/messages`);
    if (!r.ok) return;
    const data = await r.json();
    const bs: Bubble[] = [];
    for (const m of data.messages) {
      if (m.role === "user" && m.content) {
        bs.push({ kind: "text", role: "user", text: m.content });
      } else if (m.role === "assistant") {
        if (m.content) bs.push({ kind: "text", role: "assistant", text: m.content });
        for (const tc of m.tool_calls || []) {
          try {
            const args = JSON.parse(tc.function?.arguments || "{}");
            bs.push({
              kind: "tool",
              id: tc.id || Math.random().toString(36),
              name: tc.function?.name || "tool",
              args,
              running: false,
            });
          } catch {}
        }
      } else if (m.role === "tool" && bs.length) {
        for (let i = bs.length - 1; i >= 0; i--) {
          const b = bs[i];
          if (b.kind === "tool" && b.id === m.tool_call_id) {
            b.result = m.content;
            break;
          }
        }
      }
    }
    setBubbles(bs);
    setSessionId(sid);
    scrollBottom();
  };

  // Main send: fires one turn. Callers decide what to do if `running`:
  //  - queueOrSend(): append to queue while running, send when idle
  //  - interruptAndSend(): abort current run + send immediately
  const send = async (overrideText?: string) => {
    const text = overrideText ?? input;
    if (!text.trim() || running) return;
    setInput("");
    setBubbles((b) => [...b, { kind: "text", role: "user", text }]);
    setRunning(true);
    setThinking(true);
    setStatus("送信中…");
    scrollBottom();

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const resp = await fetch(`${apiBase()}/api/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          agent: agent || undefined,
          session_id: sessionId || undefined,
          resume: !!sessionId,
        }),
        signal: ac.signal,
      });
      if (!resp.body) throw new Error("no response body");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          // flushSync forces React to commit this frame's state updates
          // *before* the next iteration — otherwise React 18 auto-batching
          // would coalesce the whole burst into a single render.
          flushSync(() => handleSseFrame(frame));
        }
      }
    } catch (e: any) {
      if (e.name !== "AbortError") {
        setBubbles((b) => [...b, { kind: "text", role: "assistant", text: `Error: ${e.message}` }]);
      }
    } finally {
      setRunning(false);
      setThinking(false);
      setStatus("");
      abortRef.current = null;
      await loadSessions();
      // Drain the queue: if the user stacked messages while running, send
      // the next one now. Do this after setRunning(false) has been flushed.
      setTimeout(() => {
        const next = queueRef.current[0];
        if (next) {
          setQueue((q) => q.slice(1));
          send(next);
        }
      }, 30);
    }
  };

  // Type while running → this queues the message.
  const queueOrSend = (text?: string) => {
    const msg = (text ?? input).trim();
    if (!msg) return;
    if (running) {
      setQueue((q) => [...q, msg]);
      setInput("");
    } else {
      send(msg);
    }
  };

  // ⌘+Enter / red button: abort current run, send this immediately.
  const interruptAndSend = async (text?: string) => {
    const msg = (text ?? input).trim();
    if (!msg) return;
    setInput("");
    if (running && sessionId) {
      try {
        await fetch(`${apiBase()}/api/chat/${sessionId}`, { method: "DELETE" });
      } catch {}
      abortRef.current?.abort();
      // Wait briefly for the running fetch to unwind; interval matches drain timer.
      await new Promise((r) => setTimeout(r, 80));
    }
    send(msg);
  };

  const removeFromQueue = (i: number) =>
    setQueue((q) => q.filter((_, idx) => idx !== i));

  const handleSseFrame = (frame: string) => {
    const lines = frame.split("\n");
    let event = "message";
    let data = "";
    for (const ln of lines) {
      if (ln.startsWith("event:")) event = ln.slice(6).trim();
      else if (ln.startsWith("data:")) data += ln.slice(5).trim();
    }
    if (!data) return;
    let payload: any = {};
    try { payload = JSON.parse(data); } catch { return; }

    setBubbles((prev) => {
      let next = [...prev];
      const commitStreaming = () => {
        for (let i = next.length - 1; i >= 0; i--) {
          const b = next[i];
          if (b.kind === "text" && b.streaming) {
            next = next.map((x, j) =>
              j === i ? { ...(x as TextBubble), streaming: false } : x,
            );
            break;
          }
        }
      };
      const upsertStreamText = (streamId: number, newText: string, append: boolean) => {
        for (let i = next.length - 1; i >= 0; i--) {
          const b = next[i];
          if (b.kind === "text" && b.role === "assistant" && b.streamId === streamId) {
            const t = b as TextBubble;
            next = next.map((x, j) =>
              j === i
                ? { ...t, text: append ? t.text + newText : newText }
                : x,
            );
            return true;
          }
        }
        if (newText || !append) {
          next.push({
            kind: "text",
            role: "assistant",
            text: newText,
            streaming: append,
            streamId,
          });
          return true;
        }
        return false;
      };

      switch (event) {
        case "session":
          setSessionId(payload.session_id);
          break;
        case "llm_start":
          setThinking(true);
          setStatus("考え中…");
          break;
        case "llm_end":
          commitStreaming();
          setThinking(false);
          setStatus("");
          break;
        case "text_chunk":
          upsertStreamText(payload.stream_id, payload.chunk || "", true);
          break;
        case "reasoning_chunk": {
          // Append to the streaming bubble's reasoning field, or create one
          const streamId = payload.stream_id;
          const chunk = payload.chunk || "";
          let found = false;
          for (let i = next.length - 1; i >= 0; i--) {
            const b = next[i];
            if (b.kind === "text" && b.role === "assistant" && b.streamId === streamId) {
              const t = b as TextBubble;
              next = next.map((x, j) =>
                j === i ? { ...t, reasoning: (t.reasoning || "") + chunk } : x,
              );
              found = true;
              break;
            }
          }
          if (!found) {
            next.push({
              kind: "text",
              role: "assistant",
              text: "",
              reasoning: chunk,
              streaming: true,
              streamId,
            });
          }
          break;
        }
        case "assistant_text":
          // Consolidated narration after streaming — replace to guarantee canonical text
          upsertStreamText(payload.stream_id, payload.text || "", false);
          break;
        case "tool_start":
          commitStreaming();
          next.push({
            kind: "tool",
            id: payload.id,
            name: payload.name,
            args: payload.args || {},
            running: true,
          });
          setStatus(`${payload.name}…`);
          break;
        case "tool_end":
          for (let i = next.length - 1; i >= 0; i--) {
            const b = next[i];
            if (b.kind === "tool" && b.id === payload.id) {
              next = next.map((x, j) =>
                j === i
                  ? {
                      ...(x as ToolBubble),
                      result: payload.result,
                      duration: payload.duration,
                      running: false,
                    }
                  : x,
              );
              break;
            }
          }
          setStatus("");
          break;
        case "approval_needed":
          next.push({
            kind: "approval",
            approvalId: payload.approval_id,
            name: payload.name,
            args: payload.args || {},
            sideEffect: payload.side_effect || "unknown",
            status: "pending",
            editedArgs: JSON.stringify(payload.args, null, 2),
          });
          setStatus(`承認待ち: ${payload.name}`);
          break;
        case "approval_approved":
        case "approval_rejected":
          for (let i = next.length - 1; i >= 0; i--) {
            const b = next[i];
            if (b.kind === "approval" && b.approvalId === payload.approval_id) {
              next = next.map((x, j) =>
                j === i
                  ? {
                      ...(x as ApprovalBubble),
                      status: event === "approval_approved" ? "approved" : "rejected",
                    }
                  : x,
              );
              break;
            }
          }
          setStatus("");
          break;
        case "final": {
          // Final reply text. By the time this arrives, `llm_end` has
          // usually fired and commitStreaming() cleared the `streaming`
          // flag on the bubble the chunks were appended to — so a naive
          // "find streaming bubble" search returns nothing and we end up
          // pushing a duplicate. Fix: look at the LAST assistant text
          // bubble; if its text is a prefix/equal to the final text (or
          // vice versa), reconcile into it instead of pushing.
          const finalText = payload.text || "";
          if (!finalText) break;

          let merged = false;
          for (let i = next.length - 1; i >= 0; i--) {
            const b = next[i];
            // skip non-text (tool / approval) bubbles
            if (b.kind !== "text") continue;
            if (b.role !== "assistant") {
              // The most recent assistant text bubble comes after any user
              // bubble only if the turn produced nothing — stop scanning
              // so we create a fresh assistant bubble below.
              break;
            }
            const t = b as TextBubble;
            if (
              t.text === finalText ||
              finalText.startsWith(t.text) ||
              t.text.startsWith(finalText)
            ) {
              next = next.map((x, j) =>
                j === i ? { ...t, text: finalText, streaming: false } : x,
              );
              merged = true;
            }
            break; // only the latest assistant bubble
          }
          if (!merged) {
            next.push({ kind: "text", role: "assistant", text: finalText });
          }
          break;
        }
        case "interrupted":
          next.push({ kind: "text", role: "assistant", text: "_(中断しました)_" });
          break;
        case "error":
          next.push({ kind: "text", role: "assistant", text: `**Error:** ${payload.message}` });
          break;
      }
      return next;
    });
    scrollBottom();
  };

  const cancel = async () => {
    if (!sessionId) return;
    await fetch(`${apiBase()}/api/chat/${sessionId}`, { method: "DELETE" });
    abortRef.current?.abort();
  };

  const decideApproval = async (
    approvalId: string,
    approved: boolean,
    editedArgsRaw?: string,
  ) => {
    if (!sessionId) return;
    let editedArgs: Record<string, unknown> | undefined;
    if (approved && editedArgsRaw) {
      try {
        editedArgs = JSON.parse(editedArgsRaw);
      } catch {
        alert("args must be valid JSON");
        return;
      }
    }
    await fetch(`${apiBase()}/api/chat/${sessionId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approval_id: approvalId, approved, edited_args: editedArgs }),
    });
  };

  const newChat = () => {
    if (running) return;
    setSessionId(null);
    setBubbles([]);
  };

  const grouped = useMemo(() => groupSessionsByDate(sessions), [sessions]);

  const insertSkillRef = (name: string) => {
    setInput((prev) => `${prev}${prev ? "\n" : ""}skill: ${name}`);
    textareaRef.current?.focus();
  };

  return (
    <div className="flex h-full">
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        sessions={sessions}
        agents={agents}
        skills={skills}
        onOpenSession={openSession}
        onSwitchAgent={setAgent}
        onInsertSkillRef={insertSkillRef}
        onNewChat={newChat}
      />

      {/* Sidebar */}
      <aside className="w-72 border-r border-border flex flex-col bg-surface/50">
        <div className="p-3 border-b border-border">
          <button
            onClick={newChat}
            disabled={running}
            className="w-full py-2 px-3 rounded-md bg-elevated hover:bg-border-strong text-sm transition disabled:opacity-50"
          >
            + 新しいチャット
          </button>
          {agents.length > 0 && (
            <select
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              disabled={running || !!sessionId}
              className="w-full mt-2 bg-elevated border border-border rounded-md px-2 py-1.5 text-sm disabled:opacity-50"
            >
              {agents.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => setPaletteOpen(true)}
            className="w-full mt-2 py-1.5 px-3 rounded-md border border-border hover:bg-elevated text-xs text-muted flex items-center gap-2 transition"
          >
            <span>検索・コマンド</span>
            <kbd className="ml-auto text-[10px] px-1.5 py-0.5 bg-bg rounded border border-border">⌘K</kbd>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {grouped.map((g) => (
            <div key={g.label} className="mb-1">
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-subtle">
                {g.label}
              </div>
              {g.items.map((s) => (
                <button
                  key={s.session_id}
                  onClick={() => openSession(s.session_id)}
                  className={`block w-full text-left px-3 py-2 hover:bg-elevated text-xs transition ${
                    sessionId === s.session_id ? "bg-elevated border-l-2 border-accent" : ""
                  }`}
                >
                  <div className="truncate text-text">{s.preview || "(新規)"}</div>
                  <div className="text-subtle text-[10px] mt-0.5 truncate">
                    {s.agent} · {s.session_id.slice(0, 8)}
                  </div>
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0">
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-6 py-6 space-y-4">
            {bubbles.length === 0 && !thinking ? (
              <EmptyState agent={agent} onPick={(body) => send(body)} />
            ) : (
              bubbles.map((b, i) => (
                <BubbleView
                  key={i}
                  b={b}
                  streaming={b.kind === "text" && !!b.streaming}
                  onDecide={decideApproval}
                  onEditArgs={(id, v) =>
                    setBubbles((prev) =>
                      prev.map((x) =>
                        x.kind === "approval" && x.approvalId === id
                          ? { ...x, editedArgs: v }
                          : x,
                      ),
                    )
                  }
                />
              ))
            )}
            {thinking &&
              !bubbles.some((b) => b.kind === "text" && b.streaming) && (
                <ThinkingShimmer status={status} />
              )}
          </div>
        </div>

        <div className="border-t border-border bg-gradient-to-b from-transparent to-bg">
          <div className="max-w-3xl mx-auto px-6 py-4">
            {/* Queued messages (shown while a run is active or queue non-empty) */}
            {queue.length > 0 && (
              <div className="mb-3 space-y-1.5">
                {queue.map((msg, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 px-3 py-1.5 rounded-lg bg-surface/70 border border-border text-xs"
                  >
                    <span className="text-[10px] uppercase tracking-wider text-subtle mt-0.5">
                      Queued {i + 1}
                    </span>
                    <span className="flex-1 min-w-0 truncate text-muted">{msg}</span>
                    <button
                      onClick={() => removeFromQueue(i)}
                      aria-label="cancel queued"
                      className="text-subtle hover:text-danger transition"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="relative bg-surface border border-border rounded-2xl shadow-soft focus-within:border-border-strong transition">
              <ImeTextarea
                ref={textareaRef}
                value={input}
                onChange={setInput}
                onSend={() => queueOrSend()}
                onInterruptSend={() => interruptAndSend()}
                disabled={false}
              />
              {/* Floating action buttons */}
              <div className="absolute right-2 bottom-2 flex items-center gap-2">
                {running && (
                  <button
                    onClick={cancel}
                    aria-label="停止"
                    title="停止"
                    className="h-8 w-8 rounded-full bg-danger/90 hover:bg-danger text-white flex items-center justify-center transition"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                      <rect x="2" y="2" width="8" height="8" rx="1" />
                    </svg>
                  </button>
                )}
                <button
                  onClick={() => queueOrSend()}
                  disabled={!input.trim()}
                  aria-label={running ? "キューに追加" : "送信"}
                  title={running ? "キューに追加 (Enter)" : "送信 (Enter)"}
                  className="h-8 w-8 rounded-full bg-accent text-accent-fg disabled:opacity-30 disabled:cursor-not-allowed enabled:hover:opacity-90 flex items-center justify-center transition"
                >
                  {running ? (
                    <span className="text-[15px] leading-none">＋</span>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 2 L8 14 M3 7 L8 2 L13 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            <div className="mt-2 px-1 text-[11px] text-subtle flex items-center gap-3 flex-wrap">
              {running ? (
                <span>Enter で<b className="text-text">キュー</b>に追加 · ⌘+Enter で<b className="text-danger">割り込み送信</b> · Shift+Enter で改行</span>
              ) : (
                <span>Enter で送信 · Shift+Enter で改行</span>
              )}
              {status && <span className="text-muted">{status}</span>}
              {queue.length > 0 && !running && (
                <span className="text-accent">↻ キュー {queue.length} 件を順次送信します</span>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

/* ---- Input: IME-aware Enter = send ---- */
type ImeTextareaProps = {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onInterruptSend?: () => void;   // ⌘/Ctrl + Enter
  disabled: boolean;
};

const ImeTextarea = forwardRef<HTMLTextAreaElement, ImeTextareaProps>(function ImeTextarea(
  { value, onChange, onSend, onInterruptSend, disabled },
  ref,
) {
  const composing = useRef(false);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={() => (composing.current = false)}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        // IME composition guard
        if (composing.current) return;
        if ((e.nativeEvent as any).isComposing) return;
        if ((e.nativeEvent as any).keyCode === 229) return;
        // Shift+Enter → newline (default)
        if (e.shiftKey) return;
        // ⌘+Enter / Ctrl+Enter → interrupt current run and send
        if ((e.metaKey || e.ctrlKey) && onInterruptSend) {
          e.preventDefault();
          onInterruptSend();
          return;
        }
        // Plain Enter → queue or send (host decides)
        e.preventDefault();
        onSend();
      }}
      placeholder="メッセージを入力…"
      disabled={disabled}
      rows={2}
      className="w-full bg-transparent pl-4 pr-20 pt-3 pb-3 resize-none text-sm outline-none placeholder:text-subtle disabled:opacity-60 min-h-[56px] max-h-[240px]"
    />
  );
});

function EmptyState({ agent, onPick }: { agent: string; onPick: (body: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="text-4xl font-semibold tracking-tight mb-2">agent-kit-web</div>
      <div className="text-muted text-sm mb-10">
        {agent ? <>現在の agent: <span className="font-mono text-text">{agent}</span></> : "agent を選んでください"}
      </div>
      <div className="grid grid-cols-2 gap-3 w-full max-w-2xl">
        {EXAMPLES.map((ex) => (
          <button
            key={ex.title}
            onClick={() => onPick(ex.body)}
            className="text-left p-4 rounded-lg border border-border hover:border-border-strong hover:bg-surface transition group"
          >
            <div className="text-sm font-medium mb-1 group-hover:text-accent transition">
              {ex.title}
            </div>
            <div className="text-xs text-muted truncate">{ex.body}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function ThinkingShimmer({ status }: { status?: string }) {
  // Live elapsed counter + rotating hints. GPT-5 family can pre-reason
  // silently for 20-60s on complex queries; we show progressively more
  // informative text as time passes so the user knows it's working.
  const [startedAt] = useState(() => Date.now());
  const [, setTick] = useState(0);
  useEffect(() => {
    const h = window.setInterval(() => setTick((t) => t + 1), 100);
    return () => window.clearInterval(h);
  }, []);
  const elapsed = (Date.now() - startedAt) / 1000;

  // Staged hints — each unlocks after N seconds of no chunks arriving
  let hint = "Thinking";
  let detail: string | null = null;
  if (elapsed < 3) hint = "Thinking";
  else if (elapsed < 8) hint = "Consulting the model";
  else if (elapsed < 20) {
    hint = "Reasoning";
    detail = "GPT-5 系は内部で長考してから出力します";
  } else if (elapsed < 45) {
    hint = "Deep reasoning";
    detail = "複雑なクエリは 30-60 秒かかることがあります";
  } else if (elapsed < 90) {
    hint = "Still working";
    detail = "モデルはまだ応答中です — 停止するには右下の停止ボタン";
  } else {
    hint = "Very long wait";
    detail = "60秒超 — ネットワークか quota の問題の可能性があります";
  }
  const label = status || `${hint}…`;

  return (
    <div className="group">
      <div className="flex items-start gap-3">
        <div className="flex-none mt-0.5 text-[10px] uppercase tracking-wider text-subtle w-16">
          Agent
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="inline-flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" style={{ animationDelay: "150ms" }} />
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" style={{ animationDelay: "300ms" }} />
            </span>
            <span>{label}</span>
            <span className="tabular-nums text-subtle">{elapsed.toFixed(1)}s</span>
          </div>
          {detail && (
            <div className="text-[11px] text-subtle italic pl-5">{detail}</div>
          )}
          <div className="shimmer w-1/3" />
          <div className="shimmer w-3/4" />
          <div className="shimmer w-1/2" />
        </div>
      </div>
    </div>
  );
}

function BubbleView({
  b,
  streaming,
  onDecide,
  onEditArgs,
}: {
  b: Bubble;
  streaming: boolean;
  onDecide: (id: string, approved: boolean, editedArgs?: string) => void;
  onEditArgs: (id: string, v: string) => void;
}) {
  if (b.kind === "approval") {
    return <ApprovalCard b={b} onDecide={onDecide} onEditArgs={onEditArgs} />;
  }
  if (b.kind === "tool") {
    return <ToolCard b={b} />;
  }
  // text
  const isUser = b.role === "user";
  const hasReasoning = !isUser && !!b.reasoning && b.reasoning.trim().length > 0;
  return (
    <div className="group">
      <div className="flex items-start gap-3">
        <div className="flex-none mt-0.5 text-[10px] uppercase tracking-wider text-subtle w-16">
          {isUser ? "You" : "Agent"}
        </div>
        <div className="flex-1 min-w-0">
          {hasReasoning && <ReasoningBlock text={b.reasoning!} streaming={streaming && !b.text} />}
          {isUser ? (
            <div className="whitespace-pre-wrap text-sm">{b.text}</div>
          ) : b.text ? (
            <div className={`md text-sm ${streaming ? "streaming-caret" : ""}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {b.text}
              </ReactMarkdown>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  // While the model is actively thinking, show the reasoning *prominently*
  // so the user can watch it accumulate (no UX dead time). Once the final
  // answer starts streaming, collapse it to a small summary — user can
  // expand if they want to re-read the thinking.
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const open = userToggled ?? streaming;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll reasoning body to bottom as tokens arrive
  useEffect(() => {
    if (streaming && open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [text, streaming, open]);

  return (
    <details
      open={open}
      onToggle={(e) => setUserToggled((e.target as HTMLDetailsElement).open)}
      className={`mb-2 rounded-md overflow-hidden text-xs border ${
        streaming ? "border-accent/40 bg-accent/5" : "border-border bg-surface/40"
      }`}
    >
      <summary className="px-3 py-1.5 cursor-pointer select-none text-muted hover:text-text flex items-center gap-2">
        {streaming ? (
          <span className="inline-flex gap-1 mr-1">
            <span className="w-1 h-1 rounded-full bg-accent animate-pulse" />
            <span className="w-1 h-1 rounded-full bg-accent animate-pulse" style={{ animationDelay: "150ms" }} />
            <span className="w-1 h-1 rounded-full bg-accent animate-pulse" style={{ animationDelay: "300ms" }} />
          </span>
        ) : null}
        <span className="text-[10px] uppercase tracking-wider">
          {streaming ? "Thinking" : "Thought for a moment"}
        </span>
        <span className="text-subtle">({text.length.toLocaleString()} chars)</span>
      </summary>
      <div
        ref={scrollRef}
        className="px-3 py-2 text-muted whitespace-pre-wrap font-mono border-t border-border bg-bg max-h-64 overflow-y-auto leading-relaxed"
      >
        {text}
      </div>
    </details>
  );
}

function ToolCard({ b }: { b: ToolBubble }) {
  // Default: collapsed (one-line summary of name + args + elapsed).
  // User clicks to expand; preference remembered per card.
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const open = userToggled ?? false;

  // Live elapsed timer while running
  const [startedAt] = useState(() => Date.now());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!b.running) return;
    const h = window.setInterval(() => setTick((t) => t + 1), 100);
    return () => window.clearInterval(h);
  }, [b.running]);
  const elapsed = b.running ? (Date.now() - startedAt) / 1000 : null;

  return (
    <div className="flex items-start gap-3">
      <div className="flex-none mt-0.5 text-[10px] uppercase tracking-wider text-subtle w-16">
        Tool
      </div>
      <div className="flex-1 min-w-0">
        <button
          onClick={() => setUserToggled(open ? false : true)}
          className={`w-full text-left flex items-center gap-2 px-3 py-1.5 rounded-md bg-surface border text-xs transition ${
            b.running ? "border-warn/40" : "border-border hover:border-border-strong"
          }`}
        >
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${
              b.running ? "bg-warn animate-pulse" : "bg-success"
            }`}
          />
          <span className="font-mono text-accent">{b.name}</span>
          {!open && (
            <span className="text-muted truncate flex-1">{formatArgs(b.args)}</span>
          )}
          {open && <span className="flex-1" />}
          {b.running ? (
            <span className="text-warn text-[10px] tabular-nums">
              実行中 {elapsed != null ? elapsed.toFixed(1) : "0.0"}s
            </span>
          ) : (
            b.duration != null && (
              <span className="text-subtle text-[10px] tabular-nums">{b.duration.toFixed(1)}s</span>
            )
          )}
          <span className="text-subtle text-[10px]">{open ? "−" : "+"}</span>
        </button>

        {open && (
          <div className="mt-1.5 border border-border rounded-md bg-bg overflow-hidden">
            {/* Args block — always shown while expanded */}
            <div className="px-3 py-1.5 border-b border-border text-[10px] uppercase tracking-wider text-subtle bg-elevated/30 flex items-center">
              <span>Arguments</span>
              {b.running && (
                <span className="ml-auto flex items-center gap-1 text-warn normal-case tracking-normal">
                  <Spinner />
                  <span className="text-[10px]">running…</span>
                </span>
              )}
            </div>
            <pre className="px-3 py-2 text-[11px] text-muted overflow-x-auto whitespace-pre-wrap font-mono max-h-40">
              {JSON.stringify(b.args, null, 2)}
            </pre>
            {/* Result block — only after completion */}
            {b.result != null && (
              <>
                <div className="px-3 py-1.5 border-y border-border text-[10px] uppercase tracking-wider text-subtle bg-elevated/30">
                  Result
                </div>
                <pre className="px-3 py-2 text-[11px] text-muted overflow-x-auto max-h-72 whitespace-pre-wrap font-mono">
                  {b.result.length > 4000 ? b.result.slice(0, 4000) + "\n…(truncated)" : b.result}
                </pre>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin" width="10" height="10" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
      <path d="M21 12 A9 9 0 0 0 12 3" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function ApprovalCard({
  b,
  onDecide,
  onEditArgs,
}: {
  b: ApprovalBubble;
  onDecide: (id: string, approved: boolean, editedArgs?: string) => void;
  onEditArgs: (id: string, v: string) => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const originalJson = useMemo(() => JSON.stringify(b.args, null, 2), [b.args]);
  const current = b.editedArgs ?? originalJson;
  const edited = current !== originalJson;

  const statusStyles =
    b.status === "approved"
      ? "border-success/40 bg-success/5"
      : b.status === "rejected"
        ? "border-danger/40 bg-danger/5"
        : "border-warn/40 bg-warn/5";

  return (
    <div className="flex items-start gap-3">
      <div className="flex-none mt-0.5 text-[10px] uppercase tracking-wider text-warn w-16">
        Approval
      </div>
      <div className={`flex-1 rounded-lg border ${statusStyles} p-3`}>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm font-semibold">実行確認が必要です</span>
          <span className="font-mono text-xs text-accent">{b.name}</span>
          <span className="text-[10px] px-1.5 py-0.5 bg-elevated rounded text-muted">
            {b.sideEffect}
          </span>
          <span className="ml-auto text-[10px] text-muted">
            {b.status === "pending" ? "保留中" : b.status === "approved" ? "承認済み" : "拒否"}
          </span>
        </div>

        {showDiff && edited ? (
          <ArgsDiff original={originalJson} edited={current} />
        ) : (
          <textarea
            value={current}
            onChange={(e) => onEditArgs(b.approvalId, e.target.value)}
            disabled={b.status !== "pending"}
            rows={Math.min(12, current.split("\n").length + 1)}
            spellCheck={false}
            className="w-full bg-bg border border-border rounded-md font-mono text-xs p-2 resize-y disabled:opacity-60 outline-none focus:border-accent"
          />
        )}

        {b.status === "pending" && (
          <div className="flex gap-2 mt-2 items-center">
            <button
              onClick={() => onDecide(b.approvalId, true, current)}
              className="px-3 py-1.5 rounded-md bg-success/90 hover:bg-success text-white text-xs transition"
            >
              承認 {edited && "(編集後)"}
            </button>
            <button
              onClick={() => onDecide(b.approvalId, false)}
              className="px-3 py-1.5 rounded-md border border-border hover:bg-elevated text-xs transition"
            >
              拒否
            </button>
            {edited && (
              <button
                onClick={() => setShowDiff((v) => !v)}
                className="text-[11px] text-muted hover:text-text ml-auto"
              >
                {showDiff ? "編集に戻る" : "diff を表示"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ArgsDiff({ original, edited }: { original: string; edited: string }) {
  const oLines = original.split("\n");
  const eLines = edited.split("\n");
  const max = Math.max(oLines.length, eLines.length);
  const rows: Array<{ kind: "same" | "add" | "del" | "mod"; a: string; b: string }> = [];
  for (let i = 0; i < max; i++) {
    const a = oLines[i] ?? "";
    const b = eLines[i] ?? "";
    if (a === b) rows.push({ kind: "same", a, b });
    else if (!a) rows.push({ kind: "add", a, b });
    else if (!b) rows.push({ kind: "del", a, b });
    else rows.push({ kind: "mod", a, b });
  }
  return (
    <div className="bg-bg border border-border rounded-md overflow-hidden">
      <div className="grid grid-cols-2 text-[11px] font-mono">
        <div className="border-r border-border">
          <div className="px-2 py-1 bg-elevated text-subtle text-[10px] uppercase">元</div>
          {rows.map((r, i) => (
            <div
              key={i}
              className={`px-2 whitespace-pre ${
                r.kind === "del" || r.kind === "mod" ? "bg-danger/10 text-danger" : "text-muted"
              }`}
            >
              {r.a || " "}
            </div>
          ))}
        </div>
        <div>
          <div className="px-2 py-1 bg-elevated text-subtle text-[10px] uppercase">編集</div>
          {rows.map((r, i) => (
            <div
              key={i}
              className={`px-2 whitespace-pre ${
                r.kind === "add" || r.kind === "mod" ? "bg-success/10 text-success" : "text-muted"
              }`}
            >
              {r.b || " "}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${s.length > 50 ? s.slice(0, 47) + "…" : s}`;
    })
    .join(" ");
}
