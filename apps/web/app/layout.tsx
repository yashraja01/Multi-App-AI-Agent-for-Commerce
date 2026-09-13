import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

/*
 * IBM Plex Mono for every column that holds a number, Plex Sans as the body
 * fallback.
 *
 * Mono is the display face, not the utility face. This is an instrument that
 * reads amounts in cents; the type should look like it was made to hold digits.
 */

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
  display: "swap",
});

/*
 * TASA Orbiter, in two cuts.
 *
 * Display carries headlines and the big figures; Text carries body copy and
 * labels. That is what the cuts are drawn for -- Display is tighter and more
 * mannered at size, Text keeps its counters open at 13px -- and using one for
 * both would waste half the family.
 *
 * Plex Mono still sets every money column: tabular figures are worth more than
 * voice in a table.
 */
const display = localFont({
  src: [
    { path: "./fonts/TASAOrbiterDisplay-Medium.otf", weight: "500", style: "normal" },
    { path: "./fonts/TASAOrbiterDisplay-SemiBold.otf", weight: "600", style: "normal" },
  ],
  variable: "--font-display-face",
  display: "swap",
});

const orbiterText = localFont({
  src: [
    { path: "./fonts/TASAOrbiterText-Regular.otf", weight: "400", style: "normal" },
    { path: "./fonts/TASAOrbiterText-Medium.otf", weight: "500", style: "normal" },
    { path: "./fonts/TASAOrbiterText-SemiBold.otf", weight: "600", style: "normal" },
  ],
  variable: "--font-body-face",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Mercury Mission Control",
  description:
    "Two AI agents negotiate. A deterministic gate decides whether a single dollar may move.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${mono.variable} ${sans.variable} ${display.variable} ${orbiterText.variable}`}
    >
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
