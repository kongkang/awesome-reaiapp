import { resolve } from "node:path";

// Run from the Voice plugin root with --audio <downloaded WAV>. Loopback-only, fixed routes.
const audioArg = process.argv.indexOf("--audio");
if (audioArg < 0 || !process.argv[audioArg + 1]) throw new Error("Pass --audio <speech.wav>");
const audio = Bun.file(resolve(process.argv[audioArg + 1]));
if (!await audio.exists()) throw new Error("Audio file does not exist");
const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "main.ts")], target: "browser" });
if (!build.success) throw new Error(build.logs.map(String).join("\n"));
const javascript = build.outputs.find((file) => file.path.endsWith(".js"))!;
const routes = new Map<string, Blob>([
  ["/", Bun.file(resolve(import.meta.dir, "index.html"))],
  ["/voice.css", Bun.file(resolve(import.meta.dir, "../../../src/voice.css"))],
  ["/main.js", javascript],
  ["/speech.wav", audio],
]);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const file = routes.get(new URL(request.url).pathname);
  return file ? new Response(file, { headers: { "Cache-Control": "no-store" } }) : new Response("Not found", { status: 404 });
} });
console.log(`A02 player fixture: ${server.url}`);
