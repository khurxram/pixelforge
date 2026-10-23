// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

// PixelForge is a client-side SPA: Astro serves as the (Vite-powered) build
// shell. "/" is the editorial landing page; the React editor mounts on
// "/editor".
export default defineConfig({
  integrations: [react()],
  prefetch: true,
  vite: {
    build: {
      target: 'es2022',
      rollupOptions: {
        output: {
          /* Split the framework out of the app bundle: React and the icon set
             change far less often than PixelForge's own code, so hashing them
             separately keeps those bytes stable across deploys and lets
             Cloudflare serve them immutable for a year. */
          manualChunks(id) {
            const p = id.replace(/\\/g, '/');
            if (
              p.includes('/node_modules/react/') ||
              p.includes('/node_modules/react-dom/') ||
              p.includes('/node_modules/scheduler/')
            ) {
              return 'react';
            }
            if (p.includes('/node_modules/lucide-react/')) return 'icons';
            return undefined;
          },
        },
      },
    },
  },
});
