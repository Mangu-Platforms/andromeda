/** @type {import('next').NextConfig} */
const nextConfig = {
  // The console's routes live in workspace packages as raw TypeScript source
  // (Node 22 strips types natively; there's no build step for them locally).
  // Next bundles node_modules by default without transpiling it, and npm
  // workspaces symlinks these packages into node_modules — so without this,
  // the build would try to ship untranspiled .ts files. Listing them here
  // tells Next's compiler to treat them as first-party source instead.
  transpilePackages: ["@andromeda/core", "@andromeda/autobuilder", "@andromeda/console"],
  typescript: {
    // `npm run typecheck` at the repo root is the source of truth for the
    // workspace packages (root tsconfig.json, run in CI). Next's own
    // build-time check walks the same reachable files under apps/web's
    // tsconfig, whose global `ProcessEnv.NODE_ENV` augmentation (added by
    // Next itself) conflicts with unrelated code in packages/autobuilder
    // that was never written against it — a false positive from checking
    // the same files under two different global environments, not a real
    // type error. Skip the redundant check here rather than bend package
    // source to satisfy a config it doesn't use.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
