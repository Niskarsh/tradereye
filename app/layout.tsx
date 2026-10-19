import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import { AuthProvider } from "@/context/AuthContext";
import { SessionProvider } from "@/context/SessionContext";
import { AuthNotice } from "@/components/auth/AuthNotice";
import Header from "@/components/Header";
import { ActivityBar } from "@/components/ui/ActivityBar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Trader's Eye - Your Trade Analytics Companion",
  description: "A powerful tool to analyze, visualize and journal your trading performance with ease.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-brand-bg">
        <SessionProvider>
          <AuthProvider>
            <ActivityBar />
            <Header />
            <AuthNotice />
            <main className="flex-1 overflow-auto md:ml-0">
              {children}
            </main>
          </AuthProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
