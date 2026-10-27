import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";
import "@mantine/notifications/styles.css";
import "mantine-react-table/styles.css";
import "./globals.css";
import { ColorSchemeScript } from "@mantine/core";
import { Providers } from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "CadenzPoint — DCAA-Compliant Timekeeping",
  description: "Modern timekeeping for Government Contractors",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${inter.variable}`} suppressHydrationWarning>
      <head />
      <body>
        {/* ColorSchemeScript MUST be in <body> before the Mantine providers — NOT in <head>.
            Placing it in <head> causes "Encountered a script tag" React errors in Next.js App Router.
            This is the Mantine v9 recommended pattern for Next.js. The providers live in ./providers
            (a client component), because this Server Component can't pass function props. */}
        <ColorSchemeScript defaultColorScheme="auto" />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
