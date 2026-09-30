import { describe, expect, it } from "vitest";
import { ConnectionStatusSchema } from "../src/index.js";

describe("ConnectionStatusSchema", () => {
  it("accepts a status defined by the plan", () => {
    expect(ConnectionStatusSchema.parse("READY")).toBe("READY");
  });

  it("rejects a value outside the enum", () => {
    expect(ConnectionStatusSchema.safeParse("CONNECTED").success).toBe(false);
  });
});
