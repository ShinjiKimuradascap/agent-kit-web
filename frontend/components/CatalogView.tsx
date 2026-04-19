"use client";

import { useCallback, useEffect, useState } from "react";

type CatalogItem = {
  name: string;
  title?: string;
  description?: string;
  size?: number;
  updated_at?: number;
};

export default function CatalogView({ kind }: { kind: "skills" | "agents" }) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [originalContent, setOriginalContent] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>("");

  const loadList = useCallback(async () => {
    const r = await fetch(`/api/catalog/${kind}`);
    if (r.ok) setItems((await r.json()).items);
  }, [kind]);

  const openItem = async (name: string) => {
    const r = await fetch(`/api/catalog/${kind}/${name}`);
    if (!r.ok) return;
    const data = await r.json();
    setSelected(name);
    setContent(data.raw);
    setOriginalContent(data.raw);
    setMessage("");
  };

  const saveItem = async () => {
    if (!selected) return;
    setSaving(true);
    setMessage("");
    try {
      const r = await fetch(`/api/catalog/${kind}/${selected}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!r.ok) {
        const e = await r.json();
        setMessage(`Error: ${e.detail || r.status}`);
      } else {
        setOriginalContent(content);
        setMessage("保存しました");
        await loadList();
      }
    } finally {
      setSaving(false);
    }
  };

  const deleteItem = async () => {
    if (!selected) return;
    if (!confirm(`${selected}.md を削除しますか？`)) return;
    const r = await fetch(`/api/catalog/${kind}/${selected}`, { method: "DELETE" });
    if (r.ok) {
      setSelected(null);
      setContent("");
      setOriginalContent("");
      await loadList();
    }
  };

  const createNew = async () => {
    const name = prompt("新規ファイル名 (英数字 + - _ のみ):");
    if (!name) return;
    const tmpl =
      kind === "skills"
        ? `---\nname: ${name}\ndescription: このスキルの概要を書く\n---\n\n# ${name}\n\n## 手順\n\n1. ...\n`
        : `---\nname: ${name}\ndescription: このエージェントの概要を書く\ntools:\n  - websearch\n  - read_file\n---\n\nあなたは${name}エージェントです。`;
    const r = await fetch(`/api/catalog/${kind}/${name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: tmpl }),
    });
    if (!r.ok) {
      const e = await r.json();
      alert(`Error: ${e.detail || r.status}`);
      return;
    }
    await loadList();
    await openItem(name);
  };

  useEffect(() => {
    loadList();
  }, [loadList]);

  const dirty = content !== originalContent;

  return (
    <div className="flex h-full">
      <aside className="w-72 border-r border-border flex flex-col bg-surface/50">
        <div className="p-3 border-b border-border">
          <button
            onClick={createNew}
            className="w-full py-2 px-3 rounded-md bg-elevated hover:bg-border-strong text-sm transition"
          >
            + 新規作成
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {items.map((it) => (
            <button
              key={it.name}
              onClick={() => openItem(it.name)}
              className={`block w-full text-left px-3 py-2 hover:bg-elevated text-xs transition ${
                selected === it.name ? "bg-elevated border-l-2 border-accent" : ""
              }`}
            >
              <div className="font-mono text-text">{it.name}</div>
              <div className="text-subtle text-[10px] mt-0.5 truncate">
                {it.description || "(no description)"}
              </div>
            </button>
          ))}
          {items.length === 0 && (
            <div className="p-4 text-xs text-subtle">(アイテムなし)</div>
          )}
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        {selected ? (
          <>
            <div className="h-11 flex items-center px-4 border-b border-border text-sm bg-surface/50">
              <span className="font-mono">{selected}.md</span>
              {dirty && <span className="ml-2 text-warn text-xs">● 未保存</span>}
              {message && <span className="ml-4 text-xs text-success">{message}</span>}
              <div className="ml-auto flex gap-2">
                <button
                  onClick={saveItem}
                  disabled={!dirty || saving}
                  className="px-3 py-1 rounded-md bg-accent text-accent-fg disabled:opacity-40 text-xs transition"
                >
                  {saving ? "保存中…" : "保存 ⌘S"}
                </button>
                <button
                  onClick={deleteItem}
                  className="px-3 py-1 rounded-md border border-border hover:bg-elevated text-danger text-xs transition"
                >
                  削除
                </button>
              </div>
            </div>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                  e.preventDefault();
                  saveItem();
                }
              }}
              className="flex-1 bg-bg font-mono text-sm p-5 resize-none outline-none leading-relaxed"
              spellCheck={false}
            />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-subtle text-sm">
            左のリストから選ぶか、新規作成してください
          </div>
        )}
      </main>
    </div>
  );
}
