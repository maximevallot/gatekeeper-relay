import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    // Wrangler bundles prompts/*.md as text through its "rules"; this does the same for Vite.
    {
      name: "markdown-as-text",
      enforce: "pre",
      transform(code, id) {
        if (id.endsWith(".md")) return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { ANTHROPIC_API_KEY: "sk-ant-test-not-a-real-key" },
        kvNamespaces: ["SORT_CACHE"],
      },
    }),
  ],
});
