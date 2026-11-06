import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Tap Rewards", template: "%s · Tap Rewards" },
  description: "Tap-to-open restaurant loyalty: points, streaks and rewards with no app to download.",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Rewards" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#fafafa",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-neutral-50 text-neutral-900">{children}</body>
    </html>
  );
}
