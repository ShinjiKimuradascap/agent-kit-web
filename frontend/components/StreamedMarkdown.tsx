"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

/**
 * Renders `text` as markdown with a typewriter effect when `streaming` is true.
 * When text grows (via new chunks), display catches up smoothly at ~120-250 chars/sec.
 * When `streaming` becomes false, the full text is shown immediately.
 */
export default function StreamedMarkdown({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const [display, setDisplay] = useState(text);
  const rafRef = useRef<number | null>(null);
  const targetRef = useRef(text);
  const displayLenRef = useRef(text.length);

  // Keep target in sync
  useEffect(() => {
    targetRef.current = text;
    if (!streaming) {
      // Flush immediately when streaming ends
      displayLenRef.current = text.length;
      setDisplay(text);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    // While streaming, advance display toward target via RAF
    if (rafRef.current != null) return; // loop already running

    let last = performance.now();
    const tick = (now: number) => {
      const target = targetRef.current;
      const behind = target.length - displayLenRef.current;
      if (behind <= 0) {
        rafRef.current = null;
        return;
      }
      const dt = Math.min(now - last, 64); // cap at 64ms to avoid huge jumps
      last = now;

      // Speed scales with how far behind we are (2x when >200 chars behind)
      const baseCps = 180; // chars per second baseline
      const boost = Math.min(3, 1 + behind / 150);
      const advance = Math.max(1, Math.round((dt / 1000) * baseCps * boost));
      const newLen = Math.min(target.length, displayLenRef.current + advance);
      displayLenRef.current = newLen;
      setDisplay(target.slice(0, newLen));

      if (newLen < targetRef.current.length) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [text, streaming]);

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
      {display}
    </ReactMarkdown>
  );
}
