import esbuild from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [join(root, "server.ts")],
  outfile: join(root, "dist/server.js"),
  bundle: true,
  format: "esm",
  platform: "node",
});

await esbuild.build({
  entryPoints: [join(root, "web/index.tsx")],
  outfile: join(root, "dist/web.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  external: ["react", "react-dom", "react/jsx-runtime", "@qube-code/extension-sdk/web"],
});
