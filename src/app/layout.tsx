import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./globals.css";
import { MantineProvider, ColorSchemeScript, createTheme } from "@mantine/core";
import { Notifications } from "@mantine/notifications";

const theme = createTheme({});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ByTime — DCAA-Compliant Timekeeping",
  description: "Modern timekeeping for Government Contractors",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head />
      <body>
        {/* ColorSchemeScript MUST be in <body> before MantineProvider — NOT in <head>.
            Placing it in <head> causes "Encountered a script tag" React errors in Next.js App Router.
            This is the Mantine v9 recommended pattern for Next.js. */}
        <ColorSchemeScript defaultColorScheme="auto" />
        <MantineProvider defaultColorScheme="auto" theme={theme}>
          <Notifications position="top-right" autoClose={4000} />
          {children}
        </MantineProvider>
      </body>
    </html>
  );
}
