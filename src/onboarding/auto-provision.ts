import * as cdp from "../background/cdp.js";
import { saveKey } from "../storage/keys.js";
import type { ProviderId } from "../shared/types.js";

export interface ProviderFlow {
  url: string;
  createSelector: string;
  keySelector: string;
  keyInputSelector?: string;
  confirmSelector?: string;
  waitMs?: number;
}

export const PROVIDER_FLOWS: Record<string, ProviderFlow> = {
  google: {
    url: "https://aistudio.google.com/apikey",
    createSelector: [
      "button[data-testid='create-api-key-button']",
      "[aria-label='Create API key']",
      "button.create-api-key",
      "button[class*=create][class*=api]",
    ].join(","),
    keySelector: [
      "code.api-key-value",
      "[data-testid='api-key-value']",
      "input[readonly][value^=AI]",
    ].join(","),
    keyInputSelector: "input[readonly][value^=AI]",
    waitMs: 4000,
  },
  groq: {
    url: "https://console.groq.com/keys",
    createSelector: [
      "button[data-testid='create-api-key']",
      "[aria-label='Create API Key']",
      "button.create-key-btn",
      "button[class*=create][class*=key]",
    ].join(","),
    keySelector: [
      "input[readonly][value^=gsk_]",
      "code.api-key",
      "[data-testid='api-key-display']",
    ].join(","),
    keyInputSelector: "input[readonly][value^=gsk_]",
    waitMs: 3000,
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTabLoad(tabId: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await sleep(200);
  }
  throw new Error("Tab did not finish loading within the timeout.");
}

interface DomOpResponse {
  ok: boolean;
  found?: boolean;
  escalate?: "cdp";
  error?: string;
  [k: string]: unknown;
}

async function domOp(
  tabId: number,
  op: string,
  args: Record<string, unknown> = {},
): Promise<DomOpResponse> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, {
      kind: "dom-op",
      payload: { op, ...args },
    })) as DomOpResponse | undefined;
    if (response == null)
      return { ok: false, error: "No response from content script (not injected?)" };
    return response;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function readElementText(
  tabId: number,
  selector: string,
): Promise<string | null> {
  const result = await domOp(tabId, "readText", { selector });
  if (result.ok && typeof result.text === "string" && (result.text as string).trim())
    return (result.text as string).trim();
  // Fall through to CDP Runtime.evaluate for input.value or textContent
  interface EvalResult { result?: { value?: string | null } }
  const expr = [
    "(function(){",
    "var el=document.querySelector(" + JSON.stringify(selector) + ");",
    "if(!el)return null;",
    "if(el.tagName===" + JSON.stringify("INPUT") + "||el.tagName===" + JSON.stringify("TEXTAREA") + ")return el.value||null;",
    "return el.textContent?el.textContent.trim():null;",
    "})()",
  ].join("");
  const evalResult = (await chrome.debugger.sendCommand(
    { tabId }, "Runtime.evaluate", { expression: expr, returnByValue: true },
  )) as EvalResult | undefined;
  const value = evalResult?.result?.value;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function clickSelector(tabId: number, selector: string): Promise<void> {
  const result = await domOp(tabId, "click", { selector });
  if (result.ok) return;
  // Escalate to CDP: try getElementCoords first, then Runtime.evaluate click
  const coordResult = (await chrome.tabs.sendMessage(tabId, {
    kind: "dom-op",
    payload: { op: "getElementCoords", selector },
  })) as { ok: boolean; x?: number; y?: number } | undefined;
  if (coordResult?.ok && coordResult.x != null && coordResult.y != null) {
    await cdp.dispatchClick(tabId, coordResult.x, coordResult.y);
    return;
  }
  const clickExpr =
    "(function(){var el=document.querySelector(" +
    JSON.stringify(selector) +
    ");if(el){el.click();return true;}return false;})()";
  await chrome.debugger.sendCommand(
    { tabId },
    "Runtime.evaluate",
    { expression: clickExpr, returnByValue: true },
  );
}

async function waitForElement(
  tabId: number,
  selector: string,
  timeoutMs = 10_000,
): Promise<void> {
  const result = await domOp(tabId, "waitForSelector", { selector, timeoutMs });
  if (!result.ok || result.found === false) {
    throw new Error(
      "Element not found within " + timeoutMs + "ms: " + selector +
      (result.error ? ". " + result.error : ""),
    );
  }
}

async function trySelectors(
  tabId: number,
  selectorList: string,
  timeoutEach = 5_000,
): Promise<string | null> {
  for (const sel of selectorList.split(",").map(s => s.trim()).filter(Boolean)) {
    try {
      await waitForElement(tabId, sel, timeoutEach);
      return sel;
    } catch {
      // try next selector
    }
  }
  return null;
}

function isLoginWall(provider: string, url: string): boolean {
  if (provider === "google") return url.includes("accounts.google.com");
  if (provider === "groq") {
    return (
      !url.startsWith("https://console.groq.com") &&
      (url.includes("login") || url.includes("signin") || url.includes("auth"))
    );
  }
  return false;
}

export type SupportedProvider = "google" | "groq";

export interface AutoProvisionResult {
  ok: boolean;
  keyId?: string;
  error?: string;
}

/**
 * autoProvision: Open the provider API-key dashboard, click Create, read the
 * generated key, persist it via saveKey(), and return the stored keyId.
 *
 * Graceful failure: every error path returns { ok:false, error } and the
 * finally block always detaches CDP and closes the tab.
 */
export async function autoProvision(
  provider: SupportedProvider | string,
): Promise<AutoProvisionResult> {
  const flow = PROVIDER_FLOWS[provider];
  if (!flow) {
    return {
      ok: false,
      error:
        "Unsupported provider " + JSON.stringify(provider) +
        ". Supported: " + Object.keys(PROVIDER_FLOWS).join(", ") + ".",
    };
  }
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url: flow.url, active: false });
    if (tab.id == null) throw new Error("chrome.tabs.create did not return a tab id.");
    tabId = tab.id;
    await waitForTabLoad(tabId);
    await cdp.attach(tabId);
    await sleep(1000);
    const currentTab = await chrome.tabs.get(tabId);
    if (isLoginWall(provider, currentTab.url ?? "")) {
      throw new Error(
        "Login required for " + provider +
        ". Please sign in in your browser first, then retry.",
      );
    }
    const createSel = await trySelectors(tabId, flow.createSelector, 5_000);
    if (!createSel) {
      throw new Error(
        "Could not find the Create API key button on " + flow.url +
        ". Possible causes: CAPTCHA, login wall, or the UI changed. " +
        "Selectors tried: " + flow.createSelector,
      );
    }
    await clickSelector(tabId, createSel);
    await sleep(flow.waitMs ?? 3000);
    if (flow.confirmSelector) {
      const confirmSel = await trySelectors(tabId, flow.confirmSelector, 3_000);
      if (confirmSel) {
        await clickSelector(tabId, confirmSel);
        await sleep(500);
      }
    }
    let apiKey: string | null = null;
    const keySel = await trySelectors(tabId, flow.keySelector, 5_000);
    if (keySel) apiKey = await readElementText(tabId, keySel);
    if (!apiKey && flow.keyInputSelector) {
      const inputSel = await trySelectors(tabId, flow.keyInputSelector, 3_000);
      if (inputSel) apiKey = await readElementText(tabId, inputSel);
    }
    if (!apiKey) {
      throw new Error(
        "The API key element was not found after creation. " +
        "The provider UI may have changed, or a CAPTCHA interrupted the flow.",
      );
    }
    if (apiKey.includes(" ") || apiKey.length < 8) {
      throw new Error(
        "Extracted key does not look valid: " + JSON.stringify(apiKey.slice(0, 20)),
      );
    }
    const keyId = await saveKey(provider as ProviderId, apiKey, "auto");
    return { ok: true, keyId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (tabId != null) {
      try { await cdp.detach(tabId); } catch { /* already detached */ }
      try { await chrome.tabs.remove(tabId); } catch { /* already closed */ }
    }
  }
}
