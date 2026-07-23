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

async function resolveIosSimulatorStatus(repoRoot, preferredUdid = null) {
  const args = ['scripts/ios-simulator-debug.mjs', 'status', '--json'];
  if (preferredUdid) {
    args.push('--udid', preferredUdid);
  }
  const result = await runNodeCommand(repoRoot, args);
  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    payload = null;
  }
  if (!payload?.device?.udid) {
    throw new Error('Unable to resolve the iOS simulator device.');
  }
  return payload;
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
          `iOS simulator camera worker exited before emitting ${marker} (code ${code ?? 1}).\n${outputRef.value.trim()}`,
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
            `Timed out waiting for ${marker} from the iOS simulator camera worker.\n${outputRef.value.trim()}`,
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
          `iOS simulator camera worker failed with code ${code ?? 1}.\n${outputRef.value.trim()}`,
        ),
      );
    });
  });
}

function normalizeExtraEnv(extraEnv) {
  return Object.fromEntries(
    Object.entries(extraEnv ?? {}).filter(
      ([, value]) => typeof value === 'string' && value.trim().length > 0,
    ),
  );
}

export async function createIosSimulatorTriClientPhoneSession(params) {
  const preferredUdid = process.env.TRI_CLIENT_IOS_SIMULATOR_UDID?.trim() || process.env.IOS_SIMULATOR_UDID?.trim() || null;
  const status = await resolveIosSimulatorStatus(params.repoRoot, preferredUdid);
  const udid = status.device.udid;
  const deviceName = status.device.name || 'iPhone Simulator';
  let worker = null;
  let workerOutput = { value: '' };
  let workerCompletionPromise = null;
  let attachmentsPath = null;
  let resultBundlePath = null;
  const testSelector = params.testSelector?.trim() || IOS_TRI_CLIENT_TEST_SELECTOR;
  const readyMarker = params.readyMarker?.trim() || IOS_READY_MARKER;
  const captureMarker = params.captureMarker?.trim() || IOS_CAPTURE_MARKER;
  const extraEnv = normalizeExtraEnv(params.extraEnv);

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
    resultBundlePath = path.join(params.artifactsDir, `ios-simulator-${runId}.xcresult`);
    attachmentsPath = path.join(params.artifactsDir, `ios-simulator-attachments-${runId}`);
    fs.mkdirSync(params.artifactsDir, { recursive: true });
    const launchUrl = buildStudioPanelDeepLinkForProject(projectId, 'extensions');

    worker = spawn(
      process.execPath,
      [
        'scripts/ios-simulator-debug.mjs',
        'capture',
        '--udid',
        udid,
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
          IOS_SIMULATOR_RESET_APP: '1',
          VITE_CONTROLLER_URL: params.controllerUrl,
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
        process.stdout.write(`[ios-sim-tri-client] ${text}`);
      });
    };
    pipeOutput(worker.stdout);
    pipeOutput(worker.stderr);

    workerCompletionPromise = waitForChildExit(worker, workerOutput);

    await createMarkerWaiter({
      child: worker,
      marker: readyMarker,
      timeoutMs: 180_000,
      outputRef: workerOutput,
    });
  };

  const waitForCapture = async () => {
    if (!workerCompletionPromise) {
      throw new Error('iOS simulator camera worker was not started.');
    }
    await createMarkerWaiter({
      child: worker,
      marker: captureMarker,
      timeoutMs: 180_000,
      outputRef: workerOutput,
    });
    await workerCompletionPromise;
  };

  return {
    platform: 'ios-simulator',
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
