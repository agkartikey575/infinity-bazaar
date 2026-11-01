import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Fonts ship with the app (latin, variable weight; SIL Open Font License, see app/fonts),
// so builds need no network and text never waits on a font server.
const display = localFont({ src: "./fonts/unbounded.woff2", weight: "500 800", display: "swap", variable: "--font-display" });
const body = localFont({ src: "./fonts/figtree.woff2", weight: "400 700", display: "swap", variable: "--font-body" });
const mono = localFont({ src: "./fonts/jetbrains-mono.woff2", weight: "400 800", display: "swap", variable: "--font-mono" });

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
