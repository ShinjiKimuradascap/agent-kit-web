"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Command = {
  id: string;
  label: string;
  hint?: string;
  group: string;
  action: () => void;
};

export default function CommandPalette({
  open,
  onClose,
  sessions,
  agents,
  skills,
  onOpenSession,
  onSwitchAgent,
  onInsertSkillRef,
  onNewChat,
}: {
  open: boolean;
  onClose: () => void;
  sessions: { session_id: string; agent: string; preview?: string }[];
  agents: { name: string; description?: string }[];
  skills: { name: string; description?: string }[];
  onOpenSession: (sid: string) => void;
  onSwitchAgent: (name: string) => void;
  onInsertSkillRef: (name: string) => void;
  onNewChat: () => void;
}) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const commands: Command[] = useMemo(() => {
    const list: Command[] = [
      {
        id: "new",
        label: "新しいチャット",
        hint: "⌘N",
        group: "Action",
        action: onNewChat,
      },
      {
        id: "go-skills",
        label: "Skills",
        group: "Navigation",
        action: () => router.push("/skills"),
      },
      {
        id: "go-agents",
        label: "Agents",
        group: "Navigation",
        action: () => router.push("/agents"),
      },
    ];
    for (const a of agents) {
      list.push({
        id: `agent-${a.name}`,
        label: `Agent: ${a.name}`,
        hint: a.description,
        group: "Switch Agent",
        action: () => onSwitchAgent(a.name),
      });
    }
    for (const s of skills) {
      list.push({
        id: `skill-${s.name}`,
        label: `Skill: ${s.name}`,
        hint: s.description,
        group: "Insert Skill",
        action: () => onInsertSkillRef(s.name),
      });
    }
    for (const ses of sessions.slice(0, 20)) {
      list.push({
        id: `ses-${ses.session_id}`,
        label: ses.preview || "(新規)",
        hint: `${ses.agent} · ${ses.session_id.slice(0, 8)}`,
        group: "Session",
        action: () => onOpenSession(ses.session_id),
      });
    }
    return list;
  }, [agents, skills, sessions, onOpenSession, onSwitchAgent, onInsertSkillRef, onNewChat, router]);

  const filtered = useMemo(() => {
    if (!q.trim()) return commands;
    const needle = q.toLowerCase();
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(needle) ||
        (c.hint || "").toLowerCase().includes(needle) ||
        c.group.toLowerCase().includes(needle),
    );
  }, [commands, q]);

  useEffect(() => {
    setIdx(0);
  }, [q]);

  if (!open) return null;

  const runIndex = (i: number) => {
    const c = filtered[i];
    if (!c) return;
    c.action();
    onClose();
  };

  // Group for display
  const grouped: Record<string, { cmd: Command; absoluteIdx: number }[]> = {};
  filtered.forEach((c, i) => {
    (grouped[c.group] = grouped[c.group] || []).push({ cmd: c, absoluteIdx: i });
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-32 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-surface border border-border-strong rounded-lg shadow-pop overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter" && !(e as any).nativeEvent.isComposing) {
              e.preventDefault();
              runIndex(idx);
            }
          }}
          placeholder="コマンド検索…  session / agent / skill / navigation"
          className="w-full bg-transparent px-4 py-3 text-sm border-b border-border outline-none"
        />
        <div className="max-h-[60vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted">該当なし</div>
          ) : (
            Object.entries(grouped).map(([group, items]) => (
              <div key={group} className="py-1">
                <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-subtle">
                  {group}
                </div>
                {items.map(({ cmd, absoluteIdx }) => (
                  <button
                    key={cmd.id}
                    onMouseEnter={() => setIdx(absoluteIdx)}
                    onClick={() => runIndex(absoluteIdx)}
                    className={`w-full text-left px-4 py-1.5 flex items-center gap-3 text-sm ${
                      absoluteIdx === idx ? "bg-elevated" : "hover:bg-elevated/50"
                    }`}
                  >
                    <span className="flex-1 truncate">{cmd.label}</span>
                    {cmd.hint && (
                      <span className="text-xs text-muted truncate max-w-[200px]">
                        {cmd.hint}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="px-4 py-2 border-t border-border bg-elevated/30 text-[11px] text-muted flex gap-4">
          <span>↑↓ 移動</span>
          <span>↵ 実行</span>
          <span>esc 閉じる</span>
        </div>
      </div>
    </div>
  );
}
