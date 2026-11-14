import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDesktopControllerStartSessionBinding,
  resolveDesktopControllerStartBoundUserId,
  resolveDesktopControllerStartCredentialProvenance,
  resolveTrustedDesktopControllerForExtension,
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

test("a start is bound to the visible session's user whether or not its credential may refresh", () => {
  const visibleSession = {
    accessToken: "visible-token",
    userId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
  };
  // Launch grants follow this binding, so an unpackaged build, which keeps
  // the credential fixed, is still granted for the session's user.
  assert.equal(
    resolveDesktopControllerStartBoundUserId({
      credentialMode: "ambient",
      controllerAccessToken: "visible-token",
      visibleSession,
    }),
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  );
  assert.deepEqual(
    resolveDesktopControllerStartCredentialProvenance({
      credentialMode: "ambient",
      controllerAccessToken: "visible-token",
      visibleSession,
      allowAmbientRefresh: false,
    }),
    { kind: "fixed" },
  );
  // A start that asked for fixed credentials is bound to nobody.
  assert.equal(
    resolveDesktopControllerStartBoundUserId({
      credentialMode: "fixed",
      controllerAccessToken: "visible-token",
      visibleSession,
    }),
    null,
  );
  // Another bearer than the visible session's is refused, never bound.
  assert.throws(
    () =>
      resolveDesktopControllerStartBoundUserId({
        credentialMode: "ambient",
        controllerAccessToken: "someone-elses-token",
        visibleSession,
      }),
    /session changed/i,
  );
});

test("an extension call's controller follows the start trust policy, with a known default", () => {
  const packaged = {
    appUrl: "https://prod.instafy.dev/studio",
    callerUrl: "https://prod.instafy.dev/studio?projectId=test",
    isPackaged: true,
  };
  // Packaged Desktop trusts one controller, named or not.
  assert.equal(
    resolveTrustedDesktopControllerForExtension({
      ...packaged,
      requestedControllerUrl: null,
      runningRuntimeControllerUrl: null,
    }),
    "https://controller.instafy.dev",
  );
  assert.equal(
    resolveTrustedDesktopControllerForExtension({
      ...packaged,
      requestedControllerUrl: "https://controller.instafy.dev/",
      runningRuntimeControllerUrl: null,
    }),
    "https://controller.instafy.dev",
  );
  // A controller the renderer names but the policy refuses is an error.
  assert.throws(
    () =>
      resolveTrustedDesktopControllerForExtension({
        ...packaged,
        requestedControllerUrl: "https://attacker.example",
        runningRuntimeControllerUrl: null,
      }),
    /Instafy controller/i,
  );
  // An untrusted app origin gets no default either.
  assert.equal(
    resolveTrustedDesktopControllerForExtension({
      appUrl: "https://attacker.example/studio",
      callerUrl: "https://attacker.example/studio",
      isPackaged: true,
      requestedControllerUrl: null,
      runningRuntimeControllerUrl: null,
    }),
    null,
  );

  // An unpackaged build falls back to its running runtime's loopback controller.
  const unpackaged = {
    appUrl: "http://127.0.0.1:5173/studio",
    callerUrl: "http://127.0.0.1:5173/studio",
    isPackaged: false,
  };
  assert.equal(
    resolveTrustedDesktopControllerForExtension({
      ...unpackaged,
      requestedControllerUrl: null,
      runningRuntimeControllerUrl: null,
    }),
    null,
  );
  assert.equal(
    resolveTrustedDesktopControllerForExtension({
      ...unpackaged,
      requestedControllerUrl: null,
      runningRuntimeControllerUrl: "http://localhost:18788",
    }),
    "http://localhost:18788",
  );
  assert.equal(
    resolveTrustedDesktopControllerForExtension({
      ...unpackaged,
      requestedControllerUrl: "http://127.0.0.1:18789",
      runningRuntimeControllerUrl: "http://localhost:18788",
    }),
    "http://127.0.0.1:18789",
  );
  assert.equal(
    resolveTrustedDesktopControllerForExtension({
      ...unpackaged,
      requestedControllerUrl: null,
      runningRuntimeControllerUrl: "https://controller.instafy.dev",
    }),
    null,
  );
});
