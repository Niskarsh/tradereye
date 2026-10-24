import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Public privacy policy. Google's OAuth consent screen and Meta's Instagram app both need a public link to one before
 * tradereye can post Shorts and Reels. Listed in PUBLIC_PAGES (lib/auth/gate.ts); everything else stays owner-only.
 */
export const metadata: Metadata = { title: "Privacy Policy - Trader's Eye" };

const UPDATED = '24 October 2026';

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 text-sm leading-6 text-zinc-300">
      <h1 className="mb-1 text-2xl font-semibold text-zinc-100">Privacy Policy</h1>
      <p className="mb-8 text-zinc-500">Last updated {UPDATED}</p>

      <Section title="Who uses this app">
        Trader&apos;s Eye is a private trading journal and publishing tool run by the owner of the Candles Before Cubicles
        channel. Only that one owner can sign in. There are no other users, accounts or sign-ups.
      </Section>

      <Section title="What data it accesses">
        <ul className="list-disc space-y-1 pl-5">
          <li><b>Google sign-in:</b> the owner&apos;s email address and Google account ID, only to confirm the owner is the one signing in.</li>
          <li><b>YouTube:</b> permission to upload videos to the owner&apos;s own channel, set their title, description, tags and publish time, and read the channel&apos;s basic details and view counts.</li>
          <li><b>Instagram:</b> permission to publish Reels to the owner&apos;s own professional account and read their view counts.</li>
        </ul>
      </Section>

      <Section title="How it is used">
        Only to publish the owner&apos;s own trading videos at the times the owner chooses, and to show how they performed.
        Nothing is posted without the owner approving it first. No data is used for advertising, profiling or training
        AI models.
      </Section>

      <Section title="Storage and sharing">
        Access tokens are stored encrypted in the owner&apos;s private cloud storage and are used only by this app. No data
        is sold, rented or shared with anyone. Video text may be drafted with Anthropic&apos;s Claude API from the owner&apos;s
        own trade data; no Google or Instagram account data is sent to it.
      </Section>

      <Section title="Google API data">
        Trader&apos;s Eye&apos;s use of information received from Google APIs adheres to the{' '}
        <a className="text-amber-400 underline" href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer">
          Google API Services User Data Policy
        </a>, including the Limited Use requirements.
      </Section>

      <Section title="Removing access and data">
        Access can be removed at any time from your Google account&apos;s{' '}
        <a className="text-amber-400 underline" href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer">third-party connections</a>{' '}
        page or from Instagram&apos;s Apps and websites settings. When access is removed, the stored tokens are deleted.
      </Section>

      <Section title="Contact">
        Message @candlesbeforecubicles on Instagram or YouTube.
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-base font-semibold text-zinc-100">{title}</h2>
      <div>{children}</div>
    </section>
  );
}
