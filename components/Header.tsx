"use client";
import React from 'react';
import { usePathname } from 'next/navigation';
import { Disclosure, DisclosureButton, DisclosurePanel, Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react'
import { Bars3Icon, XMarkIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import { useSession } from '@/context/SessionContext';

/**
 * Signed out: Home only, and "Sign in with Google" on the right.
 * Signed in (laptop / tablet): three menus, My Performance, My Live Trading and My Analysis, plus YouTube and the account.
 * Phone: the same pages one below the other (no nesting), and sign in / out at the bottom.
 */

interface Item { name: string; href: string }
const PERFORMANCE: Item[] = [
    { name: 'Home', href: '/' },
    { name: 'My Journal', href: '/journal' },
    { name: 'Fetch Today\'s Trades', href: '/sync-trades' },
];
const LIVE_TRADING: Item[] = [
    { name: 'Live', href: '/live' },
    { name: 'Co-pilot', href: '/copilot' },
    { name: 'Order Book', href: '/order-book' },
    { name: 'Backfill', href: '/backfill' },
    { name: 'Dhan login', href: '/dhan-login' },
];
const ANALYSIS: Item[] = [
    { name: 'My Stats', href: '/stats' },
    { name: 'My Setups', href: '/setups' },
    { name: 'Reversal Study', href: '/study' },
];
const YOUTUBE = 'https://www.youtube.com/@CandlesBeforeCubicles?sub_confirmation=1';

function classNames(...classes: (string | false | undefined)[]) {
    return classes.filter(Boolean).join(' ')
}

/** Google's "G", as Google's sign-in button guidelines draw it (on a white circle, for dark themes). */
export function GoogleG({ className = 'size-4' }: { className?: string }) {
    return (
        <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
        </svg>
    );
}

export function GoogleSignInButton({ onClick, wide = false }: { onClick: () => void; wide?: boolean }) {
    return (
        <button onClick={onClick}
            className={classNames('group inline-flex h-10 items-center gap-2.5 rounded-full border border-line-strong bg-brand-card pl-1.5 pr-4 text-sm font-semibold text-brand-text transition-colors hover:border-brand-accent hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/60', wide && 'w-full justify-center')}>
            <span className="flex size-7 items-center justify-center rounded-full bg-white"><GoogleG className="size-4" /></span>
            Sign in with Google
        </button>
    );
}

function Avatar({ picture, name }: { picture?: string; name?: string }) {
    // eslint-disable-next-line @next/next/no-img-element
    if (picture) return <img src={picture} alt="" referrerPolicy="no-referrer" className="size-7 rounded-full border border-line-strong" />;
    return <span className="flex size-7 items-center justify-center rounded-full bg-brand-accent text-xs font-black text-brand-bg">{(name ?? '?').slice(0, 1).toUpperCase()}</span>;
}

export default function Header() {
    const pathname = usePathname() || '/';
    const { status, owner, signIn, signOut } = useSession();
    const signedIn = status === 'owner';
    const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));
    const link = 'whitespace-nowrap rounded-md px-2.5 py-2 text-sm font-medium';
    const idle = 'text-gray-300 hover:bg-white/5 hover:text-white';
    const on = 'bg-gray-950/50 text-white';

    const group = (title: string, items: Item[]) => {
        const active = items.some((i) => isActive(i.href));
        return (
            <Menu as="div" className="relative">
                <MenuButton className={classNames(link, 'inline-flex items-center gap-1 focus:outline-none data-open:bg-white/5', active ? on : idle)}>
                    {title}
                    <ChevronDownIcon aria-hidden="true" className="size-4 transition-transform in-data-open:rotate-180" />
                </MenuButton>
                <MenuItems anchor="bottom end" transition
                    className="z-[60] mt-2 w-56 rounded-xl border border-line-strong bg-brand-bg/95 p-1.5 shadow-2xl backdrop-blur-md focus:outline-none transition duration-100 ease-out data-closed:scale-95 data-closed:opacity-0">
                    {items.map((i) => (
                        <MenuItem key={i.href}>
                            <a href={i.href} aria-current={isActive(i.href) ? 'page' : undefined}
                                className={classNames('flex items-center justify-between rounded-lg px-3 py-2 text-sm data-focus:bg-white/5 data-focus:text-white', isActive(i.href) ? 'text-brand-accent' : 'text-gray-300')}>
                                {i.name}
                                {isActive(i.href) && <span className="size-1.5 rounded-full bg-brand-accent" />}
                            </a>
                        </MenuItem>
                    ))}
                </MenuItems>
            </Menu>
        );
    };

    const flat = signedIn ? [...PERFORMANCE, ...LIVE_TRADING, ...ANALYSIS] : PERFORMANCE.slice(0, 1);

    return (
        <>
            {/* HEADER NAVIGATION */}
            <header className="sticky top-0 z-50 bg-brand-bg/50 backdrop-blur-md border-b border-brand-card/40 py-1 sm:py-2 relative">
                <div className="page-shell flex items-center justify-between gap-4">
                    <a href="/" className="flex shrink-0 items-center space-x-2">
                        <span className="font-mono text-xl font-bold tracking-tight hidden 2xl:block">
                            CANDLES<span className="text-brand-accent">BEFORE</span>CUBICLES
                        </span>
                        <span className="font-mono text-xl tracking-tight">
                            TRADER<span className="text-brand-accent">EYE</span>
                        </span>
                    </a>

                    <Disclosure as="nav" className="border-none">
                        <div className="relative flex h-16 items-center justify-between">
                            <div className="inset-y-0 left-0 flex items-center lg:hidden">
                                <DisclosureButton className="group relative inline-flex items-center justify-center rounded-md text-gray-400 hover:bg-white/5 hover:text-white focus:outline-2 focus:-outline-offset-1 focus:outline-indigo-500">
                                    <span className="absolute -inset-0.5" />
                                    <span className="sr-only">Open main menu</span>
                                    <Bars3Icon aria-hidden="true" className="block size-6 group-data-open:hidden" />
                                    <XMarkIcon aria-hidden="true" className="hidden size-6 group-data-open:block" />
                                </DisclosureButton>
                            </div>

                            {/* laptop / tablet */}
                            <div className="hidden lg:flex items-center gap-1">
                                {status === 'loading' ? null : signedIn ? (
                                    <>
                                        {group('My Performance', PERFORMANCE)}
                                        {group('My Live Trading', LIVE_TRADING)}
                                        {group('My Analysis', ANALYSIS)}
                                        <a href={YOUTUBE} target="_blank" rel="noopener noreferrer" className={classNames(link, idle)}>Youtube</a>
                                        <Menu as="div" className="relative ml-2">
                                            <MenuButton className="flex items-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/60" aria-label="Account">
                                                <Avatar picture={owner?.picture} name={owner?.name} />
                                            </MenuButton>
                                            <MenuItems anchor="bottom end" className="z-[60] mt-2 w-60 rounded-xl border border-line-strong bg-brand-bg/95 p-1.5 shadow-2xl backdrop-blur-md focus:outline-none">
                                                <div className="px-3 py-2">
                                                    <p className="text-sm font-semibold text-white">{owner?.name ?? 'Signed in'}</p>
                                                    <p className="truncate text-xs text-gray-400">{owner?.email}</p>
                                                </div>
                                                <MenuItem>
                                                    <button onClick={() => void signOut()} className="w-full rounded-lg px-3 py-2 text-left text-sm text-gray-300 data-focus:bg-white/5 data-focus:text-white">Log out</button>
                                                </MenuItem>
                                            </MenuItems>
                                        </Menu>
                                    </>
                                ) : (
                                    <>
                                        <a href="/" aria-current={isActive('/') ? 'page' : undefined} className={classNames(link, isActive('/') ? on : idle)}>Home</a>
                                        <span className="ml-3"><GoogleSignInButton onClick={() => signIn()} /></span>
                                    </>
                                )}
                            </div>
                        </div>

                        {/* phone: one list, no nesting */}
                        <DisclosurePanel className="lg:hidden absolute top-full left-0 right-0 z-50">
                            <div className="absolute inset-0 -z-10 bg-brand-bg/90 backdrop-blur-md border-b border-brand-card/40" />
                            <div className="px-6 py-3 space-y-1">
                                {status !== 'loading' && flat.map((item) => (
                                    <DisclosureButton key={item.href} as="a" href={item.href}
                                        aria-current={isActive(item.href) ? 'page' : undefined}
                                        className={classNames(isActive(item.href) ? on : idle, 'block rounded-md px-3 py-2 text-base font-medium')}>
                                        {item.name}
                                    </DisclosureButton>
                                ))}
                                {signedIn && (
                                    <DisclosureButton as="a" href={YOUTUBE} target="_blank" rel="noopener noreferrer" className={classNames(idle, 'block rounded-md px-3 py-2 text-base font-medium')}>Youtube</DisclosureButton>
                                )}
                                <div className="mt-2 border-t border-brand-card/60 pt-3">
                                    {status === 'loading' ? null : signedIn ? (
                                        <div className="flex items-center gap-3 px-1">
                                            <Avatar picture={owner?.picture} name={owner?.name} />
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate text-sm font-semibold text-white">{owner?.name ?? 'Signed in'}</p>
                                                <p className="truncate text-xs text-gray-400">{owner?.email}</p>
                                            </div>
                                            <button onClick={() => void signOut()} className="rounded-full border border-line-strong px-3 py-1.5 text-sm text-gray-300 hover:border-brand-accent hover:text-white">Log out</button>
                                        </div>
                                    ) : (
                                        <GoogleSignInButton onClick={() => signIn()} wide />
                                    )}
                                </div>
                            </div>
                        </DisclosurePanel>
                    </Disclosure>
                </div>
            </header>
        </>
    );
}
