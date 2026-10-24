import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // the Socials page used to be /youtube: keep old links and bookmarks working
  async redirects() {
    return [{ source: '/youtube', destination: '/socials', permanent: false }];
  },
};

export default nextConfig;
