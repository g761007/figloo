import { BridgeErrorCodeSchema, ErrorCodeSchema } from "@figloo/protocol";
import { describe, expect, it } from "vitest";
import { ERRORS, SERVER_ERROR_CODES, describeError } from "../src/errors.js";

describe("error codes", () => {
  it("gives every code a tool can end with a category, retry advice, and a hint", () => {
    const codes = [...ErrorCodeSchema.options, ...BridgeErrorCodeSchema.options, ...SERVER_ERROR_CODES];
    for (const code of codes) expect(ERRORS[code], code).toMatchObject({ category: expect.any(String), retry: expect.stringMatching(/^(yes|after_user|no)$/), hint: expect.stringMatching(/\S/) });
    expect(Object.keys(ERRORS).sort()).toEqual([...new Set(codes)].sort());
  });

  it("tells waiting from asking the user from changing the call", () => {
    expect(ERRORS.BUSY!.retry).toBe("yes");
    expect(ERRORS.TAB_IN_BACKGROUND!.retry).toBe("after_user");
    expect(ERRORS.NO_SELECTION!.retry).toBe("after_user");
    expect(ERRORS.CONTEXT_EXPIRED!.retry).toBe("no");
    expect(ERRORS.SUBTREE_TOO_LARGE!.retry).toBe("no");
  });

  it("keeps a tool's own wording of a hint, and reads an unknown code as an internal error", () => {
    expect(describeError("UNKNOWN_REF", { UNKNOWN_REF: "Pass a ref from this snapshot's outline." })).toMatchObject({ category: "context", hint: "Pass a ref from this snapshot's outline." });
    expect(describeError("EEXIST")).toMatchObject({ category: "internal", retry: "no" });
  });
});
