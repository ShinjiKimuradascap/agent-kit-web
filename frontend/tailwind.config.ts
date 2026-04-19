import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Linear-inspired dark palette
        bg: "#08090a",        // app background
        surface: "#0f1011",   // panels, cards
        elevated: "#16171a",  // hovered / active
        border: "#1d1e22",    // subtle divider
        "border-strong": "#26272b",
        text: "#f4f4f5",
        muted: "#8a8f98",     // secondary text
        subtle: "#5c6069",    // tertiary
        accent: "#5e6ad2",    // Linear purple-blue
        "accent-fg": "#ffffff",
        success: "#4cb782",
        warn: "#e2a458",
        danger: "#e5484d",
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Hiragino Kaku Gothic ProN",
          "Helvetica Neue",
          "sans-serif",
        ],
        mono: [
          "SF Mono",
          "JetBrains Mono",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      boxShadow: {
        soft: "0 1px 2px rgba(0,0,0,0.2), 0 1px 3px rgba(0,0,0,0.15)",
        pop: "0 6px 24px rgba(0,0,0,0.4), 0 2px 6px rgba(0,0,0,0.3)",
      },
      transitionDuration: {
        DEFAULT: "150ms",
      },
      animation: {
        shimmer: "shimmer 1.6s ease-in-out infinite",
        caret: "caret 1s ease-in-out infinite",
      },
      keyframes: {
        shimmer: {
          "0%, 100%": { opacity: "0.3" },
          "50%": { opacity: "0.9" },
        },
        caret: {
          "0%, 50%": { opacity: "1" },
          "50.01%, 100%": { opacity: "0" },
        },
      },
    },
  },
  plugins: [],
};
export default config;
