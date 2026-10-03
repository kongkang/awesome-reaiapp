/**
 * 语言适配：唯一资源源是包内 `assets/locales/{zh,en}.json`，此处不持久化
 * 任何语言偏好。未知语言一律回退英文；缺键再回退英文资源，仍缺则告警并
 * 返回键名（发布门禁不允许出现后者）。
 */
import zh from "../assets/locales/zh.json";
import en from "../assets/locales/en.json";

type Dictionary = { [key: string]: string | Dictionary };

let locale: "zh" | "en" = "zh";
const missing = new Set<string>();

export function setBrowserLocale(value: string): boolean {
  const next = value === "zh" ? "zh" : "en";
  const changed = next !== locale;
  locale = next;
  return changed;
}

export function browserLocale(): "zh" | "en" {
  return locale;
}

export function t(
  key: string,
  params: Readonly<Record<string, string | number>> = {},
): string {
  const lookup = (dict: Dictionary): string | undefined => {
    let value: string | Dictionary | undefined = dict;
    for (const part of key.split(".")) {
      value = typeof value === "object" ? value[part] : undefined;
    }
    return typeof value === "string" ? value : undefined;
  };
  const resolved = lookup(locale === "zh" ? zh : en) ?? lookup(en);
  if (resolved === undefined && !missing.has(key)) {
    missing.add(key);
    console.warn(`[browser:i18n] Missing message: ${key}`);
  }
  // 单次替换：插值参数只按普通文本显示，不作为消息或 HTML 再解析。
  return (resolved ?? key).replace(
    /\{([A-Za-z][A-Za-z0-9_]*)\}/g,
    (token, name: string) =>
      Object.hasOwn(params, name) ? String(params[name]) : token,
  );
}
