"use client";
import PostsTab from '@/components/posts/PostsTab';

/** Socials -> Posts: today's P&L post. Uses the YouTube and Instagram connections made on Shorts & Reels. */
export default function PostsPage() {
  return (
    <main className="page-shell py-8">
      <h1 className="text-2xl font-semibold text-white">Posts</h1>
      <p className="mt-1 text-sm text-ink-3">Today&apos;s P&amp;L post for Instagram and YouTube. Connections are managed on Shorts &amp; Reels.</p>
      <PostsTab />
    </main>
  );
}
