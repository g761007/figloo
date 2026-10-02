import type { SnapshotChangeAspect, SnapshotChanges, SnapshotLayer } from "@figloo/protocol";

/** Places measured on screen move by fractions between reads; a change this small is not a change. */
const BOUNDS_TOLERANCE_PX = 1;

/** A layer's panel sections by what they show, without titles: a style run's title repeats its text. */
function panelAspects(layer: SnapshotLayer): Map<SnapshotChangeAspect, string> {
  const out = new Map<SnapshotChangeAspect, string>();
  for (const section of layer.sections) {
    const aspect: SnapshotChangeAspect = section.kind === "content" ? "content" : section.group;
    out.set(aspect, `${out.get(aspect) ?? ""}${JSON.stringify([section.kind, section.properties, section.colors, section.text])}`);
  }
  return out;
}

function boundsMoved(a: SnapshotLayer["bounds"], b: SnapshotLayer["bounds"]): boolean {
  return (["x", "y", "width", "height"] as const).some((key) => {
    const [before, after] = [a[key], b[key]];
    if (before === null || after === null) return before !== after;
    return Math.abs(before - after) >= BOUNDS_TOLERANCE_PX;
  });
}

/** What differs about one layer found in both snapshots. */
function aspectsOf(before: SnapshotLayer, after: SnapshotLayer, root: string): SnapshotChangeAspect[] {
  const aspects: SnapshotChangeAspect[] = [];
  if (before.name !== after.name) aspects.push("name");
  if (before.type !== after.type) aspects.push("type");
  if (before.hidden !== after.hidden) aspects.push("hidden");
  if (after.ref !== root && before.parentRef !== after.parentRef) aspects.push("moved");
  if (boundsMoved(before.bounds, after.bounds)) aspects.push("bounds");
  const [a, b] = [panelAspects(before), panelAspects(after)];
  for (const aspect of ["layout", "appearance", "typography", "content", "component", "other"] as const) {
    if (a.get(aspect) !== b.get(aspect)) aspects.push(aspect);
  }
  // null means Figloo could not confirm the export section showed the layer, so it says nothing either way.
  if (before.exports !== null && after.exports !== null && JSON.stringify(before.exports) !== JSON.stringify(after.exports)) aspects.push("exports");
  return aspects;
}

/** Layers added, removed, and changed between two snapshots of the same root, in the new panel order. */
export function diffSnapshots(previous: SnapshotLayer[], next: SnapshotLayer[], since: string): SnapshotChanges {
  const before = new Map(previous.map((layer) => [layer.ref, layer]));
  const after = new Set(next.map((layer) => layer.ref));
  const root = next[0]?.ref ?? "";
  const changes: SnapshotChanges = { since, added: [], removed: [], changed: [] };
  for (const layer of next) {
    const old = before.get(layer.ref);
    if (!old) {
      changes.added.push(layer.ref);
      continue;
    }
    const aspects = aspectsOf(old, layer, root);
    if (aspects.length > 0) changes.changed.push({ ref: layer.ref, aspects });
  }
  for (const layer of previous) {
    if (!after.has(layer.ref)) changes.removed.push({ ref: layer.ref, name: layer.name, type: layer.type, parentRef: layer.parentRef });
  }
  return changes;
}

/** The outline mark of each layer the changes name. */
export function changeMarks(changes: SnapshotChanges | undefined): Map<string, string> {
  const marks = new Map<string, string>();
  for (const ref of changes?.added ?? []) marks.set(ref, "[new]");
  for (const { ref, aspects } of changes?.changed ?? []) marks.set(ref, `[changed: ${aspects.join(", ")}]`);
  return marks;
}
