import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");

export default defineConfig({
  resolve: { alias: { "@": root } },
  test: { include: ["test/**/*.test.ts", "src/app/**/*.test.{ts,tsx}"] },
});
