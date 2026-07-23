# Camera Operator

This is the short runbook for using and validating the first-party `Camera` extension in Instafy.

## Product Model

- Each native device runtime registers as its own Camera provider, for example `camera:<device-id>`.
- Supported v1 provider backends are:
  - Android native camera
  - iPhone native camera
  - Instafy Desktop webcam
- `Use This Device` attaches the current device to the open space.
- If multiple devices are attached, `Manage` lets you choose the default device for new Camera requests.
- Requests from another Instafy client route to that selected device unless the space state changes.
- The provider device should stay foregrounded in Instafy until the request is claimed and the photo is taken.
- Browser-hosted camera providers are still deferred. Browser clients can consume attached native providers.

## Normal Use

1. Open the space on the provider device.
2. Go to `Extensions`.
3. Open `Camera`.
4. Press `Use This Device`.
5. Grant camera access if prompted.
6. If more than one device is attached, choose the default device in `Manage`.
7. From another Instafy client, ask for a photo:
   - `@octo capture a front selfie`
   - `@octo take a photo`
8. Take the photo on the selected device when the in-app camera opens, or allow Instafy Desktop to use its webcam.
9. After success, the chat result should only show the captured-photo result and artifact summary. It should not keep showing `Waiting on <device>` or `<device> is capturing`.

## Manual Cross-Device Hardware Smoke

Run this when changing Camera provider routing or native capture permissions.

1. Phone provider to desktop consumer:
   - Open the same space in the native mobile app and Desktop Studio.
   - On the phone, go to `Extensions -> Camera` and press `Use This Device`.
   - On Desktop Studio, open `Extensions -> Camera -> Manage` and confirm the phone is the preferred device.
   - In desktop chat, send `@octo take a photo`.
   - Confirm the phone opens the native capture flow and the desktop chat receives the captured photo result.
2. Desktop provider to phone consumer:
   - Open the same space in Instafy Desktop and the native mobile app.
   - In Instafy Desktop, go to `Extensions -> Camera` and press `Use This Device`.
   - On the phone, open `Extensions -> Camera -> Manage` and confirm the desktop webcam is the preferred device.
   - In phone chat, send `@octo take a photo`.
   - Confirm the desktop webcam captures and the phone chat receives the captured photo result.

## Status Language

Expected camera states:

- `Waiting on <device>`: request sent, the selected device has not started capture yet.
- `<device> is capturing`: the selected device is in the active capture step.
- `<device> needs camera access`: permission is missing on that device.
- `<device> is offline`: Instafy is not open or the device is not currently reachable for Camera.
- `Preferred device`: the device new Camera requests route to.

## Validation Matrix

Use the smallest lane that proves the behavior you changed.

- Simulator-backed day-to-day lanes:
  - `pnpm test:camera:tri-client:smoke:ios-simulator`
  - `pnpm test:camera:tri-client:smoke:desktop-provider:ios-simulator`
  - Use these when no physical iPhone is connected. They validate provider attachment, routing, capture lifecycle, and chat result plumbing, but not real iPhone camera hardware or iOS permission prompts.
- Lightweight cross-device Studio lane:
  - `pnpm -C packages/frontend test:e2e -- tests/playwright/smoke/chat-octo-cross-device-camera-capability.spec.ts`
  - Exercises a desktop webcam provider consumed by another Studio client in the same space
- Desktop app provider lane:
  - `pnpm -C packages/desktop-app build`
  - `pnpm -C packages/frontend test:e2e:desktop:camera`
  - Launches the Electron Desktop app as the provider and a normal browser Studio tab as the consumer
- Regular regression lane:
  - `pnpm test:camera:tri-client:smoke:recommended`
  - Android hardware + iPhone simulator
- Android native capture lane:
  - `pnpm -C packages/frontend test:android:camera:smoke`
- Strongest cross-device hardware lane:
  - `pnpm test:camera:tri-client:smoke:two-devices`
  - Android hardware + physical iPhone
- Reverse physical iPhone lane:
  - `TRI_CLIENT_IOS_UDID=<device-udid> pnpm -C packages/frontend test:camera:tri-client:smoke:desktop-provider`
  - Electron Desktop publishes Camera; physical iPhone sends the chat request and consumes the desktop webcam provider

## Physical iPhone Notes

- Keep the phone unlocked and awake during XCTest startup.
- If the phone asks for a passcode or Xcode automation approval, enter/approve it before judging the smoke.
- `Automation Running` on the iPhone is expected and good: it means XCTest has cleared the Apple automation gate and is driving Instafy.
- Once `Automation Running` appears, do not touch the phone unless an iOS permission prompt is visible.
- If more than one iPhone is connected, choose one explicitly:
  - `TRI_CLIENT_IOS_UDID=<device-udid> pnpm -C packages/frontend test:camera:tri-client:smoke`
- Apple may require on-device UI automation approval.
- The separate runner app `dev.instafy.studio.uitests.xctrunner` may require developer-certificate trust even if `Instafy` itself already launches.
- If physical iPhone automation fails before Instafy starts, rerun the simulator-backed lane first to validate product logic.
- For normal iteration, prefer the simulator-backed lane. Keep physical iPhone validation for release confidence, native camera permission changes, and hardware-specific regressions.

## Troubleshooting

- If Camera says a device is offline:
  - open Instafy on that device in the same space
- If Camera says a device needs access:
  - grant camera permission on that device
- If the wrong device receives a request:
  - open `Extensions -> Camera -> Manage`
  - confirm the intended device is marked as the preferred device
- If a smoke fails because of physical iPhone XCTest setup:
  - use the recommended simulator-backed lane for normal product validation
- If physical iPhone XCTest reports `Timed out while enabling automation mode`:
  - this is an Apple automation setup failure before the Instafy UI runs
  - approve any on-device automation prompt, enter the phone passcode if requested, keep the phone unlocked, and rerun the same command
- If the smoke reports `is still locked`:
  - unlock the selected iPhone
  - keep it awake on the home screen or in Instafy
  - rerun the same command with the same `TRI_CLIENT_IOS_UDID`
- If CoreDevice cannot locate the selected device:
  - confirm it appears as `available (paired)` in `xcrun devicectl list devices`
  - unplug/replug the device or pick another connected iPhone
