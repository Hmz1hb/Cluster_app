/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emits .next/standalone with a self-contained server.js — required for the
  // slim runtime stage in the Dockerfile. Without this the image has to carry
  // all of node_modules.
  output: 'standalone',
  reactStrictMode: true,
};

module.exports = nextConfig;
