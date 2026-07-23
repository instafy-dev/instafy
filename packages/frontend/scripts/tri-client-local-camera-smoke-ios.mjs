import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const IOS_TRI_CLIENT_TEST_SELECTOR =
  'AppUITests/AppUITests/testCaptureRemoteCameraProviderRequestFlow';
const IOS_READY_MARKER = 'INSTAFY_IOS_TRI_CLIENT_READY';
const IOS_CAPTURE_MARKER = 'INSTAFY_IOS_TRI_CLIENT_CAPTURED';
const IOS_APP_BUNDLE_ID = 'dev.instafy.studio';
const IOS_UI_RUNNER_BUNDLE_ID = 'dev.instafy.studio.uitests.xctrunner';
const DEFAULT_IOS_READY_TIMEOUT_MS = 420_000;
const DEFAULT_IOS_CAPTURE_TIMEOUT_MS = 240_000;

function summarizeIosWorkerFailure(output) {
  const trimmed = String(output || '').trim();
  if (!trimmed) {
    return 'iPhone camera worker failed.';
  }

  if (/Timed out while enabling automation mode/i.test(trimmed)) {
    const lines = trimmed
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    const relevant = lines.filter((line) =>
      /Timed out while enabling automation mode|The test runner failed to initialize for UI testing|Result bundle:|Attachments:|Physical-device iPhone UI tests need Apple automation approval|If the iPhone shows a prompt to enable UI automation|Keep the phone unlocked and awake/i.test(
        line,
      ),
    );
    if (relevant.length > 0) {
      return relevant.join('\n');
    }
  }

  const maxLines = 80;
  const lines = trimmed.split(/\r?\n/u);
  if (lines.length <= maxLines) {
    return trimmed;
  }
  return lines.slice(-maxLines).join('\n');
}

