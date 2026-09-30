export interface FigmaUrlInfo {
  isDesignFile: boolean;
  fileKey: string | null;
  fileName: string | null;
  nodeId: string | null;
}

const DESIGN_PATH = /^\/(?:design|file)\/([A-Za-z0-9]+)(?:\/([^/?#]*))?/;

/** Extracts file key, file name, and the selected node id (as `123:456`) from a Figma URL. */
export function parseFigmaUrl(href: string): FigmaUrlInfo {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { isDesignFile: false, fileKey: null, fileName: null, nodeId: null };
  }
  const match = url.hostname === "www.figma.com" ? DESIGN_PATH.exec(url.pathname) : null;
  if (!match) return { isDesignFile: false, fileKey: null, fileName: null, nodeId: null };
  const rawName = match[2];
  const fileName = rawName ? decodeURIComponent(rawName) : null;
  const nodeParam = url.searchParams.get("node-id");
  const nodeId = nodeParam && /^\d+-\d+$/.test(nodeParam) ? nodeParam.replace("-", ":") : null;
  return { isDesignFile: true, fileKey: match[1], fileName, nodeId };
}
