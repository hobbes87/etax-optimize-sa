import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'eTaxOptimize SA | SARS Compliance & Guided eFiling Vault',
  description: 'POPIA-compliant South African tax optimization, source-code classification, and guided SARS eFiling execution.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-[#F4F6F9] text-slate-900 antialiased">{children}</body>
    </html>
  );
}