async function resolveIosDevelopmentTeamId(udid, bundleId = IOS_APP_BUNDLE_ID) {
  const script = `
import os
import pathlib
import plistlib
import subprocess
import sys

profiles_dir = pathlib.Path.home() / "Library" / "Developer" / "Xcode" / "UserData" / "Provisioning Profiles"
bundle_id = sys.argv[1]
udid = sys.argv[2]

if profiles_dir.exists():
    for profile_path in profiles_dir.glob("*.mobileprovision"):
        completed = subprocess.run(
            ["security", "cms", "-D", "-i", str(profile_path)],
            capture_output=True,
        )
        if completed.returncode != 0 or not completed.stdout:
            continue
        try:
            payload = plistlib.loads(completed.stdout)
        except Exception:
            continue
        entitlements = payload.get("Entitlements") or {}
        app_identifier = entitlements.get("application-identifier") or ""
        provisioned_devices = payload.get("ProvisionedDevices") or []
        team_id = (
            entitlements.get("com.apple.developer.team-identifier")
            or ((payload.get("TeamIdentifier") or [None])[0])
            or ((payload.get("ApplicationIdentifierPrefix") or [None])[0])
        )
        if (
            isinstance(app_identifier, str)
            and app_identifier.endswith("." + bundle_id)
            and isinstance(team_id, str)
            and team_id.strip()
            and (not provisioned_devices or udid in provisioned_devices)
        ):
            print(team_id.strip())
            sys.exit(0)
sys.exit(0)
`.trim();

  const { stdout } = await execFileAsync('python3', ['-c', script, bundleId, udid], {
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  const teamId = stdout.trim();
  return teamId || null;
}

async function resolvePhysicalDeviceHostIp() {
  const explicitHost = process.env.CAPACITOR_FRONTEND_HOST_IP?.trim();
  if (explicitHost) {
    return explicitHost;
  }

  for (const iface of ['en0', 'en1']) {
    try {
      const { stdout } = await execFileAsync('ipconfig', ['getifaddr', iface], {
        maxBuffer: 1024 * 1024,
        env: process.env,
      });
      const ip = stdout.trim();
      if (ip) {
        return ip;
      }
    } catch {
      // Try the next interface.
    }
  }

  throw new Error(
    'Unable to determine a LAN IP for the Mac host. Set CAPACITOR_FRONTEND_HOST_IP before running the physical iPhone camera smoke.',
  );
}

async function preparePhysicalIosFrontendBundle(repoRoot) {
  const hostIp = await resolvePhysicalDeviceHostIp();
  console.log(`Using Mac LAN host ${hostIp} for the physical iPhone bundle...`);

  try {
    await execFileAsync('pnpm', ['-C', 'packages/frontend', 'cap:sync'], {
      cwd: repoRoot,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        CAPACITOR_FRONTEND_ENV: 'local',
        CAPACITOR_FRONTEND_HOST_IP: hostIp,
      },
    });
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error.stderr === 'string' ? error.stderr : '';
    const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
    throw new Error(`Unable to sync the iPhone frontend bundle against ${hostIp}.\n${detail}`);
  }

  return hostIp;
}

async function runNodeCommand(repoRoot, args, { allowFailure = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: repoRoot,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error.stderr === 'string' ? error.stderr : '';
    const code = typeof error.code === 'number' ? error.code : 1;
    if (!allowFailure) {
      const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      throw new Error(detail || `${args.join(' ')} failed with code ${code}`);
    }
    return { code, stdout, stderr };
  }
}

function buildStudioPanelDeepLinkForProject(projectId, panelId) {
  const deepLink = new URL('instafy:///studio');
  deepLink.searchParams.set('projectId', projectId);
  deepLink.searchParams.set('panel', panelId);
  deepLink.searchParams.set('disableNativeOta', '1');
  return deepLink.toString();
}

async function resolveIosDeviceStatus(repoRoot, preferredUdid = null, timeoutMs = 45_000) {
  const args = ['scripts/ios-device-debug.mjs', 'status', '--json'];
  if (preferredUdid) {
    args.push('--udid', preferredUdid);
  }

  const deadline = Date.now() + timeoutMs;
  let lastDetail = '';

  while (Date.now() < deadline) {
    const result = await runNodeCommand(repoRoot, args, { allowFailure: true });
    let payload = null;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      payload = null;
    }
    if (payload?.device?.udid) {
      return payload;
    }

    lastDetail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  throw new Error(lastDetail || 'Unable to resolve the connected iPhone device.');
}

async function waitForIosDeviceUnlocked(repoRoot, preferredUdid = null, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;

  while (Date.now() < deadline) {
    lastStatus = await resolveIosDeviceStatus(repoRoot, preferredUdid).catch(() => lastStatus);
    const passcodeRequired = lastStatus?.lockState?.passcodeRequired;
    if (passcodeRequired !== true) {
      return lastStatus;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  const deviceName = lastStatus?.device?.name || 'the connected iPhone';
  throw new Error(
    `${deviceName} is still locked. Unlock the iPhone and keep it awake, then rerun the tri-client camera smoke.`,
  );
}

async function uninstallIosBundle(udid, bundleId) {
  try {
    await execFileAsync('xcrun', [
      'devicectl',
      'device',
      'uninstall',
      'app',
      '--device',
      udid,
      bundleId,
    ], {
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error.stderr === 'string' ? error.stderr : '';
    const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
    if (detail && !/not installed|could not be found|not found/i.test(detail)) {
      throw new Error(`Unable to uninstall ${bundleId} from ${udid}.\n${detail}`);
    }
  }
}

function shouldResetPhysicalIosAppInstall() {
  const rawValue = process.env.TRI_CLIENT_IOS_RESET_APP?.trim().toLowerCase();
  return rawValue === "1" || rawValue === "true" || rawValue === "yes";
}

function normalizeExtraEnv(extraEnv) {
  return Object.fromEntries(
    Object.entries(extraEnv ?? {}).filter(
      ([, value]) => typeof value === 'string' && value.trim().length > 0,
    ),
  );
}

function readTimeoutMs(envKey, fallbackMs) {
  const rawValue = process.env[envKey]?.trim();
  if (!rawValue) {
    return fallbackMs;
  }
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

function createMarkerWaiter({ child, marker, timeoutMs, outputRef }) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let intervalId = null;

    const cleanup = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
      }
      child.off('close', onClose);
      child.off('error', onError);
    };

    const maybeResolve = () => {
      if (outputRef.value.includes(marker)) {
        cleanup();
        resolve();
        return true;
      }
      return false;
    };

    const onClose = (code) => {
      if (maybeResolve()) {
        return;
      }
      cleanup();
      reject(
        new Error(
          `iPhone camera worker exited before emitting ${marker} (code ${code ?? 1}).\n${outputRef.value.trim()}`,
        ),
      );
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    child.once('close', onClose);
    child.once('error', onError);

    intervalId = setInterval(() => {
      if (maybeResolve()) {
        return;
      }
      if (Date.now() >= deadline) {
        cleanup();
        reject(
          new Error(
            `Timed out waiting for ${marker} from the iPhone camera worker.\n${outputRef.value.trim()}`,
          ),
        );
      }
    }, 250);
  });
}

function waitForChildExit(child, outputRef) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `iPhone camera worker failed with code ${code ?? 1}.\n${summarizeIosWorkerFailure(
            outputRef.value,
          )}`,
        ),
      );
    });
  });
}

