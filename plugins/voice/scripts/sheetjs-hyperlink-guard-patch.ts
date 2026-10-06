import { createHash } from "node:crypto";
export const SHEETJS_UPSTREAM_SHA256 = "1a0fb062ee9781b13f6687371b202aaefc53b6ce55b530c027e01f9c087b77db";
export const SHEETJS_HYPERLINK_GUARD_REQUIRED = "VOICE_SHEETJS_HYPERLINK_GUARD_REQUIRED";

/** Add callbacks to the real loops. Keep upstream decoding and dispatch unchanged. */
export function patchSheetjsHyperlinkGuard(source: string): string {
  if (createHash("sha256").update(source).digest("hex") !== SHEETJS_UPSTREAM_SHA256) throw new Error("Pinned SheetJS source mismatch");
  const replace = (before: string, after: string, expected = 1) => {
    if (source.split(before).length - 1 !== expected) throw new Error(`SheetJS hyperlink patch anchor mismatch: ${before}`);
    source = source.split(before).join(after);
  };
  replace("parse_ws_xml_hlinks(s, hlink, rels)", "parse_ws_xml_hlinks(s, hlink, rels, opts)");
  replace("function parse_ws_xml_hlinks(s, data/*:Array<string>*/, rels) {", "function parse_ws_xml_hlinks(s, data/*:Array<string>*/, rels, opts) {");
  replace("var rng = safe_decode_range(val.ref);\n\t\tfor(var R=rng.s.r;", "var rng = safe_decode_range(val.ref);\n\t\topts.voiceHyperlinkRangeGuard(s, {kind:'range', range:rng, expands:true});\n\t\tfor(var R=rng.s.r;");
  replace("\t\t\t\tfor(R=val.rfx.s.r;R<=val.rfx.e.r;++R)", "\t\t\t\topts.voiceHyperlinkRangeGuard(s, {kind:'range', range:val.rfx, expands:true});\n\t\t\t\tfor(R=val.rfx.s.r;R<=val.rfx.e.r;++R)");
  replace("\t\t\t\telse s[encode_col(C) + rr] = p;", "\t\t\t\telse { var _vaddr = encode_col(C) + rr; opts.voiceHyperlinkRangeGuard(s, {kind:'cell', address:_vaddr}); s[_vaddr] = p; }", 2);
  for (const record of ["case 0x01b8 /* HLink */: {", "case 0x0800 /* HLinkTooltip */: {"]) {
    replace(record, `${record}\n\t\t\t\t\toptions.voiceHyperlinkRangeGuard(out, {kind:'range', range:val[0], expands:false});`);
  }
  replace("\t\tparse_sheet_legacy_drawing(_ws, stype, zip, path, idx, opts, wb, comments);", "\t\tparse_sheet_legacy_drawing(_ws, stype, zip, path, idx, opts, wb, comments);\n\t\topts.voiceHyperlinkRangeGuard(_ws, {kind:'complete'});");
  replace("function readSync(data/*:RawData*/, opts/*:?ParseOpts*/)/*:Workbook*/ {\n\treset_cp();", `function readSync(data/*:RawData*/, opts/*:?ParseOpts*/)/*:Workbook*/ {\n\tif (!opts || opts.dense !== false || typeof opts.voiceHyperlinkRangeGuard !== 'function' || typeof opts.voiceHyperlinkRangeGuard.check !== 'function') throw new Error('${SHEETJS_HYPERLINK_GUARD_REQUIRED}');\n\treset_cp();`);
  return source;
}

export async function buildVoiceSheetjsReader(upstream: string): Promise<string> {
  const patched = patchSheetjsHyperlinkGuard(upstream);
  const wrapper = `import {read as upstreamRead, utils} from 'voice-patched-sheetjs.mjs';\nexport {utils};\nexport function read(data, opts) { try { return upstreamRead(data, opts); } finally { if (typeof opts?.voiceHyperlinkRangeGuard?.check === 'function') opts.voiceHyperlinkRangeGuard.check(); } }`;
  const build = await Bun.build({ entrypoints: ["voice-sheetjs-reader.mjs"], target: "browser", format: "esm", minify: true, plugins: [{ name: "voice-sheetjs-hyperlink", setup(builder) {
    builder.onResolve({ filter: /^voice-(?:sheetjs-reader|patched-sheetjs)\.mjs$/ }, args => ({ path: args.path, namespace: "voice-sheetjs" }));
    builder.onLoad({ filter: /.*/, namespace: "voice-sheetjs" }, args => ({ contents: args.path === "voice-sheetjs-reader.mjs" ? wrapper : patched, loader: "js" }));
  } }] });
  if (!build.success || build.outputs.length !== 1) throw new Error(`SheetJS reader build failed: ${build.logs.join("\n")}`);
  return upstream.slice(0, upstream.indexOf("\n")) + "\n" + await build.outputs[0]!.text();
}
