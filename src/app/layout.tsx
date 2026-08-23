import type { Metadata } from "next";
import { Inter } from "next/font/google";
import AmplifyProvider from "@/src/lib/amplify/AmplifyProvider";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "業務 Web アプリ",
  description: "Amplify Gen 2 業務 Web アプリテンプレート",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body className={inter.className}>
        <AmplifyProvider>{children}</AmplifyProvider>
      </body>
    </html>
  );
}
