import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import { quickChatBounds } from "./DesktopQuickChat.ts";

describe("quickChatBounds", () => {
  it("centers the window and keeps it above the bottom of the work area", () => {
    const workArea = { x: 0, y: 25, width: 1440, height: 875 };

    assert.deepEqual(quickChatBounds(workArea, 150), {
      x: 380,
      y: 726,
      width: 680,
      height: 150,
    });
  });

  it("follows the display it opens on", () => {
    const workArea = { x: -1920, y: 0, width: 1920, height: 1040 };

    assert.deepEqual(quickChatBounds(workArea, 200), {
      x: -1300,
      y: 816,
      width: 680,
      height: 200,
    });
  });

  it("clamps tall content and narrow displays to the work area", () => {
    const workArea = { x: 0, y: 0, width: 500, height: 400 };

    assert.deepEqual(quickChatBounds(workArea, 2000), {
      x: 0,
      y: 0,
      width: 500,
      height: 400,
    });
  });
});
