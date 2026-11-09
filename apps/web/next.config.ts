import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  webpack(config) {
    // Workspace packages (e.g. @voiceover/audio) use NodeNext-style relative
    // imports ("./pcm.js") that point at sibling .ts files, which Node's own
    // resolver maps automatically but webpack doesn't by default — without
    // this, any *value* (non-type-only) import from such a package fails to
    // bundle with "Module not found: Can't resolve './whatever.js'".
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
