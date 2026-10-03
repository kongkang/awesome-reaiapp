/** Language resources are package data; this validator does not execute a message engine. */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import type { Finding } from "@reai/app-cli/validate";
import targets from "@reai/app-contract/i18n-targets.json";

export const I18N_CAPABILITY = "metadata.i18n@1";
export const I18N_V2_CAPABILITY = "metadata.i18n@2";
export const LOCALE_MAX_BYTES = 256 * 1024;
export interface MetadataReference { target: string; id?: string; index?: number; key: string }
export interface I18nDeclaration { locales: string[]; messages: MetadataReference[] }
type Json = Record<string, unknown>;
const object = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const segment = /^[A-Za-z][A-Za-z0-9_]*$/;
const language = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const keyPath = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;
export const metadataId = (r: Pick<MetadataReference, "target" | "id" | "index">) => r.id === undefined && r.index === undefined ? r.target : `${r.target}:${r.id ?? r.index}`;
interface TargetDefinition { target: string; field?: string; collection?: string; singleton?: string; owner?: string; indexed?: boolean; version?: number; maxCharacters?: number }
const definitions: TargetDefinition[] = targets;
function supportsV2(manifest: Json): boolean {
  const caps = object(manifest.requires) ? manifest.requires.hostCapabilities : undefined;
  return manifest.packageType !== "skin" && Array.isArray(caps) && caps.includes(I18N_V2_CAPABILITY);
}
function finding(detail: string, pointer = "i18n", code: Finding["code"] = "MANIFEST_SCHEMA_INVALID"): Finding { return { code, pointer, detail }; }

export function metadataTargets(manifest: Json): Map<string, string> {
  const result = new Map<string, string>();
  const contributes = object(manifest.contributes) ? manifest.contributes : {};
  for (const definition of definitions) {
    if (definition.version === 2 && !supportsV2(manifest)) continue;
    const source = definition.owner === "manifest" ? manifest : definition.owner ? manifest[definition.owner] : contributes;
    if (definition.collection) {
      const entries = object(source) ? source[definition.collection] : undefined;
      if (Array.isArray(entries)) for (const [index, entry] of entries.entries()) {
        const text = definition.field && object(entry) ? entry[definition.field] : entry;
        const id = definition.indexed ? index : object(entry) ? entry.id : undefined;
        if ((typeof id === "string" || typeof id === "number") && typeof text === "string") result.set(`${definition.target}:${id}`, text);
      }
    } else {
      const owner = definition.singleton ? contributes[definition.singleton] : definition.owner ? source : manifest;
      if (definition.field && object(owner) && typeof owner[definition.field] === "string") result.set(definition.target, owner[definition.field] as string);
    }
  }
  return result;
}

export function validateI18nDeclaration(manifest: Json): Finding[] {
  if (manifest.i18n === undefined) return [];
  const out: Finding[] = [];
  const declaration = manifest.i18n;
  if (!object(declaration) || Object.keys(declaration).some(k => !["locales", "messages"].includes(k))) return [finding("i18n must contain only locales and messages")];
  const locales = declaration.locales;
  if (!Array.isArray(locales) || locales.length > 16 || !locales.includes("zh") || !locales.includes("en") || locales.some(l => typeof l !== "string" || !language.test(l)) || new Set(locales).size !== locales.length) out.push(finding("locales must include unique zh and en language tags (at most 16)"));
  const caps = object(manifest.requires) ? manifest.requires.hostCapabilities : undefined;
  if (manifest.packageType !== "skin" && (!Array.isArray(caps) || (!caps.includes(I18N_CAPABILITY) && !caps.includes(I18N_V2_CAPABILITY)))) out.push(finding(`i18n requires ${I18N_CAPABILITY} or ${I18N_V2_CAPABILITY}`, "requires.hostCapabilities", "MANIFEST_REFERENCE_INVALID"));
  const messages = declaration.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 512) return [...out, finding("messages must contain 1–512 references")];
  const available = metadataTargets(manifest);
  const seen = new Set<string>();
  for (const raw of messages) {
    if (!object(raw) || Object.keys(raw).some(k => !["target", "id", "index", "key"].includes(k)) || typeof raw.target !== "string" || typeof raw.key !== "string" || !keyPath.test(raw.key) || (raw.id !== undefined && (typeof raw.id !== "string" || !raw.id.length)) || (raw.index !== undefined && (!Number.isSafeInteger(raw.index) || (raw.index as number) < 0))) { out.push(finding("invalid metadata reference")); continue; }
    const definition = definitions.find(d => d.target === raw.target);
    if (definition?.indexed ? raw.id !== undefined || raw.index === undefined : raw.index !== undefined || (definition?.collection ? raw.id === undefined : raw.id !== undefined)) { out.push(finding("metadata reference must use its declared ID or zero-based position", "i18n.messages", "MANIFEST_REFERENCE_INVALID")); continue; }
    const id = metadataId(raw as unknown as MetadataReference);
    if (!available.has(id)) out.push(finding(`unknown metadata target ${id}`, "i18n.messages", "MANIFEST_REFERENCE_INVALID"));
    if (seen.has(id)) out.push(finding(`duplicate metadata target ${id}`, "i18n.messages", "MANIFEST_DUPLICATE_ID"));
    seen.add(id);
  }
  for (const id of available.keys()) if (!seen.has(id)) out.push(finding(`missing metadata target ${id}`, "i18n.messages", "MANIFEST_REFERENCE_INVALID"));
  return out;
}

