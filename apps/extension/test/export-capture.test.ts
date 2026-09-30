// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { installExportCapture } from "../src/export-capture.js";

// Chrome injects the hook by serializing it, so exercise the serialized form, not the imported function.
const serialized = new Function(`return (${installExportCapture.toString()})`)() as typeof installExportCapture;

afterEach(() => {
  (window as unknown as { __figlooExportCapture?: { restore(): void } }).__figlooExportCapture?.restore();
});

function listen(): unknown[] {
  const received: unknown[] = [];
  window.addEventListener("message", (event) => received.push(event.data));
  return received;
}

describe("installExportCapture", () => {
  it("hands over the file Figma creates and keeps the browser from saving it", async () => {
    const received = listen();
    serialized("token-1", 5_000);
    const url = URL.createObjectURL(new Blob(["<svg/>"], { type: "image/svg+xml" }));
    URL.revokeObjectURL(url); // Figma may revoke the URL right away; the hook keeps the Blob.
    const link = document.createElement("a");
    link.href = url;
    link.download = "icon.svg";
    let followed = false;
    link.addEventListener("click", () => {
      followed = true;
    });
    link.click();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const message = received.find((data) => (data as { __figlooExport?: string } | null)?.__figlooExport === "token-1") as { name: string; type: string; data: ArrayBuffer };
    expect(message.name).toBe("icon.svg");
    expect(message.type).toBe("image/svg+xml");
    expect(new TextDecoder().decode(message.data)).toBe("<svg/>");
    expect(followed).toBe(false);
  });

  it("leaves ordinary links and clicks alone", () => {
    serialized("token-2", 5_000);
    const link = document.createElement("a");
    link.href = "https://example.com/";
    let clicked = 0;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      clicked += 1;
    });
    link.click();
    link.dispatchEvent(new MouseEvent("click", { cancelable: true }));
    expect(clicked).toBe(2);
  });

  it("puts the page's functions back when it is removed", () => {
    const click = HTMLAnchorElement.prototype.click;
    const create = URL.createObjectURL;
    serialized("token-3", 5_000);
    expect(HTMLAnchorElement.prototype.click).not.toBe(click);
    (window as unknown as { __figlooExportCapture: { restore(): void } }).__figlooExportCapture.restore();
    expect(HTMLAnchorElement.prototype.click).toBe(click);
    expect(URL.createObjectURL).toBe(create);
  });

  it("keeps a later export's hook when an earlier export's time runs out", async () => {
    const click = HTMLAnchorElement.prototype.click;
    serialized("earlier", 50);
    (window as unknown as { __figlooExportCapture: { restore(): void } }).__figlooExportCapture.restore();
    serialized("later", 5_000);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect((window as unknown as { __figlooExportCapture?: { token: string } }).__figlooExportCapture?.token).toBe("later");
    expect(HTMLAnchorElement.prototype.click).not.toBe(click);
  });
});
