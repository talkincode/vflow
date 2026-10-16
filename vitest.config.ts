import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@video-compose/protocol": path.resolve(
        import.meta.dirname,
        "packages/protocol/src/index.ts",
      ),
      "@video-compose/domain": path.resolve(
        import.meta.dirname,
        "packages/domain/src/index.ts",
      ),
      "@video-compose/client": path.resolve(
        import.meta.dirname,
        "packages/client/src/index.ts",
      ),
      "@video-compose/api": path.resolve(
        import.meta.dirname,
        "apps/api/src/index.ts",
      ),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
