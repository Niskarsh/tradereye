"use client";
import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X, Home, BookOpen } from 'lucide-react';

export default function Sidebar() {
  const [isOpen, setIsOpen] = useState(false);
  const pathname = usePathname();

  const toggleSidebar = () => {
    setIsOpen(!isOpen);
  };

  const isActive = (path: string) => pathname === path;

  return (
    <>
      {/* Mobile Menu Button */}
      <button
        onClick={toggleSidebar}
        className="md:hidden fixed top-4 left-4 z-40 p-2 bg-slate-800 text-white rounded-lg hover:bg-slate-700"
        aria-label="Toggle menu"
      >
        {isOpen ? <X size={24} /> : <Menu size={24} />}
      </button>

      {/* Overlay for mobile */}
      {isOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-30"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`fixed md:static top-0 left-0 h-screen md:h-screen w-64 bg-slate-900 text-white transition-transform duration-300 z-30 md:z-0 flex flex-col ${
          isOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
      >
        {/* Logo/Header */}
        <div className="p-6 border-b border-slate-700">
          <h1 className="text-2xl font-bold text-cyan-400">TraderEye</h1>
          <p className="text-xs text-slate-400 mt-1">Trade Analytics</p>
        </div>

        {/* Navigation Menu */}
        <nav className="flex-1 px-4 py-6 space-y-2">
          <Link href="/" onClick={() => setIsOpen(false)}>
            <div
              className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                isActive('/')
                  ? 'bg-cyan-600 text-white'
                  : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Home size={20} />
              <span className="font-medium">Home</span>
            </div>
          </Link>

          <Link href="/journal" onClick={() => setIsOpen(false)}>
            <div
              className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                isActive('/journal')
                  ? 'bg-cyan-600 text-white'
                  : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              <BookOpen size={20} />
              <span className="font-medium">Journal</span>
            </div>
          </Link>
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-slate-700 text-xs text-slate-400">
          <p>© 2024 TraderEye</p>
        </div>
      </div>
    </>
  );
}
