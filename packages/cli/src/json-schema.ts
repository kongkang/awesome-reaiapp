/**
 * JSON Schema 校验器（只覆盖我们自己的 schema 用到的那部分）。
 *
 * 为什么不引第三方库：这份 schema 是我们写的，用到的关键字就下面这些。为一个封闭
 * 的、自己控制的输入引入一个通用库，等于把「最小依赖」换成「多一条供应链」，而
 * 换来的能力我们一条都用不上。
 *
 * 覆盖的关键字：`type` / `required` / `properties` / `additionalProperties: false` /
 * `items` / `enum` / `const` / `pattern` / `minLength` / `minItems` / `maxItems` /
 * `uniqueItems` / `minimum` / `maximum` / `maxLength`。
 * 出现未支持的关键字时**不静默跳过**，直接报错——静默跳过意味着 schema 写了约束
 * 而校验器当没看见，正是这份合同明令禁止的失败模式。
 */

const SUPPORTED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "description",
  "type",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "pattern",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minimum",
  "maximum",
]);

export interface SchemaViolation {
  /** 出问题的位置，形如 `contributes.commands[0].timeoutMs`。 */
  pointer: string;
  message: string;
}

export function validateAgainstSchema(value: unknown, schema: unknown): SchemaViolation[] {
  const out: SchemaViolation[] = [];
  walk(value, schema, "", out);
  return out;
}

function walk(value: unknown, schema: unknown, pointer: string, out: SchemaViolation[]): void {
  if (typeof schema !== "object" || schema === null) return;
  const s = schema as Record<string, unknown>;

  for (const keyword of Object.keys(s)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      out.push({
        pointer: pointer || "(根)",
        message: `schema 用了本校验器不支持的关键字 ${keyword}；不静默跳过，请扩展校验器或改写 schema`,
      });
    }
  }

  const at = pointer || "(根)";

  if ("const" in s && !deepEqual(value, s["const"])) {
    out.push({ pointer: at, message: `必须是 ${JSON.stringify(s["const"])}` });
    return;
  }

  if (Array.isArray(s["enum"]) && !s["enum"].some((allowed) => deepEqual(value, allowed))) {
    out.push({ pointer: at, message: `必须是 ${JSON.stringify(s["enum"])} 之一` });
    return;
  }

  const type = s["type"];
  if (typeof type === "string" && !matchesType(value, type)) {
    out.push({ pointer: at, message: `类型必须是 ${type}，实际是 ${describeType(value)}` });
    return;
  }

  if (typeof value === "string") {
    const minLength = s["minLength"];
    if (typeof minLength === "number" && value.length < minLength) {
      out.push({ pointer: at, message: `长度至少 ${minLength}` });
    }
    const maxLength = s["maxLength"];
    if (typeof maxLength === "number" && value.length > maxLength) {
      out.push({ pointer: at, message: `长度最多 ${maxLength}` });
    }
    const pattern = s["pattern"];
    if (typeof pattern === "string" && !new RegExp(pattern).test(value)) {
      out.push({ pointer: at, message: `不满足格式 ${pattern}` });
    }
  }

  if (typeof value === "number") {
    const minimum = s["minimum"];
    if (typeof minimum === "number" && value < minimum) {
      out.push({ pointer: at, message: `必须大于或等于 ${minimum}` });
    }
    const maximum = s["maximum"];
    if (typeof maximum === "number" && value > maximum) {
      out.push({ pointer: at, message: `必须小于或等于 ${maximum}` });
    }
  }

  if (Array.isArray(value)) {
    const minItems = s["minItems"];
    if (typeof minItems === "number" && value.length < minItems) {
      out.push({ pointer: at, message: `至少要有 ${minItems} 项` });
    }
    const maxItems = s["maxItems"];
    if (typeof maxItems === "number" && value.length > maxItems) {
      out.push({ pointer: at, message: `最多只能有 ${maxItems} 项` });
    }
    if (s["uniqueItems"] === true) {
      const duplicate = value.findIndex((item, index) =>
        value.slice(0, index).some((previous) => deepEqual(previous, item)),
      );
      if (duplicate >= 0) {
        out.push({ pointer: `${pointer}[${duplicate}]`, message: "数组项不能重复" });
      }
    }
    if (s["items"]) {
      value.forEach((item, i) => walk(item, s["items"], `${pointer}[${i}]`, out));
    }
    return;
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(s["properties"]) ? s["properties"] : {};

    for (const key of (s["required"] as string[] | undefined) ?? []) {
      if (!(key in value)) {
        out.push({ pointer: join(pointer, key), message: "必填字段缺失" });
      }
    }

    if (s["additionalProperties"] === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          out.push({
            pointer: join(pointer, key),
            message: "未知字段。合同禁止「写了但被静默忽略」，请删掉或改正拼写",
          });
        }
      }
    }

    for (const [key, sub] of Object.entries(properties)) {
      if (key in value) walk(value[key], sub, join(pointer, key), out);
    }
  }
}

function join(pointer: string, key: string): string {
  return pointer ? `${pointer}.${key}` : key;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
