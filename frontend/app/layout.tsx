import "./globals.css";
import type { Metadata } from "next";
import NavBar from "@/components/NavBar";

export const metadata: Metadata = {
  title: "agent-kit-web",
  description: "Chat + skills + workflows on top of agent-kit",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="bg-bg text-zinc-100 antialiased h-screen flex flex-col">
        <NavBar />
        <div className="flex-1 overflow-hidden">{children}</div>
      </body>
    </html>
  );
}
