"use client";
import React from 'react';
import { Disclosure, DisclosureButton, DisclosurePanel } from '@headlessui/react'
import { Bars3Icon, XMarkIcon } from '@heroicons/react/24/outline'

export default function Header() {
    const navigation = [
        { name: 'Home', href: '/', current: false },
        { name: 'My Journal', href: '/journal', current: false },
        { name: 'My Stats', href: '/stats', current: false },
        { name: 'Fetch Today\'s Trades', href: '/sync-trades', current: false },
        { name: 'Youtube', href: 'https://www.youtube.com/@CandlesBeforeCubicles?sub_confirmation=1', current: false },
    ]

    function classNames(...classes: string[]) {
        return classes.filter(Boolean).join(' ')
    }

    function isUrl(hrefVal: string) {
        if (typeof window === 'undefined') return false;
        return window.location.href.endsWith(hrefVal);
    }

    return (
        <>
            {/* HEADER NAVIGATION */}
            <header className="sticky top-0 z-50 bg-brand-bg/50 backdrop-blur-md border-b border-brand-card/40 px-6 py-1 sm:py-2 relative">
                <div className="max-w-7xl mx-auto flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                        <span className="font-mono text-xl font-bold tracking-tight hidden md:block">
                            CANDLES<span className="text-brand-accent">BEFORE</span>CUBICLES
                        </span>
                        <span className="font-mono text-xl tracking-tight">
                            TRADER<span className="text-brand-accent">EYE</span>
                        </span>
                    </div>

                    <Disclosure as="nav" className="border-none">
                        <div className="mx-auto border-none max-w-7xl sm:px-2 sm:px-6 lg:px-8">
                            <div className="relative flex border-none h-16 items-center justify-between">
                                <div className="inset-y-0 left-0 flex items-center sm:hidden">
                                    <DisclosureButton className="group relative inline-flex items-center justify-center rounded-md text-gray-400 hover:bg-white/5 hover:text-white focus:outline-2 focus:-outline-offset-1 focus:outline-indigo-500">
                                        <span className="absolute -inset-0.5" />
                                        <span className="sr-only">Open main menu</span>
                                        <Bars3Icon aria-hidden="true" className="block size-6 group-data-open:hidden" />
                                        <XMarkIcon aria-hidden="true" className="hidden size-6 group-data-open:block" />
                                    </DisclosureButton>
                                </div>
                                <div className="flex flex-1 items-center justify-center sm:items-stretch sm:justify-start">
                                    <div className="hidden sm:ml-6 sm:block">
                                        <div className="flex space-x-4">
                                            {navigation.map((item) => (
                                                <a
                                                    key={item.name}
                                                    href={item.href}
                                                    target={(item.name === "Youtube") ? "_blank" : undefined}
                                                    rel="noopener noreferrer"
                                                    aria-current={isUrl(item.href) ? 'page' : undefined}
                                                    className={classNames(
                                                        isUrl(item.href) ? 'bg-gray-950/50 text-white' : 'text-gray-300 hover:bg-white/5 hover:text-white',
                                                        'rounded-md px-3 py-2 text-sm font-medium',
                                                    )}
                                                >
                                                    {item.name}
                                                </a>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* FIXED: The panel handles the absolute boundary, while a child pseudo-background div 
                            replicates the exact glass properties of the header cleanly over the page body.
                        */}
                        <DisclosurePanel className="sm:hidden absolute top-full left-0 right-0 z-50">
                            {/* Background Layer mimicking the header glass identically */}
                            <div className="absolute inset-0 -z-10 bg-brand-bg/90 backdrop-blur-md border-b border-brand-card/40" />

                            {/* Inner content container */}
                            <div className="px-6 py-3 space-y-1">
                                {navigation.map((item) => (
                                    <DisclosureButton
                                        key={item.name}
                                        as="a"
                                        href={item.href}
                                        target={(item.name === "Youtube") ? "_blank" : undefined}
                                        rel="noopener noreferrer"
                                        aria-current={isUrl(item.href) ? 'page' : undefined}
                                        className={classNames(
                                            isUrl(item.href) ? 'bg-gray-950/50 text-white' : 'text-gray-300 hover:bg-white/5 hover:text-white',
                                            'block rounded-md px-3 py-2 text-base font-medium',
                                        )}
                                    >
                                        {item.name}
                                    </DisclosureButton>
                                ))}
                            </div>
                        </DisclosurePanel>
                    </Disclosure>
                </div>
            </header>
        </>
    );
}