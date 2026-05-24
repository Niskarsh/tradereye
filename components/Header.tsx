"use client";
import React from 'react';

export default function Header() {

    return (
        <>
            {/* HEADER NAVIGATION */}
            <header className="sticky top-0 z-50 bg-brand-bg/80 backdrop-blur-md border-b border-brand-card/40 px-6 py-4">
                <div className="max-w-7xl mx-auto flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                        <span className="font-mono text-xl font-bold tracking-tight hidden md:block">
                            CANDLES<span className="text-brand-accent">BEFORE</span>CUBICLES
                        </span>
                        <span className="font-mono text-xl  tracking-tight">
                            TRADER<span className="text-brand-accent">EYE</span>
                        </span>
                    </div>
                    <nav className="hidden md:flex items-center space-x-8 text-sm font-medium tracking-wide">
                        <a href="/" className="hover:text-brand-accent transition-colors">Home</a>
                        <a href="/journal" className="hover:text-brand-accent transition-colors">My Journal</a>
                        <a href="/stats" className="hover:text-brand-accent transition-colors">My Stats</a>
                        <a href="https://youtube.com/@CandlesBeforeCubicles" target="_blank" rel="noopener noreferrer" className="hover:text-brand-accent transition-colors">YouTube</a>
                    </nav>
                </div>
            </header>
        </>
    );
}
