import type { SurveyRoot } from "@figloo/protocol";
import type { SurveyFile } from "./surveys.js";

/** Layer types a screen, a panel, or a component is drawn as. */
const FRAME_TYPES = new Set(["Frame", "Auto layout", "Component", "Component set"]);
/** Names Figma gives new layers, such as "Frame 882", "Group 908", "Path 464", or "image 7". */
const AUTO_NAME = /^(?:frame|group|rectangle|ellipse|vector|line|polygon|star|path|mask group|image|union|subtract|intersect|exclude|arrow|slice)(?: \d+)?$/i;
/** Names a pasted screenshot gets, in English, Chinese, or Japanese. */
const SCREENSHOT_NAME = /^(?:screenshot|screen shot|截圖|螢幕截圖|螢幕快照|截屏|屏幕截图|スクリーンショット)/i;
/** A name that keeps a component's path, such as "Component / Card / Live", on a layer that is not an instance. */
const COMPONENT_PREFIX = /^component\s*\//i;
/** Layer types a detached instance becomes. */
const CONTAINER_TYPES = new Set(["Group", "Frame", "Auto layout"]);
/** Text that says little about a screen, such as a status bar's time or a count. */
const BARE_NUMBER = /^[\d\s:.,%/~+-]*$/;
/** What designers put between a flow and a screen or state: "Likes – Fans", "Post／New", "Ranking-Weekly", "Gifts・Info". */
const FLOW_SEPARATOR = /\s+[–—-]\s+|\s*[／/・|｜]\s*|-(?=\S)/;
/** A platform after the name, such as "Ranking@iOS". */
const PLATFORM_SUFFIX = /\s*@\S*$/;

/** From the 0.7.0 benchmark: about 65 ms per layer and 3 s per snapshot. */
const SNAPSHOT_MS_PER_LAYER = 65;
const SNAPSHOT_MS_FIXED = 3_000;
const MIN_AUTO_NAMED_LAYERS = 10;
const MAX_LISTED_FRAMES = 6;
const MAX_TOP_INSTANCES = 5;
const MAX_FRAME_TEXTS = 3;
const MAX_OTHER_NAMES = 12;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const quoted = (text: string, max: number) => JSON.stringify(clip(text, max));
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** About how long a snapshot of a frame with `layers` layers inside takes, in seconds, rounded to 5 s. */
export function snapshotSeconds(layers: number): number {
  return Math.max(5, Math.round((SNAPSHOT_MS_FIXED + SNAPSHOT_MS_PER_LAYER * (layers + 1)) / 5_000) * 5);
}

/** The flow a frame's name puts it in: the part before the first separator, without a platform. */
export function flowOf(name: string): string {
  return name.replace(PLATFORM_SUFFIX, "").split(FLOW_SEPARATOR)[0]!.trim();
}

