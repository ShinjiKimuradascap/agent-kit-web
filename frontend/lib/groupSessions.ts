export type SessionItem = {
  session_id: string;
  agent: string;
  updated: string;
  created?: string;
  preview?: string;
};

export type SessionGroup = { label: string; items: SessionItem[] };

export function groupSessionsByDate(sessions: SessionItem[]): SessionGroup[] {
  const now = new Date();
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday0 = today0 - 86_400_000;
  const week0 = today0 - 7 * 86_400_000;

  const buckets: Record<string, SessionItem[]> = {
    "今日": [],
    "昨日": [],
    "直近7日": [],
    "それ以前": [],
  };

  for (const s of sessions) {
    const t = Date.parse(s.updated.replace(" ", "T"));
    if (Number.isNaN(t)) {
      buckets["それ以前"].push(s);
      continue;
    }
    if (t >= today0) buckets["今日"].push(s);
    else if (t >= yesterday0) buckets["昨日"].push(s);
    else if (t >= week0) buckets["直近7日"].push(s);
    else buckets["それ以前"].push(s);
  }

  return Object.entries(buckets)
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => ({ label, items }));
}
