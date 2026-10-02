/**
 * Runs in the Figma page's main world for one export, injected with chrome.scripting. It keeps the
 * Blob Figma hands to URL.createObjectURL and, when Figma clicks a download link for it, posts the
 * file to the content script instead of letting the browser save it. It also posts a short note for
 * each way Figma tries to hand a file over, so an export that brings no file can say what Figma did.
 * It reads nothing else and puts the original functions back after the export or after `windowMs`.
 * Must stay self-contained, because Chrome serializes it.
 */
export function installExportCapture(token: string, windowMs: number): void {
  interface Hook {
    token: string;
    restore: () => void;
  }
  const host = window as unknown as { __figlooExportCapture?: Hook };
  host.__figlooExportCapture?.restore();
  const blobs = new Map<string, Blob>();
  const create = URL.createObjectURL;
  const click = HTMLAnchorElement.prototype.click;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const open = window.open;
  const page = window as unknown as { showSaveFilePicker?: (...args: unknown[]) => unknown };
  const picker = page.showSaveFilePicker;
  const isDownload = (target: unknown): target is HTMLAnchorElement =>
    target instanceof HTMLAnchorElement && target.hasAttribute("download") && /^(blob|data):/.test(target.href);
  const scheme = (url: string) => /^[a-z][a-z0-9+.-]*:/i.exec(url)?.[0] ?? "a relative URL";
  const note = (text: string) => window.postMessage({ __figlooExportNote: token, note: text }, window.location.origin);
  const noteLink = (anchor: HTMLAnchorElement, how: string) => {
    if (anchor.hasAttribute("download") || /^(blob|data):/.test(anchor.href)) note(`${how} on a link ${anchor.hasAttribute("download") ? "with" : "without"} download to ${scheme(anchor.href)}`);
  };
  const hand = async (anchor: HTMLAnchorElement): Promise<boolean> => {
    try {
      const blob = blobs.get(anchor.href) ?? (await (await fetch(anchor.href)).blob());
      const data = await blob.arrayBuffer();
      window.postMessage({ __figlooExport: token, name: anchor.download, type: blob.type, data }, window.location.origin, [data]);
      return true;
    } catch {
      return false;
    }
  };
  URL.createObjectURL = function (object: Blob | MediaSource): string {
    const url = create.call(URL, object);
    if (object instanceof Blob) {
      blobs.set(url, object);
      note(`a Blob of ${object.type || "no type"}, ${object.size} bytes`);
    }
    return url;
  };
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement): void {
    noteLink(this, "click()");
    if (!isDownload(this)) return click.call(this);
    const anchor = this;
    void hand(anchor).then((captured) => {
      if (!captured) click.call(anchor);
    });
  };
  EventTarget.prototype.dispatchEvent = function (this: EventTarget, event: Event): boolean {
    if (event.type === "click" && this instanceof HTMLAnchorElement) noteLink(this, "a click event");
    if (event.type !== "click" || !isDownload(this)) return dispatch.call(this, event);
    const anchor = this;
    void hand(anchor).then((captured) => {
      if (!captured) dispatch.call(anchor, event);
    });
    return true;
  };
  window.open = function (url?: string | URL, ...rest: unknown[]) {
    note(`window.open to ${scheme(String(url ?? ""))}`);
    return (open as (...args: unknown[]) => Window | null).call(window, url, ...rest);
  } as typeof window.open;
  if (picker) {
    page.showSaveFilePicker = function (...args: unknown[]) {
      note("the save file picker");
      return picker.apply(window, args);
    };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hook: Hook = {
    token,
    // Only the active hook restores, so an earlier export's timer cannot undo a later export's hook.
    restore: () => {
      if (host.__figlooExportCapture !== hook) return;
      clearTimeout(timer);
      URL.createObjectURL = create;
      HTMLAnchorElement.prototype.click = click;
      EventTarget.prototype.dispatchEvent = dispatch;
      window.open = open;
      if (picker) page.showSaveFilePicker = picker;
      delete host.__figlooExportCapture;
    },
  };
  host.__figlooExportCapture = hook;
  timer = setTimeout(hook.restore, windowMs);
}

export function removeExportCapture(token: string): void {
  const host = window as unknown as { __figlooExportCapture?: { token: string; restore: () => void } };
  if (host.__figlooExportCapture?.token === token) host.__figlooExportCapture.restore();
}