export async function createIosTriClientPhoneSession(params) {
  const preferredUdid =
    process.env.TRI_CLIENT_IOS_UDID?.trim() || process.env.IOS_DEVICE_UDID?.trim() || null;
  const status = await resolveIosDeviceStatus(params.repoRoot, preferredUdid);
  const udid = status.device.udid;
  const deviceName = status.device.name || 'connected iPhone';
  const teamId =
    process.env.IOS_DEVELOPMENT_TEAM?.trim() ||
    (typeof status.app?.teamId === 'string' && status.app.teamId.trim() ? status.app.teamId.trim() : null) ||
    (await resolveIosDevelopmentTeamId(udid));
  const readyTimeoutMs = readTimeoutMs('TRI_CLIENT_IOS_READY_TIMEOUT_MS', DEFAULT_IOS_READY_TIMEOUT_MS);
  const captureTimeoutMs = readTimeoutMs(
    'TRI_CLIENT_IOS_CAPTURE_TIMEOUT_MS',
    DEFAULT_IOS_CAPTURE_TIMEOUT_MS,
  );
  const testSelector = params.testSelector?.trim() || IOS_TRI_CLIENT_TEST_SELECTOR;
  const readyMarker = params.readyMarker?.trim() || IOS_READY_MARKER;
  const captureMarker = params.captureMarker?.trim() || IOS_CAPTURE_MARKER;
  const extraEnv = normalizeExtraEnv(params.extraEnv);
  let preparedHostIp = null;
  let worker = null;
  let workerOutput = { value: '' };
  let workerReadyPromise = null;
  let workerCompletionPromise = null;
  let attachmentsPath = null;
  let resultBundlePath = null;

  const cleanup = async () => {
    if (!worker || worker.exitCode !== null) {
      return;
    }
    worker.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    if (worker.exitCode === null) {
      worker.kill('SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  };

  const prepareForProject = async ({ projectId, projectName, runId }) => {
    preparedHostIp = await preparePhysicalIosFrontendBundle(params.repoRoot);
    await waitForIosDeviceUnlocked(params.repoRoot, udid, 30_000);
    await uninstallIosBundle(udid, IOS_UI_RUNNER_BUNDLE_ID);
    if (shouldResetPhysicalIosAppInstall()) {
      console.log(
        "[ios-tri-client] TRI_CLIENT_IOS_RESET_APP is enabled; uninstalling Instafy before the run.",
      );
      await uninstallIosBundle(udid, IOS_APP_BUNDLE_ID);
    } else {
      console.log(
        "[ios-tri-client] Preserving the existing Instafy install so iPhone permissions survive across tri-client reruns.",
      );
    }

    resultBundlePath = path.join(params.artifactsDir, `iphone-${runId}.xcresult`);
    attachmentsPath = path.join(params.artifactsDir, `iphone-attachments-${runId}`);
    fs.mkdirSync(params.artifactsDir, { recursive: true });
    const launchUrl = buildStudioPanelDeepLinkForProject(projectId, 'extensions');

    worker = spawn(
      process.execPath,
      [
        'scripts/ios-device-debug.mjs',
        'capture',
        '--udid',
        udid,
        ...(teamId ? ['--team', teamId] : []),
        '--result-bundle-path',
        resultBundlePath,
        '--attachments-path',
        attachmentsPath,
        '--url',
        launchUrl,
        '--test',
        testSelector,
      ],
      {
        cwd: params.repoRoot,
        env: {
          ...process.env,
          CAPACITOR_FRONTEND_ENV: 'local',
          ...(preparedHostIp ? { CAPACITOR_FRONTEND_HOST_IP: preparedHostIp } : {}),
          IOS_DEVICE_SKIP_CAP_SYNC: '1',
          INSTAFY_UI_TEST_EMAIL: params.email,
          INSTAFY_UI_TEST_PASSWORD: params.password,
          INSTAFY_UI_TEST_PROJECT_ID: projectId,
          ...extraEnv,
          ...(typeof projectName === 'string' && projectName.trim()
            ? { INSTAFY_UI_TEST_PROJECT_NAME: projectName.trim() }
            : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const pipeOutput = (stream) => {
      stream.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        workerOutput.value += text;
        process.stdout.write(`[ios-tri-client] ${text}`);
      });
    };
    pipeOutput(worker.stdout);
    pipeOutput(worker.stderr);

    workerReadyPromise = createMarkerWaiter({
      child: worker,
      marker: readyMarker,
      timeoutMs: readyTimeoutMs,
      outputRef: workerOutput,
    });
    workerCompletionPromise = waitForChildExit(worker, workerOutput);
    // The main smoke only awaits this once it is ready to verify the iPhone capture.
    // Guard the promise immediately so an early worker failure does not turn into an
    // unhandled rejection that aborts the whole multi-device run mid-capture.
    workerCompletionPromise.catch(() => {});

    await workerReadyPromise;
  };

  const waitForCapture = async () => {
    if (!workerCompletionPromise) {
      throw new Error('iPhone camera worker was not started.');
    }
    await createMarkerWaiter({
      child: worker,
      marker: captureMarker,
      timeoutMs: captureTimeoutMs,
      outputRef: workerOutput,
    });
    await workerCompletionPromise;
  };

  return {
    platform: 'ios',
    udid,
    deviceName,
    prepareForProject,
    waitForCapture,
    cleanup,
    getArtifacts() {
      return {
        attachmentsPath,
        resultBundlePath,
      };
    },
  };
}