/** JSON.parse checks syntax; a lexical walk retains duplicate (including escaped) object keys. */
export function parseMessages(bytes: Uint8Array): Map<string, string> {
  if (bytes.byteLength > LOCALE_MAX_BYTES) throw new Error("locale exceeds 256 KiB");
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  JSON.parse(source);
  let at = 0;
  const flat = new Map<string, string>();
  const whitespace = () => { while (/\s/.test(source[at] ?? "") && at < source.length) at++; };
  const string = (): string => {
    const start = at++;
    while (at < source.length) {
      if (source[at] === "\\") { at += 2; continue; }
      if (source[at++] === '"') {
        const value: string = JSON.parse(source.slice(start, at));
        if ([...value].some(c => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff)) throw new Error("unpaired Unicode surrogate");
        return value;
      }
    }
    throw new Error("unterminated string");
  };
  const visit = (path: string, depth: number) => {
    if (depth > 16) throw new Error("locale exceeds 16 levels");
    whitespace();
    if (source[at] === '"' && path) {
      const message = string();
      if (!message.trim()) throw new Error(`empty message ${path}`);
      messageVariables(message);
      flat.set(path, message);
      return;
    }
    if (source[at++] !== "{") throw new Error(`expected object/string at ${path}`);
    whitespace();
    if (source[at] === "}") throw new Error(`empty object at ${path}`);
    const keys = new Set<string>();
    while (true) {
      whitespace();
      if (source[at] !== '"') throw new Error("expected object key");
      const key = string();
      if (!segment.test(key)) throw new Error(`invalid key segment ${key}`);
      if (keys.has(key)) throw new Error(`duplicate key ${key}`);
      keys.add(key);
      whitespace(); at++; // colon was checked by JSON.parse
      visit(path ? `${path}.${key}` : key, depth + 1);
      whitespace();
      if (source[at++] === "}") break;
    }
  };
  visit("", 0);
  whitespace();
  if (at !== source.length) throw new Error("trailing data");
  return flat;
}

export function messageVariables(message: string): string[] {
  if (/<\/?[A-Za-z][^>]*>/.test(message) || message.includes("|") || /@(?:\.|:)/.test(message)) throw new Error("only plain text and named interpolation are supported");
  const variables = [...message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(m => m[1]!);
  if (/[{}]/.test(message.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, ""))) throw new Error("invalid interpolation");
  return [...new Set(variables)].sort();
}

/** Reader abstraction also validates the exact byte buffers passed to ZIP, without rereading source. */
export function validateLocaleBytes(manifest: Json, files: Map<string, Uint8Array>, required = false): Finding[] {
  const declared = manifest.i18n as I18nDeclaration | undefined;
  const paths = [...files.keys()].filter(p => p.startsWith("assets/locales/") && p.endsWith(".json"));
  if (!declared && !paths.length && !required) return [];
  const out = validateI18nDeclaration(manifest);
  if (required && !declared) out.push(finding("new releases must declare i18n metadata"));
  if (out.length) return out;
  const locales = new Set(["zh", "en", ...(declared?.locales ?? []), ...paths.map(p => p.slice(15, -5))]);
  if (locales.size > 16) return [finding("at most 16 languages are supported")];
  const parsed = new Map<string, Map<string, string>>();
  for (const locale of locales) {
    const path = `assets/locales/${locale}.json`;
    try {
      if (!language.test(locale)) throw new Error("invalid language filename");
      const bytes = files.get(path);
      if (!bytes) throw new Error("missing language file");
      parsed.set(locale, parseMessages(bytes));
    } catch (error) { out.push(finding(String(error), path)); }
  }
  const english = parsed.get("en");
  if (!english) return out;
  for (const [locale, messages] of parsed) {
    if ([...messages.keys()].sort().join("\n") !== [...english.keys()].sort().join("\n")) out.push(finding("language leaf paths differ", `assets/locales/${locale}.json`));
    for (const [key, value] of messages) {
      const fallback = english.get(key);
      if (fallback !== undefined && messageVariables(value).join() !== messageVariables(fallback).join()) out.push(finding(`interpolation differs: ${key}`, `assets/locales/${locale}.json`));
    }
    for (const ref of declared?.messages ?? []) {
      const value = messages.get(ref.key);
      const limit = definitions.find(target => target.target === ref.target)?.maxCharacters;
      if (value && limit !== undefined && Array.from(value).length > limit) out.push(finding(`metadata exceeds ${limit} characters: ${ref.target}`, `assets/locales/${locale}.json`, "MANIFEST_REFERENCE_INVALID"));
      if (!value || new TextEncoder().encode(value).byteLength > 1024 || messageVariables(value).length) out.push(finding(`metadata requires a complete, non-interpolated message: ${ref.key}`, `assets/locales/${locale}.json`, "MANIFEST_REFERENCE_INVALID"));
    }
  }
  return out;
}

export function validateLocaleDirectory(root: string, manifest: Json, required = false): Finding[] {
  const directory = join(root, "assets/locales");
  const files = new Map<string, Uint8Array>();
  try {
    if (existsSync(directory)) {
      const canonicalRoot = realpathSync(root);
      const names = readdirSync(directory).filter(name => name.endsWith(".json"));
      if (names.length > 16) return [finding("at most 16 languages are supported")];
      for (const name of names) {
        const path = join(directory, name);
        const rel = relative(canonicalRoot, realpathSync(path));
        if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("locale escapes package root");
        if (statSync(path).size > LOCALE_MAX_BYTES) return [finding("locale exceeds 256 KiB", `assets/locales/${name}`)];
        files.set(`assets/locales/${name}`, readFileSync(path));
      }
    }
    return validateLocaleBytes(manifest, files, required);
  } catch (error) { return [finding(String(error), "assets/locales", "PACKAGE_PATH_UNSAFE")]; }
}
