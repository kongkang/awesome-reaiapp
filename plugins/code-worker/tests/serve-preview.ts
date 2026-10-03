import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const result = await Bun.build({ entrypoints: [resolve(import.meta.dir, "preview.ts")], target: "browser", format: "esm", outdir: resolve(root, ".artifacts/preview"), naming: "[name].[ext]" });
if (!result.success) throw new Error(result.logs.map(String).join("\n"));
const assets = new Map(result.outputs.map(output => [`/${output.path.split("/").at(-1)}`, output]));
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/") return new Response(Bun.file(resolve(import.meta.dir, "preview.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
  const asset = assets.get(pathname);
  return asset ? new Response(asset, { headers: { "content-type": pathname.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" } }) : new Response("Not found", { status: 404 });
} });
console.log(`Isolated UI test harness (not Driver or an Agent service): http://127.0.0.1:${server.port}/`);
