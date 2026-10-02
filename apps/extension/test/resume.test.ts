import { describe, expect, it } from "vitest";
import { readInTurn, resumePoint } from "../src/adapter/resume.js";
import { StopExploration } from "../src/adapter/tree.js";

describe("resumePoint", () => {
  const walk = ["1:1|null", "1:2|1:1", "1:3|1:2", "1:4|1:1"];

  it("goes on where the earlier calls stopped when the walk is the same", () => {
    expect(resumePoint(walk, { readFrom: 2, structure: [...walk] })).toEqual({ start: 2, restarted: false });
  });

  it("starts over when a layer was added, removed, or moved to another parent", () => {
    expect(resumePoint(walk, { readFrom: 2, structure: walk.slice(0, 3) })).toEqual({ start: 0, restarted: true });
    expect(resumePoint(walk, { readFrom: 2, structure: ["1:1|null", "1:2|1:1", "1:3|1:1", "1:4|1:1"] })).toEqual({ start: 0, restarted: true });
  });

  it("reads from the root on a first call or without resume", () => {
    expect(resumePoint(walk, { readFrom: 0, structure: [] })).toEqual({ start: 0, restarted: false });
    expect(resumePoint(walk, undefined)).toEqual({ start: 0, restarted: false });
  });
});

describe("readInTurn", () => {
  const order = [0, 5, 6, 7];

  it("stops before a layer once time is up, keeping what it read, and names that layer", async () => {
    // Time is checked before each layer after the root: fine before 5, up before 6.
    let checks = 0;
    const result = await readInTurn(order, async (index) => index, { canStop: true, timeIsUp: () => ++checks > 1 });
    expect(result).toEqual({ read: [0, 5], stoppedAt: 6 });
  });

  it("stops at a layer a budget cut short, which the next call reads", async () => {
    const result = await readInTurn(
      order,
      async (index) => {
        if (index === 7) throw new StopExploration("time_budget");
        return index;
      },
      { canStop: true, timeIsUp: () => false },
    );
    expect(result).toEqual({ read: [0, 5, 6], stoppedAt: 7 });
  });

  it("always reads the root, and lets user input end the read", async () => {
    expect(await readInTurn(order, async (index) => index, { canStop: true, timeIsUp: () => true })).toEqual({ read: [0], stoppedAt: 5 });
    const interrupted = readInTurn(
      order,
      async (index) => {
        if (index === 5) throw new StopExploration("user_interrupted");
        return index;
      },
      { canStop: true, timeIsUp: () => false },
    );
    await expect(interrupted).rejects.toMatchObject({ cause: "user_interrupted" });
  });

  it("never stops early without resume, so a read that runs out of time fails as before", async () => {
    const failing = readInTurn(
      order,
      async (index) => {
        if (index === 6) throw new StopExploration("time_budget");
        return index;
      },
      { canStop: false, timeIsUp: () => true },
    );
    await expect(failing).rejects.toMatchObject({ cause: "time_budget" });
  });
});