/** Words of a name, lowercased, for telling that two names may mean the same thing. */
function words(name: string): string[] {
  return name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

interface Frame {
  n: number;
  root: SurveyRoot;
  instances: Map<string, number>;
  texts: string[];
  textLayers: number;
  autoNamed: number;
  hidden: number;
  /** Groups and frames by name, some of which may be detached instances. */
  containers: Map<string, number>;
  detached: Map<string, number>;
  screenshots: string[];
}

function frameOf(n: number, root: SurveyRoot): Frame {
  const frame: Frame = { n, root, instances: new Map(), texts: [], textLayers: 0, autoNamed: 0, hidden: 0, containers: new Map(), detached: new Map(), screenshots: [] };
  for (const layer of root.layers) {
    if (layer.hidden) frame.hidden += 1;
    if (AUTO_NAME.test(layer.name.trim())) frame.autoNamed += 1;
    if (layer.type === "Instance") frame.instances.set(layer.name, (frame.instances.get(layer.name) ?? 0) + 1);
    if (layer.type === "Text") {
      frame.textLayers += 1;
      const text = layer.name.replace(/\s+/g, " ").trim();
      if (text && !BARE_NUMBER.test(text) && !frame.texts.includes(text)) frame.texts.push(text);
    }
    if (CONTAINER_TYPES.has(layer.type ?? "")) frame.containers.set(layer.name, (frame.containers.get(layer.name) ?? 0) + 1);
    if (layer.type === "Image" && SCREENSHOT_NAME.test(layer.name.trim())) frame.screenshots.push(layer.name);
  }
  return frame;
}

/** One part of the overview; parts with a lower `priority` are cut first when it does not fit. */
export interface OverviewPart {
  title: string;
  lines: string[];
  priority: number;
}

export interface SurveyOverview {
  header: string[];
  parts: OverviewPart[];
  counts: { frames: number; notes: number; sections: number; other: number; layers: number };
}

/** The survey as text, part by part: frames, frames by name, sections, notes, components, what is worth a look, and the rest. */
export function surveyOverview(file: SurveyFile): SurveyOverview {
  const frames: Frame[] = [];
  const notes: SurveyRoot[] = [];
  const other: SurveyRoot[] = [];
  for (const root of file.roots) {
    if (FRAME_TYPES.has(root.type ?? "")) frames.push(frameOf(frames.length + 1, root));
    else if (root.type === "Text") notes.push(root);
    else other.push(root);
  }
  // A group or frame named exactly like a component or an instance elsewhere may be a detached instance;
  // one-word names such as "Card" are too common to tell.
  const componentNames = new Set<string>();
  for (const root of file.roots) {
    if (root.type === "Component" || root.type === "Component set" || root.type === "Instance") componentNames.add(root.name.trim());
    for (const layer of root.layers) if (layer.type === "Instance" || layer.type === "Component" || layer.type === "Component set") componentNames.add(layer.name.trim());
  }
  const distinctive = (name: string) => name.includes("/") || name.split(/\s+/).length > 1;
  for (const frame of frames) {
    for (const [name, n] of frame.containers) {
      const trimmed = name.trim();
      if (COMPONENT_PREFIX.test(trimmed) || (distinctive(trimmed) && componentNames.has(trimmed))) frame.detached.set(name, n);
    }
  }
  const sectionName = new Map(file.sections.map((section) => [section.ref, section.name]));
  const inSection = (ref: string | null) => (ref && sectionName.has(ref) ? ` in ${quoted(sectionName.get(ref)!, 40)}` : "");
  const layers = frames.reduce((sum, frame) => sum + frame.root.layers.length, 0);
  const totalSeconds = frames.reduce((sum, frame) => sum + snapshotSeconds(frame.root.layers.length), 0);

  const header = [
    `${file.page === null ? "Page" : `Page ${JSON.stringify(file.page)}`}${file.refs === null ? "" : `, ${plural(file.refs.length, "layer")} asked for`}: ` +
      `${plural(frames.length, "frame")}, ${plural(notes.length, "note")}, ${plural(file.sections.length, "section")}, ${plural(other.length, "other layer")}; ` +
      `${plural(layers, "layer")} inside the frames.`,
    `Snapshots of every frame would take about ${Math.max(1, Math.round(totalSeconds / 60))} min; each frame says its own. #n numbers the frames; refs work with snapshot_layer and the other tools in this context.`,
  ];

  const frameLines = frames.map((frame) => {
    const { root } = frame;
    const parts = [`#${frame.n} ${root.ref} ${root.type} ${quoted(root.name, 60)}${root.size ? ` ${Math.round(root.size.width)}×${Math.round(root.size.height)}` : ""}${inSection(root.sectionRef)}${root.hidden ? " [hidden]" : ""}`];
    const count = root.layers.length;
    const autoShare = count > 0 ? Math.round((frame.autoNamed / count) * 100) : 0;
    parts.push(`${plural(count, "layer")}: ${plural(sum(frame.instances), "instance")}, ${frame.textLayers} text, ${autoShare}% auto-named${frame.hidden ? `, ${frame.hidden} hidden` : ""}`);
    const top = [...frame.instances].sort((a, b) => b[1] - a[1]).slice(0, MAX_TOP_INSTANCES);
    if (top.length > 0) parts.push(`instances: ${top.map(([name, n]) => `${clip(name, 32)}${n > 1 ? ` ×${n}` : ""}`).join(", ")}`);
    if (frame.texts.length > 0) parts.push(`text: ${frame.texts.slice(0, MAX_FRAME_TEXTS).map((text) => quoted(text, 20)).join(", ")}`);
    parts.push(root.complete ? `snapshot ~${snapshotSeconds(count)} s` : "over 2,000 layers: snapshot its parts");
    return parts.join(" · ");
  });

  const flows = new Map<string, number[]>();
  for (const frame of frames) {
    const flow = flowOf(frame.root.name);
    if (!flow) continue;
    const key = flow.toLowerCase();
    if (!flows.has(key)) flows.set(key, []);
    flows.get(key)!.push(frame.n);
  }
  const flowName = new Map(frames.map((frame) => [flowOf(frame.root.name).toLowerCase(), flowOf(frame.root.name)]));
  const flowLines = [...flows].filter(([, ns]) => ns.length > 1).map(([key, ns]) => `${quoted(flowName.get(key)!, 40)} (${ns.length}): ${ns.map((n) => `#${n}`).join(" ")}`);

  const sectionLines = file.sections.map((section) => {
    const inside = frames.filter((frame) => frame.root.sectionRef === section.ref).map((frame) => `#${frame.n}`);
    return `${section.ref} ${quoted(section.name, 60)}${inSection(section.parentRef)}: ${inside.length > 0 ? inside.join(" ") : "no frames"}`;
  });

  const noteLines = notes.map((note) => `${note.ref} ${quoted(note.name.replace(/\s*\n\s*/g, " ⏎ "), 300)}${inSection(note.sectionRef)}${note.hidden ? " [hidden]" : ""}`);

  // Components: instances in the frames, and instances placed on the page by themselves.
  const used = new Map<string, { count: number; frames: Set<number>; loose: number }>();
  for (const frame of frames) {
    for (const [name, n] of frame.instances) {
      const entry = used.get(name) ?? { count: 0, frames: new Set(), loose: 0 };
      entry.count += n;
      entry.frames.add(frame.n);
      used.set(name, entry);
    }
  }
  for (const root of other) {
    if (root.type !== "Instance") continue;
    const entry = used.get(root.name) ?? { count: 0, frames: new Set(), loose: 0 };
    entry.count += 1;
    entry.loose += 1;
    used.set(root.name, entry);
  }
  const ranked = [...used].sort((a, b) => b[1].frames.size - a[1].frames.size || b[1].count - a[1].count);
  // Components of one frame only say little about the design as a whole; they come last, by frame.
  const onlyInOne = (entry: { frames: Set<number>; loose: number }) => entry.frames.size === 1 && entry.loose === 0;
  const shared = ranked.filter(([, entry]) => !onlyInOne(entry));
  const single = new Map<number, string[]>();
  for (const [name, entry] of ranked) {
    if (!onlyInOne(entry)) continue;
    const n = [...entry.frames][0]!;
    if (!single.has(n)) single.set(n, []);
    single.get(n)!.push(`${quoted(name, 40)}${entry.count > 1 ? ` ×${entry.count}` : ""}`);
  }
  const componentLines = shared.map(([name, { count, frames: within, loose }]) => {
    const listed = [...within].slice(0, MAX_LISTED_FRAMES).map((n) => `#${n}`);
    const more = within.size > MAX_LISTED_FRAMES ? " …" : "";
    const where = [within.size > 0 ? `in ${plural(within.size, "frame")}: ${listed.join(" ")}${more}` : "", loose > 0 ? `${loose} on the page` : ""].filter(Boolean).join("; ");
    return `${quoted(name, 50)} ×${count} ${where}`;
  });
  const alike = new Map<string, string[]>();
  for (const [name] of ranked) {
    const key = words(name).slice(0, 2).join(" ");
    if (!key) continue;
    if (!alike.has(key)) alike.set(key, []);
    alike.get(key)!.push(name);
  }
  for (const names of alike.values()) {
    if (names.length < 2) continue;
    // Names that differ only in numbers, such as slot-1 and slot-2, are usually siblings rather than one thing;
    // names that differ only in case or punctuation, such as "Status bar" and "status-bar", are kept.
    const written = new Set(names.map((name) => words(name).join(" ")));
    const withoutNumbers = new Set(names.map((name) => words(name.replace(/\d+/g, "")).join(" ")));
    if (written.size > 1 && withoutNumbers.size === 1) continue;
    componentLines.push(`Maybe one thing under several names: ${names.map((name) => `${quoted(name, 40)} (${plural(used.get(name)!.frames.size, "frame")})`).join(", ")}`);
  }

  for (const [n, names] of [...single].sort((a, b) => a[0] - b[0])) componentLines.push(`Only in #${n}: ${names.join(", ")}`);

  const worthLines: string[] = [];
  const detached = frames.filter((frame) => frame.detached.size > 0);
  if (detached.length > 0) {
    worthLines.push(
      `Groups and frames named like a component, maybe detached instances: ${detached
        .map((frame) => `#${frame.n} ${[...frame.detached].map(([name, n]) => `${quoted(name, 40)}${n > 1 ? ` ×${n}` : ""}`).join(", ")}`)
        .join("; ")}`,
    );
  }
  const pasted = frames.filter((frame) => frame.screenshots.length > 0);
  if (pasted.length > 0) worthLines.push(`Pasted screenshots, likely references rather than design: ${pasted.map((frame) => `#${frame.n} ${frame.screenshots.map((name) => quoted(name, 40)).join(", ")}`).join("; ")}`);
  const autoNamed = frames.filter((frame) => frame.root.layers.length >= MIN_AUTO_NAMED_LAYERS && frame.autoNamed * 2 >= frame.root.layers.length);
  if (autoNamed.length > 0) {
    worthLines.push(`Half or more of the layers auto-named, such as "Group 12", so names say little; look at a screenshot: ${autoNamed.map((frame) => `#${frame.n} ${Math.round((frame.autoNamed / frame.root.layers.length) * 100)}%`).join(", ")}`);
  }
  const hiddenFrames = frames.filter((frame) => frame.root.hidden);
  if (hiddenFrames.length > 0) worthLines.push(`Hidden frames: ${hiddenFrames.map((frame) => `#${frame.n}`).join(" ")}`);
  const large = frames.filter((frame) => !frame.root.complete);
  if (large.length > 0) worthLines.push(`Over 2,000 layers, only the first ones listed: ${large.map((frame) => `#${frame.n}`).join(" ")}`);

  const byType = new Map<string, Map<string, number>>();
  for (const root of other) {
    const type = root.type ?? "Unknown";
    if (!byType.has(type)) byType.set(type, new Map());
    const names = byType.get(type)!;
    names.set(root.name, (names.get(root.name) ?? 0) + 1);
  }
  const otherLines = [...byType]
    .sort((a, b) => sum(b[1]) - sum(a[1]))
    .map(([type, names]) => {
      const listed = [...names].slice(0, MAX_OTHER_NAMES).map(([name, n]) => `${quoted(name, 30)}${n > 1 ? ` ×${n}` : ""}`);
      return `${type} ${sum(names)}: ${listed.join(", ")}${names.size > MAX_OTHER_NAMES ? ", …" : ""}`;
    });

  return {
    header,
    parts: [
      { title: "Frames", lines: frameLines, priority: 6 },
      { title: "Frames by name", lines: flowLines, priority: 2 },
      { title: "Sections", lines: sectionLines, priority: 5 },
      { title: "Notes on the canvas", lines: noteLines, priority: 4 },
      { title: "Components", lines: componentLines, priority: 3 },
      { title: "Worth a look", lines: worthLines, priority: 3.5 },
      { title: "Other layers on the page", lines: otherLines, priority: 1 },
    ],
    counts: { frames: frames.length, notes: notes.length, sections: file.sections.length, other: other.length, layers },
  };
}

function sum(names: Map<string, number>): number {
  return [...names.values()].reduce((a, b) => a + b, 0);
}

/**
 * The overview as one text that `fits`: lines are cut from the end of the part with the lowest
 * priority first, and a cut part says how many lines it left out.
 */
export function fitOverview(overview: SurveyOverview, fits: (text: string) => boolean): { text: string; truncated: boolean } {
  const shown = overview.parts.map((part) => part.lines.length);
  const render = () =>
    [
      ...overview.header,
      ...overview.parts.flatMap((part, i) => {
        if (part.lines.length === 0) return [];
        const cut = part.lines.length - shown[i]!;
        return ["", `## ${part.title}`, ...part.lines.slice(0, shown[i]), ...(cut > 0 ? [`… ${plural(cut, "more line")} left out to fit`] : [])];
      }),
    ].join("\n");
  let text = render();
  let truncated = false;
  const order = overview.parts.map((part, i) => ({ priority: part.priority, i })).sort((a, b) => a.priority - b.priority);
  while (!fits(text)) {
    const next = order.find(({ i }) => shown[i]! > 0);
    if (!next) break;
    shown[next.i] = shown[next.i]! - 1;
    truncated = true;
    text = render();
  }
  return { text, truncated };
}
