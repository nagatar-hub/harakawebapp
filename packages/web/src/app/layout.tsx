import type { Metadata } from 'next';
import { BottomNav } from '@/components/bottom-nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Haraka',
  description: '買取表自動生成システム',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="text-text-primary min-h-screen pb-28">
        <main className="mx-auto max-w-6xl px-6 pt-10 md:px-10">{children}</main>
        <BottomNav />
      </body>
    </html>
  );
}
