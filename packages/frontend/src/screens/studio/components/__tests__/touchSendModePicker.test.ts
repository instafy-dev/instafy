import { describe, expect, it } from "vitest";
import {
  IDLE_TOUCH_SEND_MODE_PICKER_STATE,
  TOUCH_SEND_MODE_PRESS_SLOP_PX,
  cancelTouchSendModePicker,
  createTouchSendModePickerLayout,
  finishTouchSendModePicker,
  hitTestTouchSendModePicker,
  moveTouchSendModePicker,
  openTouchSendModePicker,
  startTouchSendModePicker,
  type TouchSendMode,
  type TouchSendModePickerLayout,
  type TouchSendModePoint,
  type TouchSendModeRect,
} from "../touchSendModePicker";

const viewport: TouchSendModeRect = {
  left: 0,
  top: 0,
  right: 320,
  bottom: 640,
};

const anchor: TouchSendModeRect = {
  left: 268,
  top: 568,
  right: 312,
  bottom: 612,
};

function layout(
  primaryMode: "send" | "steer" = "send",
  disabledModes: readonly TouchSendMode[] = [],
): TouchSendModePickerLayout {
  return createTouchSendModePickerLayout({
    anchor,
    viewport,
    primaryMode,
    disabledModes,
  });
}

function centerOfTarget(
  pickerLayout: TouchSendModePickerLayout,
  mode: TouchSendMode,
): TouchSendModePoint {
  const target = pickerLayout.targets.find((candidate) => candidate.mode === mode);
  if (!target) {
    throw new Error(`Missing ${mode} target`);
  }
  return {
    x: (target.rect.left + target.rect.right) / 2,
    y: (target.rect.top + target.rect.bottom) / 2,
  };
}

describe("touchSendModePicker geometry", () => {
  it("lays out the primary, queue, and stash targets upward and toward the physical left", () => {
    const pickerLayout = layout("steer");
    const steer = pickerLayout.targets.find((target) => target.mode === "steer");
    const queue = pickerLayout.targets.find((target) => target.mode === "queue");
    const stash = pickerLayout.targets.find((target) => target.mode === "stash");

    expect(pickerLayout.targetSize).toBe(48);
    expect(pickerLayout.bounds.bottom).toBeLessThan(anchor.top);
    expect(stash!.rect.left).toBeLessThan(queue!.rect.left);
    expect(queue!.rect.left).toBeLessThan(steer!.rect.left);
    expect(pickerLayout.bounds.left).toBeGreaterThanOrEqual(8);
    expect(pickerLayout.bounds.right).toBeLessThanOrEqual(312);
  });

  it("clamps physical coordinates inside a narrow, offset viewport without using direction", () => {
    const pickerLayout = createTouchSendModePickerLayout({
      anchor: { left: 4, top: 6, right: 48, bottom: 50 },
      viewport: { left: 10, top: 20, right: 154, bottom: 180 },
      primaryMode: "send",
      viewportPadding: 6,
    });

    expect(pickerLayout.bounds.left).toBeGreaterThanOrEqual(16);
    expect(pickerLayout.bounds.top).toBeGreaterThanOrEqual(26);
    expect(pickerLayout.bounds.right).toBeLessThanOrEqual(148);
    expect(pickerLayout.bounds.bottom).toBeLessThanOrEqual(174);
    expect(pickerLayout.targets.map((target) => target.mode)).toEqual([
      "send",
      "queue",
      "stash",
    ]);
  });

  it("does not hit-test disabled targets", () => {
    const pickerLayout = layout("send", ["queue"]);

    expect(hitTestTouchSendModePicker(pickerLayout, centerOfTarget(pickerLayout, "send"))).toBe(
      "send",
    );
    expect(hitTestTouchSendModePicker(pickerLayout, centerOfTarget(pickerLayout, "queue"))).toBeNull();
  });
});

