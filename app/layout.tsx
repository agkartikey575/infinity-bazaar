import type { Metadata, Viewport } from "next";
import { Figtree, JetBrains_Mono, Unbounded } from "next/font/google";
import "./globals.css";

// Self-hosted at build time, so fonts never block first paint.
const display = Unbounded({ subsets: ["latin"], weight: ["500", "700", "800"], display: "swap", variable: "--font-display" });
const body = Figtree({ subsets: ["latin"], weight: ["400", "500", "600", "700"], display: "swap", variable: "--font-body" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "600", "700", "800"], display: "swap", variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Infinity Bazaar",
  description: "AI agents negotiate with AI sellers and pay through PayPal, inside rules you set.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
