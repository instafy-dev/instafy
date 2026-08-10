import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDesktopControllerStartSessionBinding,
  resolveDesktopControllerStartCredentialProvenance,
  resolveTrustedDesktopControllerForStart,
} from "../dist/desktopControllerTrust.js";

const START_KINDS = ["runtime", "speech_tunnel"];
const CREDENTIAL_MODES = ["fixed", "ambient"];

function forEachBearerUse(run) {
  for (const startKind of START_KINDS) {
    for (const credentialMode of CREDENTIAL_MODES) {
      run({ startKind, credentialMode });
    }
  }
}

test("packaged runtime and speech starts accept only the pinned first-party controller", () => {
  forEachBearerUse(({ startKind, credentialMode }) => {
    assert.equal(
      resolveTrustedDesktopControllerForStart({
        appUrl: "https://prod.instafy.dev/studio",
        callerUrl: "https://prod.instafy.dev/studio?projectId=test",
        requestedControllerUrl: "https://controller.instafy.dev/",
        isPackaged: true,
        startKind,
        credentialMode,
      }),
      "https://controller.instafy.dev",
    );

    assert.throws(
      () =>
        resolveTrustedDesktopControllerForStart({
          appUrl: "https://prod.instafy.dev/studio",
          callerUrl: "https://prod.instafy.dev/studio",
          requestedControllerUrl: "https://attacker.example",
          isPackaged: true,
          startKind,
          credentialMode,
        }),
      /Instafy controller/i,
    );
  });
});

test("packaged starts cannot inherit the loopback development exception", () => {
  forEachBearerUse(({ startKind, credentialMode }) => {
    assert.throws(
      () =>
        resolveTrustedDesktopControllerForStart({
          appUrl: "http://127.0.0.1:5173/studio",
          callerUrl: "http://127.0.0.1:5173/studio",
          requestedControllerUrl: "http://localhost:8788",
          isPackaged: true,
          startKind,
          credentialMode,
        }),
      /pinned Instafy controller/i,
    );
  });
});

test("unpackaged runtime and speech starts are restricted to origin-only loopback controllers", () => {
  forEachBearerUse(({ startKind, credentialMode }) => {
    assert.equal(
      resolveTrustedDesktopControllerForStart({
        appUrl: "http://127.0.0.1:5173/studio",
        callerUrl: "http://127.0.0.1:5173/studio",
        requestedControllerUrl: "http://localhost:8788",
        isPackaged: false,
        startKind,
        credentialMode,
      }),
      "http://localhost:8788",
    );

    for (const requestedControllerUrl of [
      "https://attacker.example",
      "http://localhost:8788/api",
      "http://user:password@localhost:8788",
    ]) {
      assert.throws(
        () =>
          resolveTrustedDesktopControllerForStart({
            appUrl: "http://127.0.0.1:5173/studio",
            callerUrl: "http://127.0.0.1:5173/studio",
            requestedControllerUrl,
            isPackaged: false,
            startKind,
            credentialMode,
          }),
        /controller URL|loopback controller/i,
      );
    }
  });
});

test("unpackaged starts cannot use production controller authority", () => {
  forEachBearerUse(({ startKind, credentialMode }) => {
    assert.throws(
      () =>
        resolveTrustedDesktopControllerForStart({
          appUrl: "https://prod.instafy.dev/studio",
          callerUrl: "https://prod.instafy.dev/studio",
          requestedControllerUrl: "https://controller.instafy.dev",
          isPackaged: false,
          startKind,
          credentialMode,
        }),
      /loopback controller/i,
    );
  });
});

test("trust resolution rejects caller and auth overrides before a bearer can be used", () => {
  forEachBearerUse(({ startKind, credentialMode }) => {
    let bearerUsed = false;
    const startWithBearer = (callerUrl, requestedControllerUrl) => {
      const controllerUrl = resolveTrustedDesktopControllerForStart({
        appUrl: "https://prod.instafy.dev/studio",
        callerUrl,
        requestedControllerUrl,
        isPackaged: true,
        startKind,
        credentialMode,
      });
      bearerUsed = true;
      return { controllerUrl, authorization: "Bearer renderer-secret" };
    };

    assert.throws(
      () => startWithBearer("https://attacker.example/studio", "https://controller.instafy.dev"),
      /active Instafy app/i,
    );
    assert.equal(bearerUsed, false);

    assert.throws(
      () =>
        startWithBearer(
          "https://prod.instafy.dev/studio?controllerAccessToken=renderer-secret",
          "https://controller.instafy.dev",
        ),
      /overridden Desktop session/i,
    );
    assert.equal(bearerUsed, false);
  });
});

test("ambient starts require the exact validated visible-session token and user", () => {
  assert.doesNotThrow(() =>
    assertDesktopControllerStartSessionBinding({
      credentialMode: "ambient",
      controllerAccessToken: "visible-token",
      visibleSession: {
        accessToken: "visible-token",
        userId: "user-123",
      },
    }),
  );
  assert.throws(
    () =>
      assertDesktopControllerStartSessionBinding({
        credentialMode: "ambient",
        controllerAccessToken: "attacker-token",
        visibleSession: {
          accessToken: "visible-token",
          userId: "user-123",
        },
      }),
    /session changed/i,
  );
  assert.throws(
    () =>
      assertDesktopControllerStartSessionBinding({
        credentialMode: "ambient",
        controllerAccessToken: "visible-token",
        visibleSession: {
          accessToken: "visible-token",
          userId: " ",
        },
      }),
    /session changed/i,
  );
  assert.doesNotThrow(() =>
    assertDesktopControllerStartSessionBinding({
      credentialMode: "fixed",
      controllerAccessToken: "fixed-controller-token",
      visibleSession: null,
    }),
  );
});

test("ambient runtime provenance fails closed before deciding refreshability", () => {
  const exactAmbientInput = {
    credentialMode: "ambient",
    controllerAccessToken: "visible-token",
    visibleSession: {
      accessToken: "visible-token",
      userId: "user-123",
    },
  };
  assert.deepEqual(
    resolveDesktopControllerStartCredentialProvenance({
      ...exactAmbientInput,
      allowAmbientRefresh: true,
    }),
    { kind: "ambient", userId: "user-123" },
  );
  assert.deepEqual(
    resolveDesktopControllerStartCredentialProvenance({
      ...exactAmbientInput,
      allowAmbientRefresh: false,
    }),
    { kind: "fixed" },
  );
  assert.throws(
    () =>
      resolveDesktopControllerStartCredentialProvenance({
        ...exactAmbientInput,
        controllerAccessToken: "stale-or-attacker-token",
        allowAmbientRefresh: false,
      }),
    /session changed/i,
  );
  assert.throws(
    () =>
      resolveDesktopControllerStartCredentialProvenance({
        credentialMode: "ambient",
        controllerAccessToken: "visible-token",
        visibleSession: null,
        allowAmbientRefresh: false,
      }),
    /session changed/i,
  );
  assert.deepEqual(
    resolveDesktopControllerStartCredentialProvenance({
      credentialMode: "fixed",
      controllerAccessToken: "fixed-token",
      visibleSession: null,
      allowAmbientRefresh: true,
    }),
    { kind: "fixed" },
  );
});
