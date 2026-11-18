import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "eTaxOptimize SA",
  description: "South African tax document preparation and estimation",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}