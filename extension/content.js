chrome.runtime.onMessage.addListener(async (message, _sender, sendResponse) => {
  try {
    const args = message.args ?? {};
    if (message.command === "observe") sendResponse(observe());
    else if (message.command === "getText") sendResponse({ text: document.body?.innerText ?? "" });
    else if (message.command === "getHtml") sendResponse({ html: document.documentElement.outerHTML });
    else if (message.command === "evaluate") sendResponse({ value: Function(`"use strict"; return (${String(args.expression)})`)() });
    else if (message.command === "click") { findTarget(args).click(); sendResponse({ clicked: true }); }
    else if (message.command === "type") { const element = findTarget(args); setValue(element, String(args.text ?? "")); sendResponse({ typed: true }); }
    else if (message.command === "key") { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: String(args.key), bubbles: true })); sendResponse({ pressed: args.key }); }
    else if (message.command === "scroll") { window.scrollTo({ top: Number(args.top ?? window.scrollY), left: Number(args.left ?? 0), behavior: "instant" }); sendResponse({ scrollY: window.scrollY }); }
    else if (message.command === "wait") { await new Promise((resolve) => setTimeout(resolve, Math.min(Number(args.ms ?? 250), 30000))); sendResponse({ waitedMs: Number(args.ms ?? 250) }); }
    else sendResponse({ error: `Unknown command: ${message.command}` });
  } catch (error) { sendResponse({ error: error instanceof Error ? error.message : String(error) }); }
  return true;
});

function findTarget(args) {
  if (args.ref) {
    const element = document.querySelector(`[data-agent-ref="${CSS.escape(String(args.ref))}"]`);
    if (element instanceof HTMLElement) return element;
  }
  if (args.x !== undefined && args.y !== undefined) {
    const element = document.elementFromPoint(Number(args.x), Number(args.y));
    if (element instanceof HTMLElement) return element;
  }
  const selector = args.selector;
  const element = document.querySelector(String(selector));
  if (!(element instanceof HTMLElement)) throw new Error(`Element not found: ${selector}`);
  return element;
}

function observe() {
  const candidates = document.querySelectorAll("a,button,input,textarea,select,[role],*[contenteditable='true']");
  const elements = [];
  let index = 0;
  for (const element of candidates) {
    if (!(element instanceof HTMLElement)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const ref = `e${index++}`;
    element.dataset.agentRef = ref;
    const attributes = {};
    for (const name of ["aria-label", "placeholder", "name", "type", "href"]) {
      const value = element.getAttribute(name);
      if (value) attributes[name] = value.slice(0, 200);
    }
    elements.push({
      ref,
      role: element.getAttribute("role") || element.tagName.toLowerCase(),
      text: (element.innerText || element.getAttribute("aria-label") || "").trim().slice(0, 300),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      attributes,
    });
  }
  return {
    url: location.href,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    elements,
  };
}
function setValue(element, value) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else element.textContent = value;
}
