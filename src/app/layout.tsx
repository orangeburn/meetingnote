import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "MeetingNote",
  description: "Meeting speech-to-text app"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
