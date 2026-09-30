/**
 * Runs in the Figma page's main world for one export, injected with chrome.scripting. It keeps the
 * Blob Figma hands to URL.createObjectURL and, when Figma clicks a download link for it, posts the
 * file to the content script instead of letting the browser save it. It reads nothing else and
 * puts the original functions back after the export or after `windowMs`. Must stay self-contained,
 * because Chrome serializes it.
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
  const isDownload = (target: unknown): target is HTMLAnchorElement =>
    target instanceof HTMLAnchorElement && target.hasAttribute("download") && /^(blob|data):/.test(target.href);
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
    if (object instanceof Blob) blobs.set(url, object);
    return url;
  };
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement): void {
    if (!isDownload(this)) return click.call(this);
    const anchor = this;
    void hand(anchor).then((captured) => {
      if (!captured) click.call(anchor);
    });
  };
  EventTarget.prototype.dispatchEvent = function (this: EventTarget, event: Event): boolean {
    if (event.type !== "click" || !isDownload(this)) return dispatch.call(this, event);
    const anchor = this;
    void hand(anchor).then((captured) => {
      if (!captured) dispatch.call(anchor, event);
    });
    return true;
  };
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