describe("touchSendModePicker state", () => {
  it("reports a normal tap when the hold never opens", () => {
    const pressing = startTouchSendModePicker(
      IDLE_TOUCH_SEND_MODE_PICKER_STATE,
      7,
      { x: 290, y: 590 },
    );
    const result = finishTouchSendModePicker(pressing, 7);

    expect(result.outcome).toEqual({ type: "tap" });
    expect(result.state).toEqual(IDLE_TOUCH_SEND_MODE_PICKER_STATE);
  });

  it("opens with no initial selection and cancels if released there", () => {
    const pressing = startTouchSendModePicker(
      IDLE_TOUCH_SEND_MODE_PICKER_STATE,
      7,
      { x: 290, y: 590 },
    );
    const open = openTouchSendModePicker(pressing, 7);

    expect(open).toEqual({ phase: "open", pointerId: 7, highlightedMode: null });
    expect(finishTouchSendModePicker(open, 7, layout()).outcome).toEqual({ type: "cancel" });
  });

  it("highlights on drag and commits the selected enabled target on release", () => {
    const pickerLayout = layout();
    const pressing = startTouchSendModePicker(
      IDLE_TOUCH_SEND_MODE_PICKER_STATE,
      7,
      { x: 290, y: 590 },
    );
    const open = openTouchSendModePicker(pressing, 7);
    const moved = moveTouchSendModePicker(
      open,
      7,
      centerOfTarget(pickerLayout, "queue"),
      pickerLayout,
    );

    expect(moved).toEqual({ phase: "open", pointerId: 7, highlightedMode: "queue" });
    expect(finishTouchSendModePicker(moved, 7, pickerLayout).outcome).toEqual({
      type: "commit",
      mode: "queue",
    });
  });

  it("uses the contextual steer action in the default target", () => {
    const pickerLayout = layout("steer");
    const pressing = startTouchSendModePicker(
      IDLE_TOUCH_SEND_MODE_PICKER_STATE,
      7,
      { x: 290, y: 590 },
    );
    const open = openTouchSendModePicker(pressing, 7);
    const moved = moveTouchSendModePicker(
      open,
      7,
      centerOfTarget(pickerLayout, "steer"),
      pickerLayout,
    );

    expect(finishTouchSendModePicker(moved, 7, pickerLayout).outcome).toEqual({
      type: "commit",
      mode: "steer",
    });
  });

  it("clears the highlight outside every target and cancels on release", () => {
    const pickerLayout = layout();
    const pressing = startTouchSendModePicker(
      IDLE_TOUCH_SEND_MODE_PICKER_STATE,
      7,
      { x: 290, y: 590 },
    );
    const open = openTouchSendModePicker(pressing, 7);
    const selected = moveTouchSendModePicker(
      open,
      7,
      centerOfTarget(pickerLayout, "stash"),
      pickerLayout,
    );
    const outside = moveTouchSendModePicker(selected, 7, { x: 300, y: 300 }, pickerLayout);

    expect(outside).toEqual({ phase: "open", pointerId: 7, highlightedMode: null });
    expect(finishTouchSendModePicker(outside, 7, pickerLayout).outcome).toEqual({
      type: "cancel",
    });
  });

  it("does not highlight or commit a disabled mode", () => {
    const pickerLayout = layout("send", ["stash"]);
    const pressing = startTouchSendModePicker(
      IDLE_TOUCH_SEND_MODE_PICKER_STATE,
      7,
      { x: 290, y: 590 },
    );
    const open = openTouchSendModePicker(pressing, 7);
    const moved = moveTouchSendModePicker(
      open,
      7,
      centerOfTarget(pickerLayout, "stash"),
      pickerLayout,
    );

    expect(moved).toEqual({ phase: "open", pointerId: 7, highlightedMode: null });
    expect(finishTouchSendModePicker(moved, 7, pickerLayout).outcome).toEqual({
      type: "cancel",
    });
  });

  it("revalidates availability at release", () => {
    const enabledLayout = layout();
    const disabledLayout = layout("send", ["queue"]);
    const pressing = startTouchSendModePicker(
      IDLE_TOUCH_SEND_MODE_PICKER_STATE,
      7,
      { x: 290, y: 590 },
    );
    const open = openTouchSendModePicker(pressing, 7);
    const moved = moveTouchSendModePicker(
      open,
      7,
      centerOfTarget(enabledLayout, "queue"),
      enabledLayout,
    );

    expect(finishTouchSendModePicker(moved, 7, disabledLayout).outcome).toEqual({
      type: "cancel",
    });
  });

  it("allows small pre-hold jitter but cancels a moved press instead of turning it into a tap", () => {
    const pickerLayout = layout();
    const pressing = startTouchSendModePicker(
      IDLE_TOUCH_SEND_MODE_PICKER_STATE,
      7,
      { x: 100, y: 100 },
    );
    const jitter = moveTouchSendModePicker(pressing, 7, { x: 106, y: 106 }, pickerLayout);
    const moved = moveTouchSendModePicker(
      pressing,
      7,
      { x: 100 + TOUCH_SEND_MODE_PRESS_SLOP_PX + 1, y: 100 },
      pickerLayout,
    );

    expect(finishTouchSendModePicker(jitter, 7).outcome).toEqual({ type: "tap" });
    expect(moved).toEqual({ phase: "cancelled", pointerId: 7 });
    expect(finishTouchSendModePicker(moved, 7).outcome).toEqual({ type: "cancel" });
  });

  it("ignores events from another pointer and cancels the owning pointer explicitly", () => {
    const pressing = startTouchSendModePicker(
      IDLE_TOUCH_SEND_MODE_PICKER_STATE,
      7,
      { x: 290, y: 590 },
    );

    expect(openTouchSendModePicker(pressing, 8)).toBe(pressing);
    expect(finishTouchSendModePicker(pressing, 8).outcome).toEqual({ type: "none" });
    expect(cancelTouchSendModePicker(pressing, 7)).toEqual({
      state: IDLE_TOUCH_SEND_MODE_PICKER_STATE,
      outcome: { type: "cancel" },
    });
  });
});
