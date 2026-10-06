/** Observe a bounded set of actual SheetJS stub assignments in a disposable realm. */
export function observeHyperlinkStubs() {
  let assignments = 0;
  const addresses = Array.from({ length: 1000 }, (_, index) => `A${index + 2}`);
  for (const address of addresses) {
    if (Object.hasOwn(Object.prototype, address)) throw new Error("Hyperlink observer property already exists");
    Object.defineProperty(Object.prototype, address, {
      configurable: true,
      enumerable: false,
      get() { return undefined; },
      set(value: unknown) {
        if (value && typeof value === "object" && (value as { t?: string }).t === "z" && (value as { v?: unknown }).v === undefined) assignments++;
        Object.defineProperty(this, address, { value, configurable: true, enumerable: true, writable: true });
      },
    });
  }
  return { get assignments() { return assignments; }, cleanup() { for (const address of addresses) delete (Object.prototype as Record<string, unknown>)[address]; } };
}
