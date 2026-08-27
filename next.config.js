/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emits .next/standalone with a self-contained server.js — required for the
  // slim runtime stage in the Dockerfile. Without this the image has to carry
  // all of node_modules.
  output: 'standalone',
  reactStrictMode: true,

  turbopack: {
    // Next 16 builds with Turbopack, which infers the workspace root by walking
    // up the tree for a lock file. A stray package-lock.json in a parent
    // directory (e.g. the home dir) makes it pick the wrong root, which changes
    // what gets traced into .next/standalone. Pin it to this file's directory
    // so the build is identical here and inside the container.
    root: __dirname,
  },
};

module.exports = nextConfig;
