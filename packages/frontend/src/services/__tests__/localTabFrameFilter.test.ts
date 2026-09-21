import { expect, it } from "vitest";
import { localTabFrameFilter } from "../runtimeController/localTabFrameFilter";

it("suppresses identical frames while preserving a two-second image heartbeat", () => {
  const publish = localTabFrameFilter();
  const bytes = new Uint8Array([255, 216, 1, 255, 217]);
  expect(publish(bytes, 0)).toBe(true);
  expect(publish(bytes.slice(), 200)).toBe(false);
  expect(publish(bytes, 1999)).toBe(false);
  expect(publish(bytes, 2000)).toBe(true);
  expect(publish(bytes, 3999)).toBe(false);
  expect(publish(bytes, 4000)).toBe(true);
});

it("publishes changed content immediately, including same-length frames and reused buffers", () => {
  const publish = localTabFrameFilter();
  const bytes = new Uint8Array([255, 216, 1, 255, 217]);
  expect(publish(bytes, 0)).toBe(true);
  bytes[2] = 2;
  expect(publish(bytes, 200)).toBe(true);
  expect(publish(bytes, 400)).toBe(false);
  expect(publish(new Uint8Array([255, 216, 2, 3, 255, 217]), 600)).toBe(true);
});
