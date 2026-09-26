import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Figtree, Caveat } from "next/font/google";
import { SmoothScroll } from "@/ui/motion/SmoothScroll";
import "./globals.css";

const display = Bricolage_Grotesque({ variable: "--font-display", subsets: ["latin"], weight: ["700", "800"] });
const body = Figtree({ variable: "--font-body", subsets: ["latin"], weight: ["500", "600", "700", "800"] });
const hand = Caveat({ variable: "--font-hand", subsets: ["latin"], weight: ["500", "600", "700"] });

export const metadata: Metadata = {
  title: "SecondHand Safe: the money waits for the camera",
  description:
    "Buying used baby gear from a stranger? SecondHand Safe holds your Visa payment until a camera reads the label at pickup and checks it against real CPSC and NHTSA recalls and banned product types.",
  metadataBase: new URL(process.env.PUBLIC_BASE_URL ?? "http://localhost:3000"),
};

export const viewport: Viewport = { themeColor: "#ffb020" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${hand.variable}`} suppressHydrationWarning>
      <head>
        {/* Mark JS + motion before paint so reveal targets start hidden only when they will animate. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "if(!window.matchMedia('(prefers-reduced-motion: reduce)').matches)document.documentElement.classList.add('js-motion')",
          }}
        />
      </head>
      <body>
        <SmoothScroll>{children}</SmoothScroll>
      </body>
    </html>
  );
}
