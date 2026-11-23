import { defineConfig } from "tsup";

/**
 * The source imports the protocol code from the SDK's source folder, so the
 * repository type-checks without a build. In the published package the same
 * imports point at the `omnia-sdk` dependency: this plugin rewrites them.
 */
const sdkAsDependency = {
  name: "sdk-as-dependency",
  setup(build: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string }) => { path: string; external: boolean } | undefined) => void }) {
    build.onResolve({ filter: /sdk\/src\/[a-z0-9]+$/ }, (args) => {
      const name = args.path.split("/").pop() as string;
      return { path: name === "index" ? "omnia-sdk" : `omnia-sdk/${name}`, external: true };
    });
  },
};

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  dts: { resolve: false },
  clean: true,
  target: "es2022",
  platform: "neutral",
  esbuildPlugins: [sdkAsDependency],
});
