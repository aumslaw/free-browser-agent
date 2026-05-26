/**
 * CDP escalation wrapper using chrome.debugger
 *
 * Used when content-script DOM ops return {ok:false, escalate:"cdp"} — e.g.
 * cross-origin iframes, isTrusted-required events, or screenshot requests.
 *
 * Lifecycle: attach → use → detach. The caller (agent-loop) is responsible
 * for calling detach() after the task is done or on error.
 */

/** Tracks which tabs currently have the debugger attached */
const attachedTabs = new Set<number>();

/**
 * Attach the Chrome Debugger to a tab.
 * Safe to call multiple times — skips if already attached.
 */
export async function attach(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabs.add(tabId);
}

/**
 * Detach the Chrome Debugger from a tab.
 * Safe to call if not attached.
 */
export async function detach(tabId: number): Promise<void> {
  if (!attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } finally {
    attachedTabs.delete(tabId);
  }
}

/**
 * Capture a screenshot of the given tab as a base64 PNG.
 * Attaches debugger if needed.
 */
export async function screenshot(tabId: number): Promise<{ data: string }> {
  await attach(tabId);
  const result = (await chrome.debugger.sendCommand(
    { tabId },
    "Page.captureScreenshot",
    { format: "png", quality: 80 }
  )) as { data: string };
  return { data: result.data };
}

/**
 * Dispatch a mouse click at (x, y) in viewport coordinates.
 * Sends mousePressed followed by mouseReleased to simulate a full click.
 */
export async function dispatchClick(
  tabId: number,
  x: number,
  y: number
): Promise<void> {
  await attach(tabId);

  const baseParams = {
    type: "mousePressed" as const,
    x,
    y,
    button: "left" as const,
    clickCount: 1,
    modifiers: 0,
  };

  await chrome.debugger.sendCommand(
    { tabId },
    "Input.dispatchMouseEvent",
    { ...baseParams, type: "mousePressed" }
  );
  await chrome.debugger.sendCommand(
    { tabId },
    "Input.dispatchMouseEvent",
    { ...baseParams, type: "mouseReleased" }
  );
}

/**
 * Dispatch a key event (keyDown + keyUp).
 * `key` should be a DOM key value, e.g. "Enter", "Tab", "a", etc.
 */
export async function dispatchKey(
  tabId: number,
  key: string
): Promise<void> {
  await attach(tabId);

  const params: Record<string, unknown> = { key };

  // For printable single characters, also set text so the page receives input
  if (key.length === 1) {
    params.text = key;
  }

  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    ...params,
    type: "keyDown",
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    ...params,
    type: "keyUp",
  });
}

/**
 * Type a string character-by-character via CDP key events.
 * Useful for inputs that require isTrusted events.
 */
export async function typeText(tabId: number, text: string): Promise<void> {
  await attach(tabId);
  for (const char of text) {
    await dispatchKey(tabId, char);
    // Small delay to avoid overwhelming the renderer
    await new Promise<void>((r) => setTimeout(r, 20));
  }
}

/**
 * Listen for debugger detach events (e.g. user closes DevTools) and clean up
 * our tracking set so re-attach works correctly.
 */
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) {
    attachedTabs.delete(source.tabId);
  }
});
