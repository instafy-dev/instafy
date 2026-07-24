import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StudioRuntimeBridges } from "../NativeExtensionRequestProvider";

describe("StudioRuntimeBridges", () => {
  it("mounts every composed bridge without product-specific imports", () => {
    const mounted = vi.fn();
    function FixtureBridge() {
      mounted();
      return <span>fixture bridge</span>;
    }

    const markup = renderToStaticMarkup(
      <StudioRuntimeBridges
        bridges={[
          {
            id: "fixture.runtime-bridge",
            component: FixtureBridge,
          },
        ]}
      />,
    );

    expect(mounted).toHaveBeenCalledOnce();
    expect(markup).toContain("fixture bridge");
  });
});
