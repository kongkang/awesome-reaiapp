/** Wait briefly for a visible window, without making history depend on UI responsiveness.
 * The caller attaches delivery ACK to the original promise, so a timeout never means delivered.
 */
export async function waitForPresentation(presentation: Promise<unknown>, waitMs = 1_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      presentation.catch(() => undefined),
      new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
