#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import process from 'node:process';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { resolvePrivateEnvPath } from '../../../scripts/lib/privateEnvPaths.mjs';
import {
  AUTOMATION_TMP_ROOT,
  cleanupOwnedAutomationProcesses,
  cleanupOwnedAutomationTempDirs,
  createAutomationProcessTempDir,
  createAutomationRunTempDir,
} from './automation-cleanup.mjs';
import { createIosTriClientPhoneSession } from './tri-client-local-camera-smoke-ios.mjs';
import { createIosSimulatorTriClientPhoneSession } from './tri-client-local-camera-smoke-ios-simulator.mjs';

const argv = process.argv.slice(2);

function printUsage() {
  console.log(`Usage:
  pnpm test:camera:tri-client:smoke
  pnpm test:camera:tri-client:smoke:recommended
  pnpm test:camera:tri-client:smoke:two-devices
  pnpm test:camera:tri-client:smoke:two-devices:ios-simulator

Environment overrides:
  TRI_CLIENT_MULTI_DEVICE=1
  TRI_CLIENT_MULTI_DEVICE_IOS_PLATFORM=ios|ios-simulator
  TRI_CLIENT_PHONE_PLATFORM=android|ios|ios-simulator
  TRI_CLIENT_CAMERA_FLOW=phone-provider|desktop-provider
  TRI_CLIENT_SERIAL=<adb-serial>
  TRI_CLIENT_PROMPT='@octo capture a front selfie'
  TRI_CLIENT_EXPECTED_RESPONSE='Octo captured a front photo on Taylor phone.'
  TRI_CLIENT_SECOND_PROMPT='@octo capture another front selfie'`);
}

if (argv.includes('--help') || argv.includes('-h')) {
  printUsage();
  process.exit(0);
}

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const envUser = readEnvFile(
  resolvePrivateEnvPath({ repoRoot, relativePath: '.env.user' }),
);
const dockerEnvLocal = readEnvFile(
  resolvePrivateEnvPath({ repoRoot, relativePath: 'docker/.env.local' }),
);
const baseUrl = process.env.TRI_CLIENT_BASE_URL?.trim() || 'http://127.0.0.1:5173';
const controllerUrl =
  process.env.TRI_CLIENT_CONTROLLER_URL?.trim() ||
  process.env.VITE_CONTROLLER_URL?.trim() ||
  'http://127.0.0.1:8788';
const email =
  pickEnvValue(process.env, 'TRI_CLIENT_EMAIL', 'TEST_USER_1_EMAIL') ||
  pickEnvValue(envUser, 'TRI_CLIENT_EMAIL', 'TEST_USER_1_EMAIL');
const password =
  pickEnvValue(process.env, 'TRI_CLIENT_PASSWORD', 'TEST_USER_1_PASSWORD') ||
  pickEnvValue(envUser, 'TRI_CLIENT_PASSWORD', 'TEST_USER_1_PASSWORD');
const appPackage = 'dev.instafy.studio';
const cameraPackage = 'com.sec.android.app.camera';
const inAppCameraActivityName = 'InstafyCameraCaptureActivity';
const preferredSerial =
  process.env.TRI_CLIENT_SERIAL?.trim() || process.env.ANDROID_DEVICE_SERIAL?.trim() || null;
const preferredPhonePlatform = process.env.TRI_CLIENT_PHONE_PLATFORM?.trim().toLowerCase() || null;
const preferredDesktopCdpPort = Number.parseInt(process.env.TRI_CLIENT_DESKTOP_CDP_PORT ?? '9455', 10);
const preferredAndroidWebviewPort = Number.parseInt(process.env.TRI_CLIENT_ANDROID_WEBVIEW_PORT ?? '9224', 10);
const multiDeviceMode = ['1', 'true', 'yes'].includes(
  (process.env.TRI_CLIENT_MULTI_DEVICE ?? '').trim().toLowerCase(),
);
const multiDeviceIosPlatform =
  process.env.TRI_CLIENT_MULTI_DEVICE_IOS_PLATFORM?.trim().toLowerCase() === 'ios-simulator'
    ? 'ios-simulator'
    : 'ios';
const artifactsDir = path.join(repoRoot, 'tmp', 'tri-client-local-camera-smoke');
const cameraFlow = (process.env.TRI_CLIENT_CAMERA_FLOW?.trim().toLowerCase() || 'phone-provider').replace(/_/g, '-');
const reverseDesktopProviderFlow = ['desktop-provider', 'desktop-webcam-provider', 'reverse'].includes(cameraFlow);
const reverseIosTestSelector = 'AppUITests/AppUITests/testConsumeRemoteDesktopCameraProviderRequestFlow';
const desktopFakeMediaEnabled = reverseDesktopProviderFlow && !['0', 'false', 'no', 'off'].includes(
  (process.env.TRI_CLIENT_DESKTOP_FAKE_MEDIA ?? '1').trim().toLowerCase(),
);
const expectedCameraResponse =
  process.env.TRI_CLIENT_EXPECTED_RESPONSE?.trim() || null;
const expectedCameraResponsePattern =
  expectedCameraResponse ||
  (reverseDesktopProviderFlow
    ? /^Octo captured a rear photo (?:on .+|from Camera)\.$/
    : /^Octo captured a front photo (?:on .+|from Camera)\.$/);
const cameraPrompt =
  process.env.TRI_CLIENT_PROMPT?.trim() ||
  (reverseDesktopProviderFlow ? '@octo take a photo' : '@octo capture a front selfie');
const secondCameraPrompt = process.env.TRI_CLIENT_SECOND_PROMPT?.trim() || cameraPrompt;
const automationTempDir = createAutomationRunTempDir('tri-client-local-camera-smoke', {});
const localSupabaseUrl =
  process.env.TRI_CLIENT_SUPABASE_URL?.trim() ||
  pickEnvValue(process.env, 'SUPABASE_PROJECT_URL', 'VITE_SUPABASE_URL', 'SUPABASE_URL') ||
  pickEnvValue(dockerEnvLocal, 'SUPABASE_PROJECT_URL', 'SUPABASE_URL') ||
  'http://127.0.0.1:54321';
const localSupabaseServiceRoleKey =
  pickEnvValue(process.env, 'SUPABASE_SERVICE_ROLE_KEY', 'SERVICE_ROLE_KEY') ||
  pickEnvValue(dockerEnvLocal, 'SUPABASE_SERVICE_ROLE_KEY', 'SERVICE_ROLE_KEY');

function resolveLocalReversePort(urlValue) {
  try {
    const parsed = new URL(urlValue);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      return null;
    }
    const portText = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    const port = Number.parseInt(portText, 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

const androidReversePorts = Array.from(
  new Set([54321, 8788, resolveLocalReversePort(baseUrl)].filter((value) => Number.isFinite(value))),
);

function getDefaultExpectedCameraResponsePattern() {
  return /^Octo captured a front photo (?:on .+|from Camera)\.$/;
}

function matchesExpectedContent(content, expected) {
  if (typeof content !== 'string') {
    return false;
  }
  if (expected instanceof RegExp) {
    return expected.test(content);
  }
  return content === expected;
}

function createOwnedDesktopUserDataDir() {
  return fs.mkdtempSync(path.join(automationTempDir, 'desktop-user-data-'));
}

function listSiblingAutomationTempDirs(currentTempDir) {
  if (!fs.existsSync(AUTOMATION_TMP_ROOT)) {
    return [];
  }
  const currentResolved = path.resolve(currentTempDir);
  return fs
    .readdirSync(AUTOMATION_TMP_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(AUTOMATION_TMP_ROOT, entry.name))
    .map((entryPath) => path.resolve(entryPath))
    .filter((entryPath) => entryPath !== currentResolved);
}

async function cleanupStaleAutomationRuns(currentTempDir) {
  const staleTempDirs = listSiblingAutomationTempDirs(currentTempDir);
  await cleanupOwnedAutomationProcesses({
    ownedTmpDirs: [AUTOMATION_TMP_ROOT],
    minAgeSeconds: 0,
  });
  cleanupOwnedAutomationTempDirs({
    ownedTmpDirs: staleTempDirs,
    removeEmptyRoot: false,
  });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEnvFile(contents) {
  const env = {};
  for (const rawLine of String(contents).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    if (key) env[key] = value;
  }
  return env;
}

function readEnvFile(filePath) {
  try {
    return parseEnvFile(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function pickEnvValue(env, ...keys) {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function decodeBase64UrlJson(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function extractUserIdFromAccessToken(accessToken) {
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    return null;
  }
  const segments = accessToken.split('.');
  if (segments.length < 2) {
    return null;
  }
  const payload = decodeBase64UrlJson(segments[1]);
  const subject = typeof payload?.sub === 'string' ? payload.sub.trim() : '';
  return subject || null;
}

function createConversationRoutingMetadataPatch(userId, { assistantEnabled = false, extraAgentHandles = [] } = {}) {
  if (typeof userId !== 'string' || !userId.trim()) {
    return {};
  }
  return {
    [`instafy_conversation_routing_v1_${userId.trim()}`]: {
      assistantEnabled: Boolean(assistantEnabled),
      extraAgentHandles: Array.isArray(extraAgentHandles) ? extraAgentHandles : [],
      updatedAt: new Date().toISOString(),
    },
  };
}

function normalizeSupabaseAdminUser(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  if (Array.isArray(payload.users)) {
    return payload.users.find((entry) => entry && typeof entry.id === 'string') ?? null;
  }
  if (Array.isArray(payload)) {
    return payload.find((entry) => entry && typeof entry.id === 'string') ?? null;
  }
  return typeof payload.id === 'string' ? payload : null;
}

async function ensureLocalSmokeUser() {
  if (!email || !password || !localSupabaseUrl || !localSupabaseServiceRoleKey) {
    return;
  }

  const headers = {
    apikey: localSupabaseServiceRoleKey,
    authorization: `Bearer ${localSupabaseServiceRoleKey}`,
    'content-type': 'application/json',
  };
  const normalizedEmail = email.trim().toLowerCase();
  const queryUrl = `${localSupabaseUrl.replace(/\/$/, '')}/auth/v1/admin/users?email=${encodeURIComponent(normalizedEmail)}`;

  const existingResponse = await fetch(queryUrl, { headers }).catch(() => null);
  if (existingResponse?.ok) {
    const existingPayload = await existingResponse.json().catch(() => null);
    const existingUser = normalizeSupabaseAdminUser(existingPayload);
    if (existingUser?.id) {
      const updateResponse = await fetch(
        `${localSupabaseUrl.replace(/\/$/, '')}/auth/v1/admin/users/${encodeURIComponent(existingUser.id)}`,
        {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            password,
            email_confirm: true,
          }),
        },
      );
      if (!updateResponse.ok) {
        const detail = await updateResponse.text().catch(() => '');
        throw new Error(`Unable to refresh local smoke user password: ${updateResponse.status} ${detail}`);
      }
      return;
    }
  }

  const createResponse = await fetch(`${localSupabaseUrl.replace(/\/$/, '')}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email: normalizedEmail,
      password,
      email_confirm: true,
    }),
  });
  if (createResponse.ok) {
    return;
  }
  const detail = await createResponse.text().catch(() => '');
  const normalizedDetail = detail.toLowerCase();
  if (createResponse.status === 422 && normalizedDetail.includes('already')) {
    return;
  }
  throw new Error(`Unable to provision local smoke user: ${createResponse.status} ${detail}`);
}

function resolveAdbPath() {
  const binaryName = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates = [
    process.env.ANDROID_ADB,
    process.env.ADB,
    process.env.ANDROID_SDK_ROOT
      ? path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', binaryName)
      : null,
    process.env.ANDROID_HOME
      ? path.join(process.env.ANDROID_HOME, 'platform-tools', binaryName)
      : null,
    path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', binaryName),
  ].filter(Boolean);

  return candidates[0] ?? null;
}

const adbPath = resolveAdbPath();

async function runCommand(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      maxBuffer: 16 * 1024 * 1024,
      ...options,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error.stderr === 'string' ? error.stderr : '';
    const code = typeof error.code === 'number' ? error.code : 1;
    if (!options.allowFailure) {
      const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      throw new Error(detail || `${command} ${args.join(' ')} failed with code ${code}`);
    }
    return { stdout, stderr, code };
  }
}

async function runAdb(serial, args, options = {}) {
  const prefix = serial ? ['-s', serial] : [];
  return runCommand(adbPath, [...prefix, ...args], options);
}

async function ensureAdbReverse(serial, port) {
  await runAdb(serial, ['reverse', '--remove', `tcp:${port}`], { allowFailure: true });
  await runAdb(serial, ['reverse', `tcp:${port}`, `tcp:${port}`]);
}

async function clearAdbReverse(serial, port) {
  await runAdb(serial, ['reverse', '--remove', `tcp:${port}`], { allowFailure: true });
}

function parseDeviceList(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('List of devices attached'))
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/);
      return { serial, state, detail: rest.join(' ') };
    })
    .filter((entry) => entry.serial && entry.state === 'device');
}

async function resolveDeviceSerial(preferred = null) {
  if (preferred) {
    return preferred;
  }
  const { stdout } = await runCommand(adbPath, ['devices', '-l']);
  const devices = parseDeviceList(stdout);
  if (devices.length === 0) throw new Error('No Android device is connected over adb.');
  if (devices.length > 1) throw new Error(`Multiple adb devices connected: ${devices.map((d) => d.serial).join(', ')}`);
  return devices[0].serial;
}

async function listConnectedAndroidDevices() {
  if (!adbPath) {
    return [];
  }
  const result = await runCommand(adbPath, ['devices', '-l'], { allowFailure: true });
  if (result.code !== 0) {
    return [];
  }
  return parseDeviceList(result.stdout);
}

async function resolvePhonePlatform() {
  if (
    preferredPhonePlatform === 'android' ||
    preferredPhonePlatform === 'ios' ||
    preferredPhonePlatform === 'ios-simulator'
  ) {
    return preferredPhonePlatform;
  }

  const androidDevices = await listConnectedAndroidDevices();
  if (androidDevices.length > 0) {
    return 'android';
  }

  return 'ios';
}

async function waitForWebViewList(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const pages = await response.json();
        if (Array.isArray(pages) && pages.length > 0) return pages;
      }
    } catch {}
    await sleep(500);
  }
  throw new Error(`Timed out waiting for Android WebView DevTools on :${port}`);
}

async function waitForDesktopCdp(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`Timed out waiting for Electron CDP on :${port}`);
}

async function waitForDesktopCdpOrExit(port, desktopProcess, desktopLogs, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (desktopProcess?.exitCode !== null && desktopProcess.exitCode !== 0) {
      const recentLogs = Array.isArray(desktopLogs) ? desktopLogs.slice(-40).join('') : '';
      throw new Error(
        `Desktop app exited before CDP was ready (code=${desktopProcess?.exitCode ?? 1}). Recent logs:\n${recentLogs}`,
      );
    }
    try {
      await waitForDesktopCdp(port, 1_000);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Timed out waiting for Electron CDP')) {
        throw error;
      }
    }
    await sleep(250);
  }
  const recentLogs = Array.isArray(desktopLogs) ? desktopLogs.slice(-40).join('') : '';
  const launcherNote =
    desktopProcess?.exitCode === 0
      ? '\nThe macOS launcher exited cleanly after handing off to the app, but CDP never came up.'
      : '';
  throw new Error(`Timed out waiting for Electron CDP on :${port}. Recent logs:\n${recentLogs}${launcherNote}`);
}

async function waitForDesktopTargets(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        if (Array.isArray(targets) && targets.length > 0) {
          return targets;
        }
      }
    } catch {}
    await sleep(500);
  }
  throw new Error(`Timed out waiting for Electron CDP targets on :${port}`);
}

async function connectDesktopBrowser(port, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    await waitForDesktopCdp(port, Math.min(5_000, Math.max(1_000, deadline - Date.now())));
    await waitForDesktopTargets(port, Math.min(5_000, Math.max(1_000, deadline - Date.now())));
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: Math.min(20_000, Math.max(5_000, deadline - Date.now())),
      });
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error(`Timed out attaching to Electron CDP on :${port}`);
}

async function resolveAvailablePort(preferredPort) {
  const canBindPreferred = await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(preferredPort, '127.0.0.1');
  });
  if (canBindPreferred) return preferredPort;
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address !== 'object') {
        server.close(() => reject(new Error('Unable to resolve ephemeral port.')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForFrontendUrl(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.ok || response.status === 304 || response.status === 404) {
        return;
      }
    } catch {}
    await sleep(500);
  }
  throw new Error(`Timed out waiting for frontend URL ${url}`);
}

async function terminateDesktopProcess(desktopProcess) {
  if (!desktopProcess || desktopProcess.exitCode !== null) return;
  const rootPid = typeof desktopProcess.pid === 'number' ? desktopProcess.pid : null;
  const killTree = (signal) => {
    if (!rootPid) return;
    const descendants = new Set();
    const queue = [rootPid];
    while (queue.length > 0) {
      const currentPid = queue.shift();
      if (!currentPid) continue;
      let childOutput = '';
      try {
        childOutput = execFileSync('pgrep', ['-P', String(currentPid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {}
      const childPids = childOutput.split(/\s+/).map((value) => Number.parseInt(value, 10)).filter((value) => Number.isInteger(value) && value > 0);
      for (const childPid of childPids) {
        if (descendants.has(childPid)) continue;
        descendants.add(childPid);
        queue.push(childPid);
      }
    }
    const orderedPids = [...descendants].sort((a, b) => b - a);
    for (const pid of [...orderedPids, rootPid]) {
      try { process.kill(pid, signal); } catch {}
    }
  };
  killTree('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 5000));
  if (desktopProcess.exitCode === null) {
    killTree('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function ensureFrontendServer(baseUrl, registerCleanup) {
  const studioUrl = new URL('/studio', baseUrl).toString();
  const parsedBaseUrl = new URL(baseUrl);
  const isLocal =
    (parsedBaseUrl.hostname === '127.0.0.1' || parsedBaseUrl.hostname === 'localhost') &&
    (parsedBaseUrl.protocol === 'http:' || parsedBaseUrl.protocol === 'https:');

  try {
    await waitForFrontendUrl(studioUrl, 2_000);
    return null;
  } catch (error) {
    if (!isLocal) {
      throw error;
    }
  }

  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const recentLogs = [];
  const captureLog = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      recentLogs.push(trimmed);
      if (recentLogs.length > 80) {
        recentLogs.splice(0, recentLogs.length - 80);
      }
    }
  };

  const frontendProcess = spawn(command, [
    '-C',
    path.join(repoRoot, 'packages/frontend'),
    'dev',
    '--',
    '--host',
    parsedBaseUrl.hostname,
    '--port',
    parsedBaseUrl.port || '5173',
  ], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  frontendProcess.stdout?.on('data', captureLog);
  frontendProcess.stderr?.on('data', captureLog);

  registerCleanup(async () => {
    await terminateDesktopProcess(frontendProcess).catch(() => {});
  });

  try {
    await waitForFrontendUrl(studioUrl, 120_000);
  } catch (error) {
    const logTail = recentLogs.length > 0 ? `\nRecent frontend logs:\n${recentLogs.join('\n')}` : '';
    throw new Error(`Unable to start local frontend dev server for ${studioUrl}.${logTail}`);
  }

  return frontendProcess;
}

async function readSupabaseAccessToken(page) {
  return page.evaluate(() => {
    try {
      const storage = window.localStorage;
      const authKey = Object.keys(storage).find((key) => key.startsWith('sb-') && key.endsWith('-auth-token'));
      if (!authKey) return null;
      const raw = storage.getItem(authKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const accessToken = parsed?.access_token;
      return typeof accessToken === 'string' && accessToken.trim().length > 0 ? accessToken.trim() : null;
    } catch {
      return null;
    }
  });
}

async function ensureLoggedIn(page, targetUrl, { email, password }) {
  if (targetUrl) {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  const authEvents = [];
  const pushAuthEvent = (event) => {
    authEvents.push({
      at: new Date().toISOString(),
      ...event,
    });
    if (authEvents.length > 20) {
      authEvents.shift();
    }
  };
  const isAuthUrl = (url) =>
    typeof url === 'string' &&
    (url.includes('/auth/v1/token') ||
      url.includes('/auth/v1/user') ||
      url.includes('/auth/v1/logout') ||
      url.includes('/rest/v1/users'));
  const handleResponse = async (response) => {
    const url = response.url();
    if (!isAuthUrl(url)) {
      return;
    }
    pushAuthEvent({
      type: 'response',
      status: response.status(),
      url,
    });
  };
  const handleRequestFailed = (request) => {
    const url = request.url();
    if (!isAuthUrl(url)) {
      return;
    }
    pushAuthEvent({
      type: 'requestfailed',
      url,
      error: request.failure()?.errorText ?? null,
    });
  };
  page.on('response', handleResponse);
  page.on('requestfailed', handleRequestFailed);

  const studioShellVisible = async () => {
    const hasSidebar = await page.getByTestId('sidebar-nav-chat').isVisible().catch(() => false);
    const hasChat = await page.getByTestId('chat-input').isVisible().catch(() => false);
    const hasExtensions = await page.getByRole('button', { name: /^extensions$/i }).isVisible().catch(() => false);
    const hasAssistant = await page.getByRole('button', { name: /^assistant$/i }).isVisible().catch(() => false);
    const hasOpenChat = await page.getByRole('button', { name: /^open chat$/i }).isVisible().catch(() => false);
    if (hasSidebar || hasChat || hasExtensions || hasAssistant || hasOpenChat) {
      return true;
    }

    const currentUrl = page.url();
    if (!/\/login(?:$|[?#])/.test(currentUrl)) {
      const accessToken = await readSupabaseAccessToken(page).catch(() => null);
      if (accessToken) {
        return true;
      }
    }

    return false;
  };

  const submitAuthStep = async ({ input, button, nextField = null }) => {
    await expect(button).toBeEnabled({ timeout: 15000 });

    if (input) {
      await input.press('Enter').catch(() => {});
      if (nextField) {
        const nextFieldVisible = await nextField
          .waitFor({ state: 'visible', timeout: 5000 })
          .then(() => true)
          .catch(() => false);
        if (nextFieldVisible) {
          return;
        }
      } else {
        let sidebarReady = false;
        try {
          await expect.poll(studioShellVisible, { timeout: 5000 }).toBe(true);
          sidebarReady = true;
        } catch {
          sidebarReady = false;
        }
        if (sidebarReady) {
          return;
        }
      }

      const submitted = await input
        .evaluate((element) => {
          if (!(element instanceof HTMLElement)) {
            return false;
          }
          const form = element.closest('form');
          if (!(form instanceof HTMLFormElement)) {
            return false;
          }
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit();
          } else {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          }
          return true;
        })
        .catch(() => false);
      if (submitted) {
        if (nextField) {
          const nextFieldVisible = await nextField
            .waitFor({ state: 'visible', timeout: 5000 })
            .then(() => true)
            .catch(() => false);
          if (nextFieldVisible) {
            return;
          }
        } else {
          let sidebarReady = false;
          try {
            await expect.poll(studioShellVisible, { timeout: 5000 }).toBe(true);
            sidebarReady = true;
          } catch {
            sidebarReady = false;
          }
          if (sidebarReady) {
            return;
          }
        }
      }
    }

    await button.evaluate((node) => {
      if (node instanceof HTMLElement) {
        node.click();
      }
    }).catch(() => {});
  };

  const describeLoginState = async () => {
    const currentUrl = page.url();
    const accessToken = await readSupabaseAccessToken(page).catch(() => null);
    const hasSidebar = await page.getByTestId('sidebar-nav-chat').isVisible().catch(() => false);
    const hasChat = await page.getByTestId('chat-input').isVisible().catch(() => false);
    const hasExtensions = await page.getByRole('button', { name: /^extensions$/i }).isVisible().catch(() => false);
    const hasAssistant = await page.getByRole('button', { name: /^assistant$/i }).isVisible().catch(() => false);
    const hasOpenChat = await page.getByRole('button', { name: /^open chat$/i }).isVisible().catch(() => false);
    const hasEmailInput = await page.getByRole('textbox', { name: /email address/i }).isVisible().catch(() => false);
    const passwordInput = page.getByRole('textbox', { name: /^password$/i });
    const hasPasswordInput = await passwordInput.isVisible().catch(() => false);
    const loginError = await page.getByTestId('login-error').textContent().catch(() => null);
    const loginMessage = await page.getByTestId('login-message').textContent().catch(() => null);
    const visibleContinueButton = page
      .locator('button')
      .filter({ hasText: /^(continue|working…|working\.\.\.)$/i })
      .last();
    const continueButtonText = await visibleContinueButton.textContent().catch(() => null);
    const continueButtonDisabled = await visibleContinueButton.isDisabled().catch(() => null);
    const passwordLength = hasPasswordInput
      ? await passwordInput
          .inputValue()
          .then((value) => value.length)
          .catch(() => null)
      : null;
    return {
      currentUrl,
      hasAccessToken: Boolean(accessToken),
      hasSidebar,
      hasChat,
      hasExtensions,
      hasAssistant,
      hasOpenChat,
      hasEmailInput,
      hasPasswordInput,
      passwordLength,
      continueButtonText: typeof continueButtonText === 'string' ? continueButtonText.trim() || null : null,
      continueButtonDisabled,
      loginError: typeof loginError === 'string' ? loginError.trim() || null : null,
      loginMessage: typeof loginMessage === 'string' ? loginMessage.trim() || null : null,
      authEvents: authEvents.slice(-10),
    };
  };

  try {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      if (await studioShellVisible()) return;

      const switchAccount = page.getByRole('button', { name: /log in to another account/i });
      if (await switchAccount.isVisible().catch(() => false)) {
        await switchAccount.click().catch(() => {});
      }

      const emailInput = page.getByRole('textbox', { name: /email address/i });
      if (await emailInput.isVisible().catch(() => false)) {
        await emailInput.fill(email);
        const continueButton = page.getByRole('button', { name: /^continue$/i });
        const passwordInput = page.getByRole('textbox', { name: /^password$/i });
        await submitAuthStep({
          input: emailInput,
          button: continueButton,
          nextField: passwordInput,
        });
        await passwordInput.waitFor({ state: 'visible', timeout: 30000 });
        await passwordInput.fill(password);
        await submitAuthStep({
          input: passwordInput,
          button: continueButton,
        });
        try {
          await expect.poll(studioShellVisible, { timeout: 60000 }).toBe(true);
        } catch (error) {
          const loginState = await describeLoginState().catch(() => null);
          if (loginState) {
            console.error('[tri-client-login-timeout]', JSON.stringify(loginState, null, 2));
          }
          throw error;
        }
        return;
      }

      await page.waitForTimeout(500);
    }
  } finally {
    page.off('response', handleResponse);
    page.off('requestfailed', handleRequestFailed);
  }

  throw new Error(`Timed out waiting for login/sidebar on ${page.url()}`);
}

async function readActiveProjectId(page) {
  return page.evaluate(() => {
    const fromUrl = new URL(window.location.href).searchParams.get('projectId')?.trim() ?? '';
    if (fromUrl) return fromUrl;
    const store = window.__INSTAFY_STORE__?.getState?.();
    const currentProjectId = store?.state?.project?.currentProjectId;
    return typeof currentProjectId === 'string' && currentProjectId.trim().length > 0 ? currentProjectId.trim() : null;
  });
}

async function waitForActiveProjectId(page, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const activeProjectId = await readActiveProjectId(page).catch(() => null);
    if (activeProjectId) {
      return activeProjectId;
    }
    await page.waitForTimeout(500).catch(() => {});
  }
  return null;
}

async function resolvePhoneStudioPage(context, preferredPage = null) {
  const pages = context
    .pages()
    .filter((entry) => entry.url().includes('/studio') || entry.url().includes('/login'));
  if (preferredPage && pages.includes(preferredPage)) {
    return preferredPage;
  }
  return pages[pages.length - 1] ?? preferredPage ?? context.pages()[0] ?? null;
}

async function recoverRequestedSpaceIfNeeded(page, projectId = null) {
  const normalizedProjectId =
    typeof projectId === 'string' && projectId.trim().length > 0 ? projectId.trim() : null;
  const openRequestedSpaceButton = page.getByTestId('project-missing-open-requested');
  const exactProjectCard = normalizedProjectId
    ? page.getByTestId(`project-picker-card-${normalizedProjectId}`)
    : null;
  const orgFilter = page.getByTestId('project-picker-org-filter');
  const searchToggle = page.getByTestId('project-picker-search-toggle');
  const searchInput = page.getByTestId('project-picker-search');
  const pickerCandidate = await page
    .getByText(/^Space not found$/)
    .isVisible()
    .catch(() => false);
  const exactProjectVisible = exactProjectCard
    ? await exactProjectCard.isVisible().catch(() => false)
    : false;
  const canOpenRequestedSpace = await openRequestedSpaceButton.isVisible().catch(() => false);
  if (!pickerCandidate && !canOpenRequestedSpace && !exactProjectVisible) {
    return false;
  }
  if (exactProjectVisible && exactProjectCard) {
    await exactProjectCard.click().catch(async () => {
      await exactProjectCard.click({ force: true }).catch(() => {});
    });
    await page.waitForTimeout(1_000).catch(() => {});
    return true;
  }
  if (canOpenRequestedSpace) {
    await openRequestedSpaceButton.click().catch(async () => {
      await openRequestedSpaceButton.click({ force: true }).catch(() => {});
    });
    await page.waitForTimeout(1_000).catch(() => {});
    return true;
  }
  if (normalizedProjectId) {
    if (await orgFilter.isVisible().catch(() => false)) {
      await orgFilter.selectOption('all').catch(() => {});
      await page.waitForTimeout(500).catch(() => {});
      const visibleAfterAllTeams = exactProjectCard
        ? await exactProjectCard.isVisible().catch(() => false)
        : false;
      if (visibleAfterAllTeams && exactProjectCard) {
        await exactProjectCard.click().catch(async () => {
          await exactProjectCard.click({ force: true }).catch(() => {});
        });
        await page.waitForTimeout(1_000).catch(() => {});
        return true;
      }
    }
    if (await searchToggle.isVisible().catch(() => false)) {
      await searchToggle.click().catch(async () => {
        await searchToggle.click({ force: true }).catch(() => {});
      });
      await page.waitForTimeout(500).catch(() => {});
    }
    if (await searchInput.isVisible().catch(() => false)) {
      const searchTerm = normalizedProjectId.slice(0, 8);
      await searchInput.fill(searchTerm).catch(() => {});
      await page.waitForTimeout(750).catch(() => {});
      const filteredProjectVisible = exactProjectCard
        ? await exactProjectCard.isVisible().catch(() => false)
        : false;
      if (filteredProjectVisible && exactProjectCard) {
        await exactProjectCard.click().catch(async () => {
          await exactProjectCard.click({ force: true }).catch(() => {});
        });
        await page.waitForTimeout(1_000).catch(() => {});
        return true;
      }
    }
  }
  return false;
}

async function waitForPhoneProject(page, context, projectId, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let currentPage = page;
  while (Date.now() < deadline) {
    currentPage = (await resolvePhoneStudioPage(context, currentPage)) ?? currentPage;
    if (!currentPage) break;
    const activeProjectId = await readActiveProjectId(currentPage).catch(() => null);
    if (activeProjectId === projectId) {
      await waitForPhoneReady(currentPage);
      return currentPage;
    }
    const recoveredRequestedSpace = await recoverRequestedSpaceIfNeeded(currentPage, projectId).catch(() => false);
    if (recoveredRequestedSpace) {
      await currentPage.waitForTimeout(1_000).catch(() => {});
      continue;
    }
    await currentPage.waitForTimeout(500).catch(() => {});
  }
  const resolvedPage = (await resolvePhoneStudioPage(context, currentPage)) ?? currentPage;
  const finalProjectId = resolvedPage ? await readActiveProjectId(resolvedPage).catch(() => null) : null;
  throw new Error(
    `Timed out waiting for Android to switch to project ${projectId}. activeProjectId=${finalProjectId ?? 'null'} url=${resolvedPage?.url() ?? 'n/a'}`,
  );
}

async function recoverPhoneStudioPage(page, context, projectId, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let currentPage = page;
  while (Date.now() < deadline) {
    currentPage = (await resolvePhoneStudioPage(context, currentPage)) ?? currentPage;
    if (!currentPage) break;
    const activeProjectId = await readActiveProjectId(currentPage).catch(() => null);
    if (activeProjectId === projectId) {
      const chatVisible = await currentPage.getByTestId('chat-input').isVisible().catch(() => false);
      const sidebarVisible = await currentPage.getByTestId('sidebar-nav-chat').isVisible().catch(() => false);
      if (chatVisible || sidebarVisible) {
        return currentPage;
      }
    }
    await currentPage.waitForTimeout(500).catch(() => {});
  }
  return currentPage;
}

async function requestJson(url, { accessToken, method = 'GET', body, retries = 0 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (response.ok) return json;
    lastError = new Error(`${method} ${url} failed (${response.status} ${response.statusText}): ${text}`);
    await sleep(1000 * (attempt + 1));
  }
  throw lastError ?? new Error(`${method} ${url} failed`);
}

async function getProjectSummary(projectId, accessToken) {
  return requestJson(`${controllerUrl}/projects/${encodeURIComponent(projectId)}`, { accessToken, retries: 2 });
}

async function createProjectInOrg(orgId, projectName, accessToken) {
  return requestJson(`${controllerUrl}/orgs/${encodeURIComponent(orgId)}/projects`, {
    accessToken,
    method: 'POST',
    retries: 2,
    body: { projectType: 'customer', projectName },
  });
}

async function createBlankConversation(projectId, accessToken) {
  return requestJson(`${controllerUrl}/projects/${encodeURIComponent(projectId)}/conversations/blank`, {
    accessToken,
    method: 'POST',
    retries: 2,
    body: { sessionId: null, metadata: {} },
  });
}

async function updateConversationMetadata(conversationControllerId, accessToken, metadata) {
  return requestJson(`${controllerUrl}/conversations/${encodeURIComponent(conversationControllerId)}`, {
    accessToken,
    method: 'PATCH',
    retries: 2,
    body: { metadata },
  });
}

async function disableAssistantForBootstrapConversation(conversationControllerId, accessToken) {
  const userId = extractUserIdFromAccessToken(accessToken);
  if (!userId) {
    throw new Error('Unable to derive user id from access token for bootstrap conversation routing.');
  }
  const metadata = createConversationRoutingMetadataPatch(userId, {
    assistantEnabled: false,
    extraAgentHandles: [],
  });
  await updateConversationMetadata(conversationControllerId, accessToken, metadata);
}

async function fetchConversationMessages(conversationControllerId, accessToken) {
  const payload = await requestJson(
    `${controllerUrl}/conversations/${encodeURIComponent(conversationControllerId)}/messages?limit=100`,
    { accessToken, retries: 5 },
  );
  return Array.isArray(payload?.messages) ? payload.messages : [];
}

async function listProviderRequests(projectId, providerId, accessToken, statuses = ['pending', 'claimed', 'completed', 'failed', 'expired']) {
  const url = new URL(
    `${controllerUrl}/projects/${encodeURIComponent(projectId)}/provider-requests`,
  );
  url.searchParams.set('providerId', providerId);
  if (statuses.length > 0) {
    url.searchParams.set('statuses', statuses.join(','));
  }
  url.searchParams.set('limit', '10');
  const payload = await requestJson(url.toString(), { accessToken, retries: 2 });
  return Array.isArray(payload) ? payload : [];
}

async function getLatestProviderRequest(projectId, providerId, accessToken) {
  const requests = await listProviderRequests(projectId, providerId, accessToken);
  return requests[0] ?? null;
}

async function listProjectIntegrations(projectId, accessToken) {
  const payload = await requestJson(
    `${controllerUrl}/projects/${encodeURIComponent(projectId)}/integrations`,
    { accessToken, retries: 2 },
  );
  return Array.isArray(payload) ? payload : [];
}

function normalizeIntegrationPreferredProviderId(integration) {
  const metadata =
    integration?.metadata && typeof integration.metadata === 'object' && !Array.isArray(integration.metadata)
      ? integration.metadata
      : {};
  const selection =
    metadata.providerFamilySelection &&
    typeof metadata.providerFamilySelection === 'object' &&
    !Array.isArray(metadata.providerFamilySelection)
      ? metadata.providerFamilySelection
      : null;
  const preferredProviderId =
    typeof selection?.preferredProviderId === 'string' && selection.preferredProviderId.trim().length > 0
      ? selection.preferredProviderId.trim().toLowerCase()
      : typeof metadata.preferredProviderId === 'string' && metadata.preferredProviderId.trim().length > 0
        ? metadata.preferredProviderId.trim().toLowerCase()
        : null;
  return preferredProviderId;
}

function isAttachedCameraIntegration(integration) {
  if (!integration || typeof integration !== 'object') {
    return false;
  }
  const provider =
    typeof integration.provider === 'string' ? integration.provider.trim().toLowerCase() : '';
  if (!provider.startsWith('camera')) {
    return false;
  }
  const status =
    typeof integration.status === 'string' ? integration.status.trim().toLowerCase() : '';
  const metadata =
    integration.metadata && typeof integration.metadata === 'object' && !Array.isArray(integration.metadata)
      ? integration.metadata
      : {};
  return (
    ['attached', 'available', 'connected', 'enabled'].includes(status) &&
    metadata.attached !== false &&
    metadata.enabled !== false
  );
}

function resolveCameraIntegrationPlatform(integration) {
  const metadata =
    integration?.metadata && typeof integration.metadata === 'object' && !Array.isArray(integration.metadata)
      ? integration.metadata
      : {};
  const selectedDevice =
    metadata.selectedDevice && typeof metadata.selectedDevice === 'object' && !Array.isArray(metadata.selectedDevice)
      ? metadata.selectedDevice
      : null;
  return selectedDevice?.nativePlatform === 'android' || selectedDevice?.nativePlatform === 'ios'
    ? selectedDevice.nativePlatform
    : null;
}

async function waitForAttachedCameraIntegrations(projectId, accessToken, { expectedCount = 1, timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastCameraIntegrations = [];
  while (Date.now() < deadline) {
    const integrations = await listProjectIntegrations(projectId, accessToken);
    const cameraIntegrations = integrations.filter(isAttachedCameraIntegration);
    const androidIntegration =
      cameraIntegrations.find((entry) => resolveCameraIntegrationPlatform(entry) === 'android') ?? null;
    const iosIntegration =
      cameraIntegrations.find((entry) => resolveCameraIntegrationPlatform(entry) === 'ios') ?? null;
    lastCameraIntegrations = cameraIntegrations;
    if (cameraIntegrations.length >= expectedCount) {
      return {
        all: cameraIntegrations,
        androidIntegration,
        iosIntegration,
      };
    }
    await sleep(1_000);
  }
  throw new Error(
    `Timed out waiting for ${expectedCount} attached Camera integration(s). Last seen: ${JSON.stringify(
      lastCameraIntegrations.map((entry) => ({
        provider: entry.provider,
        preferredProviderId: normalizeIntegrationPreferredProviderId(entry),
        nativePlatform: resolveCameraIntegrationPlatform(entry),
      })),
    )}`,
  );
}

async function waitForPreferredCameraProvider(projectId, accessToken, expectedProviderId, timeoutMs = 45_000) {
  const normalizedExpectedProviderId = expectedProviderId.trim().toLowerCase();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const integrations = await listProjectIntegrations(projectId, accessToken);
    const matchingIntegration = integrations.find(
      (entry) =>
        isAttachedCameraIntegration(entry) &&
        normalizeIntegrationPreferredProviderId(entry) === normalizedExpectedProviderId,
    );
    if (matchingIntegration) {
      return matchingIntegration;
    }
    await sleep(1_000);
  }
  throw new Error(`Timed out waiting for Camera preferred provider ${normalizedExpectedProviderId}.`);
}

function countConversationMessages(messages, { role, content, contentPattern }) {
  return messages.filter(
    (entry) =>
      (!role || entry?.role === role) &&
      (!content || entry?.content === content) &&
      (!contentPattern || matchesExpectedContent(entry?.content, contentPattern)),
  ).length;
}

function summarizeConversationMessages(messages, limit = 12) {
  return messages.slice(-limit).map((entry) => ({
    role: typeof entry?.role === 'string' ? entry.role : null,
    content:
      typeof entry?.content === 'string' && entry.content.trim().length > 0
        ? entry.content.trim()
        : null,
    createdAt: typeof entry?.createdAt === 'string' ? entry.createdAt : null,
  }));
}

async function waitForConversationMessageCount(
  conversationControllerId,
  accessToken,
  { role, content, contentPattern, minimumCount, timeoutMs = 45_000 },
) {
  const deadline = Date.now() + timeoutMs;
  let lastMessages = [];
  while (Date.now() < deadline) {
    lastMessages = await fetchConversationMessages(conversationControllerId, accessToken);
    if (countConversationMessages(lastMessages, { role, content, contentPattern }) >= minimumCount) {
      return lastMessages;
    }
    await sleep(1_500);
  }
  throw new Error(
    `Timed out waiting for ${minimumCount} conversation message(s) for role=${role ?? '*'} content=${content ?? contentPattern ?? '*'} on ${conversationControllerId}. Last messages: ${JSON.stringify(
      summarizeConversationMessages(lastMessages),
    )}`,
  );
}

async function waitForProviderRequestAfter(
  projectId,
  providerId,
  accessToken,
  { afterMs, statuses = ['pending', 'claimed', 'completed'], timeoutMs = 45_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  const minimumTimestamp = Number.isFinite(afterMs) ? Number(afterMs) : 0;
  while (Date.now() < deadline) {
    const requests = await listProviderRequests(projectId, providerId, accessToken, statuses);
    const matchingRequest =
      requests.find((request) => {
        const createdAtMs =
          typeof request?.createdAt === 'string' ? Date.parse(request.createdAt) : Number.NaN;
        return Number.isFinite(createdAtMs) && createdAtMs >= minimumTimestamp;
      }) ?? null;
    if (matchingRequest) {
      return matchingRequest;
    }
    await sleep(1_000);
  }
  throw new Error(`Timed out waiting for provider request on ${providerId}.`);
}

async function waitForConversationMessage(
  conversationControllerId,
  accessToken,
  { role, content, contentPattern, timeoutMs = 45000 },
) {
  const deadline = Date.now() + timeoutMs;
  let lastMessages = [];
  while (Date.now() < deadline) {
    lastMessages = await fetchConversationMessages(conversationControllerId, accessToken);
    if (
      lastMessages.some(
        (entry) =>
          entry?.role === role &&
          ((content && entry?.content === content) ||
            (contentPattern && matchesExpectedContent(entry?.content, contentPattern))),
      )
    ) {
      return lastMessages;
    }
    await sleep(1500);
  }
  throw new Error(
    `Timed out waiting for conversation message role=${role} content=${content ?? contentPattern ?? '*'} on ${conversationControllerId}. Last messages: ${JSON.stringify(
      summarizeConversationMessages(lastMessages),
    )}`,
  );
}

async function readActiveConversationDebug(page) {
  return page.evaluate(() => {
    const debug = window.__INSTAFY_CONVERSATIONS_DEBUG__;
    if (!debug || typeof debug !== 'object') {
      return null;
    }
    const normalizeText = (value) =>
      typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
    return {
      activeConversationLocalId: normalizeText(debug.activeConversationLocalId),
      activeConversationControllerId: normalizeText(debug.activeConversationControllerId),
      activeConversationAssistantEnabled:
        typeof debug.activeConversationAssistantEnabled === 'boolean'
          ? debug.activeConversationAssistantEnabled
          : null,
      activeConversationExtraAgentHandles: Array.isArray(debug.activeConversationExtraAgentHandles)
        ? debug.activeConversationExtraAgentHandles
            .map((value) => normalizeText(value))
            .filter((value) => typeof value === 'string')
        : [],
      conversations: Array.isArray(debug.conversations)
        ? debug.conversations.map((entry) => ({
            localId: normalizeText(entry?.localId),
            controllerId: normalizeText(entry?.controllerId),
            title: normalizeText(entry?.title),
            assistantEnabled:
              typeof entry?.assistantEnabled === 'boolean' ? entry.assistantEnabled : null,
            extraAgentHandles: Array.isArray(entry?.extraAgentHandles)
              ? entry.extraAgentHandles
                  .map((value) => normalizeText(value))
                  .filter((value) => typeof value === 'string')
              : [],
          }))
        : [],
    };
  });
}

function isAssistantDisabledDebug(debug, expectedConversationControllerId = null) {
  if (!debug || typeof debug !== 'object') {
    return false;
  }
  if (
    expectedConversationControllerId &&
    debug.activeConversationControllerId !== expectedConversationControllerId
  ) {
    return false;
  }
  return (
    debug.activeConversationAssistantEnabled === false &&
    Array.isArray(debug.activeConversationExtraAgentHandles) &&
    debug.activeConversationExtraAgentHandles.length === 0
  );
}

async function openConversation(page, projectId, conversationControllerId) {
  const target = new URL('/studio', baseUrl);
  target.searchParams.set('projectId', projectId);
  target.searchParams.set('conversationControllerId', conversationControllerId);
  await page.goto(target.toString(), { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const activeProjectId = await readActiveProjectId(page).catch(() => null);
    const activeConversationDebug = await readActiveConversationDebug(page).catch(() => null);
    if (
      activeProjectId === projectId &&
      activeConversationDebug?.activeConversationControllerId === conversationControllerId
    ) {
      break;
    }
    const recoveredRequestedSpace = await recoverRequestedSpaceIfNeeded(page, projectId).catch(() => false);
    if (!recoveredRequestedSpace) {
      await page.waitForTimeout(500).catch(() => {});
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out opening conversation ${conversationControllerId} for project ${projectId} on ${page.url()}. Active conversation debug: ${JSON.stringify(
          activeConversationDebug,
        )}`,
      );
    }
  }
  await page.getByTestId('chat-input').waitFor({ state: 'visible', timeout: 60000 }).catch(() => {});
}

function isConversationRecordResponse(response, expectedConversationControllerId) {
  if (response.request().method() !== 'POST') {
    return false;
  }
  const url = response.url();
  if (!/\/conversations\/[^/]+\/messages\/record(?:[?#]|$)/.test(url)) {
    return false;
  }
  if (!expectedConversationControllerId) {
    return true;
  }
  return url.includes(`/conversations/${encodeURIComponent(expectedConversationControllerId)}/messages/record`);
}

async function sendChatMessage(page, message, { conversationControllerId = null } = {}) {
  await dismissOnboardingPrompt(page).catch(() => {});
  await openPanel(page, 'chat').catch(() => {});
  await page.getByRole('button', { name: /^open chat$/i }).click().catch(() => {});
  await dismissOnboardingPrompt(page).catch(() => {});
  const chatInput = page.getByTestId('chat-input');
  await chatInput.waitFor({ state: 'visible', timeout: 30000 });
  const sendButton = page.getByTestId('chat-send-button');
  const localEchoMatches = page.getByText(message);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const baselineLocalEchoCount = await localEchoMatches.count().catch(() => 0);
    const recordResponsePromise = page
      .waitForResponse(
        (response) => isConversationRecordResponse(response, conversationControllerId),
        { timeout: 15_000 },
      )
      .then(async (response) => ({
        url: response.url(),
        status: response.status(),
        ok: response.ok(),
        body: await response.text().catch(() => null),
      }))
      .catch(() => null);
    await chatInput.fill(message);
    await expect(sendButton).toBeEnabled({ timeout: 30000 });
    await sendButton.click().catch(async () => {
      await sendButton.click({ force: true }).catch(async () => {
        await chatInput.press('Enter').catch(() => {});
      });
    });

    const localEchoDeadline = Date.now() + 10_000;
    let echoedLocally = false;
    while (Date.now() < localEchoDeadline) {
      const currentLocalEchoCount = await localEchoMatches.count().catch(() => 0);
      if (currentLocalEchoCount > baselineLocalEchoCount) {
        echoedLocally = true;
        break;
      }
      await page.waitForTimeout(250);
    }
    if (echoedLocally) {
      const recordResponse = await recordResponsePromise;
      if (recordResponse?.ok) {
        await page.waitForTimeout(500);
        return;
      }
      await page.waitForTimeout(500);
      const activeConversationDebug = await readActiveConversationDebug(page).catch(() => null);
      throw new Error(
        `Local chat echo appeared but controller did not confirm message persistence for "${message}". recordResponse=${JSON.stringify(
          recordResponse,
        )} activeConversationDebug=${JSON.stringify(activeConversationDebug)}`,
      );
    }

    const remainingComposerValue = await chatInput.inputValue().catch(() => '');
    const sendDisabled = await sendButton.isDisabled().catch(() => null);
    if (!remainingComposerValue.trim() || sendDisabled === false) {
      await dismissOnboardingPrompt(page).catch(() => {});
      await openPanel(page, 'chat').catch(() => {});
      await page.waitForTimeout(500);
      continue;
    }
  }

  const remainingComposerValue = await chatInput.inputValue().catch(() => '');
  const sendDisabled = await sendButton.isDisabled().catch(() => null);
  throw new Error(
    `Timed out sending chat message "${message}". composerValue=${JSON.stringify(
      remainingComposerValue,
    )} sendDisabled=${sendDisabled}`,
  );
}

async function expectUserMessageVisible(page, message) {
  await expect(page.getByText(message).last()).toBeVisible({ timeout: 60000 });
}

async function waitForAssistantText(page, textOrPattern, timeoutMs = 120000) {
  await dismissOnboardingPrompt(page).catch(() => {});
  await openPanel(page, 'chat').catch(() => {});
  await page.getByRole('button', { name: /^open chat$/i }).click().catch(() => {});
  await expect(page.getByText(textOrPattern).last()).toBeVisible({ timeout: timeoutMs });
}

async function dismissOnboardingPrompt(page) {
  const candidates = [
    page.getByRole('button', { name: /not now/i }),
    page.getByText(/^Not now$/i).last(),
  ];
  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click().catch(async () => {
        await candidate.click({ force: true }).catch(() => {});
      });
      await page.waitForTimeout(500);
      return;
    }
  }
}

function buildStudioPanelDeepLinkForProject(projectId, panelId) {
  const deepLink = new URL('instafy:///studio');
  deepLink.searchParams.set('projectId', projectId);
  deepLink.searchParams.set('panel', panelId);
  return deepLink.toString();
}

async function openStudioProjectPanelViaDeepLink(serial, projectId, panelId) {
  const deepLink = buildStudioPanelDeepLinkForProject(projectId, panelId);
  await runAdb(serial, ['shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', deepLink, appPackage], { allowFailure: true });
}

async function openAndroidProjectPanel(serial, page, context, projectId, panelId, timeoutMs = 45_000) {
  const targetTestId = panelId === 'chat' ? 'chat-input' : 'extensions-panel';
  const deadline = Date.now() + timeoutMs;
  let currentPage = page;
  while (Date.now() < deadline) {
    await openStudioProjectPanelViaDeepLink(serial, projectId, panelId);
    currentPage = await waitForPhoneProject(currentPage, context, projectId, Math.min(20_000, timeoutMs));
    await dismissOnboardingPrompt(currentPage).catch(() => {});
    await openPanel(currentPage, panelId).catch(() => {});
    const targetVisible = await currentPage
      .getByTestId(targetTestId)
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (targetVisible) {
      return currentPage;
    }
    await currentPage.waitForTimeout(750).catch(() => {});
  }
  const fallbackUrl = new URL('/studio', baseUrl);
  fallbackUrl.searchParams.set('projectId', projectId);
  fallbackUrl.searchParams.set('panel', panelId);
  await currentPage.goto(fallbackUrl.toString(), { waitUntil: 'domcontentloaded' }).catch(() => {});
  await waitForPhoneReady(currentPage).catch(() => {});
  await dismissOnboardingPrompt(currentPage).catch(() => {});
  await openPanel(currentPage, panelId).catch(() => {});
  const fallbackTargetVisible = await currentPage
    .getByTestId(targetTestId)
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (fallbackTargetVisible) {
    return currentPage;
  }
  throw new Error(`Timed out opening the ${panelId} panel on Android for project ${projectId}.`);
}

async function waitForAppPid(serial, packageName, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await runAdb(serial, ['shell', 'pidof', packageName], { allowFailure: true });
    const pid = result.stdout.trim();
    if (pid) return pid;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for pidof ${packageName}`);
}

async function getDisplaySize(serial) {
  const { stdout } = await runAdb(serial, ['shell', 'wm', 'size']);
  const match = stdout.match(/Physical size:\s*(\d+)x(\d+)/i);
  if (!match) return { width: 1080, height: 2280 };
  return { width: Number.parseInt(match[1], 10), height: Number.parseInt(match[2], 10) };
}

async function wakeAndDismissKeyguard(serial) {
  const { width, height } = await getDisplaySize(serial);
  const centerX = Math.round(width / 2);
  await runAdb(serial, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { allowFailure: true });
  await runAdb(serial, ['shell', 'wm', 'dismiss-keyguard'], { allowFailure: true });
  await runAdb(serial, ['shell', 'input', 'swipe', String(centerX), String(Math.round(height * 0.9)), String(centerX), String(Math.round(height * 0.3)), '250'], { allowFailure: true });
  await sleep(500);
  await runAdb(serial, ['shell', 'wm', 'dismiss-keyguard'], { allowFailure: true });
}

async function waitForResumedPackage(serial, packageName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lockedCount = 0;
  while (Date.now() < deadline) {
    const resumedActivity = await getResumedActivity(serial);
    if (isLikelyKeyguardActivity(resumedActivity)) {
      lockedCount += 1;
      if (lockedCount >= 3) {
        throw new Error('The connected Android device is locked. Unlock it and keep the screen awake before rerunning the tri-client smoke.');
      }
    } else {
      lockedCount = 0;
    }
    if (resumedActivity && resumedActivity.packageName === packageName) return resumedActivity;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${packageName} to become resumed activity.`);
}

async function launchInstafyApp(serial, timeoutMs = 15_000) {
  const launchAttempts = [
    ['shell', 'am', 'start', '-W', '-n', `${appPackage}/.MainActivity`],
    ['shell', 'input', 'keyevent', 'KEYCODE_HOME'],
    ['shell', 'am', 'start', '-W', '-n', `${appPackage}/.MainActivity`],
    ['shell', 'monkey', '-p', appPackage, '-c', 'android.intent.category.LAUNCHER', '1'],
  ];

  for (const args of launchAttempts) {
    await runAdb(serial, args, { allowFailure: true });
    await wakeAndDismissKeyguard(serial);
    await ensureAndroidDeviceUnlocked(serial, 'android session bootstrap');
    try {
      await waitForResumedPackage(serial, appPackage, timeoutMs);
      return;
    } catch (error) {
      if (args === launchAttempts[launchAttempts.length - 1]) {
        throw error;
      }
    }
  }
}

async function getResumedActivity(serial) {
  const { stdout } = await runAdb(serial, ['shell', 'dumpsys', 'activity', 'activities']);
  const match = stdout.match(/mResumedActivity:.*?\s([A-Za-z0-9._$]+)\/([A-Za-z0-9._$/]+)\s/);
  if (!match) {
    return null;
  }
  return { packageName: match[1], activity: match[2] };
}

function isLikelyKeyguardActivity(resumedActivity) {
  if (!resumedActivity || resumedActivity.packageName !== 'com.android.systemui') {
    return false;
  }
  return /keyguard|bouncer|password|pin/.test(`${resumedActivity.activity}`.toLowerCase());
}

async function waitForResumedActivityMatch(serial, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastResumed = null;
  let lockedCount = 0;
  while (Date.now() < deadline) {
    const resumedActivity = await getResumedActivity(serial);
    lastResumed = resumedActivity;
    if (isLikelyKeyguardActivity(resumedActivity)) {
      lockedCount += 1;
      if (lockedCount >= 3) {
        throw new Error('The connected Android device is locked. Unlock it and keep the screen awake before rerunning the tri-client smoke.');
      }
    } else {
      lockedCount = 0;
    }
    if (resumedActivity && predicate(resumedActivity)) {
      return resumedActivity;
    }
    await sleep(500);
  }
  const suffix = lastResumed
    ? ` last resumed ${lastResumed.packageName}/${lastResumed.activity}`
    : '';
  throw new Error(`Timed out waiting for ${label}.${suffix}`);
}

async function waitForCameraForeground(serial, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastResumed = null;
  let lockedCount = 0;
  while (Date.now() < deadline) {
    const resumedActivity = await getResumedActivity(serial);
    lastResumed = resumedActivity;
    if (isLikelyKeyguardActivity(resumedActivity)) {
      lockedCount += 1;
      if (lockedCount >= 3) {
        throw new Error('The connected Android device is locked. Unlock it and keep the screen awake before rerunning the tri-client smoke.');
      }
    } else {
      lockedCount = 0;
    }
    if (
      resumedActivity &&
      (
        (
          resumedActivity.packageName === appPackage &&
          resumedActivity.activity.includes(inAppCameraActivityName)
        ) ||
        (
          resumedActivity.packageName !== appPackage &&
          `${resumedActivity.packageName}/${resumedActivity.activity}`.toLowerCase().match(/camera|capture|photo/)
        )
      )
    ) {
      return resumedActivity;
    }
    await sleep(500);
  }
  const suffix = lastResumed
    ? ` last resumed ${lastResumed.packageName}/${lastResumed.activity}`
    : '';
  throw new Error(`Timed out waiting for a camera activity to become resumed.${suffix}`);
}

async function dumpUiHierarchy(serial, stem) {
  const remotePath = `/sdcard/${stem}.xml`;
  await runAdb(serial, ['shell', 'uiautomator', 'dump', remotePath], { allowFailure: true });
  const { stdout } = await runAdb(serial, ['shell', 'cat', remotePath], { allowFailure: true });
  return stdout;
}

async function deviceAppearsLocked(serial) {
  const xml = await dumpUiHierarchy(serial, 'tri-client-device-lock-check');
  return /Enter PIN to open|Device locked|keyguard_host_view|pinEntry/i.test(xml);
}

async function ensureAndroidDeviceUnlocked(serial, contextLabel) {
  if (await deviceAppearsLocked(serial)) {
    throw new Error(`The connected Android device is locked during ${contextLabel}. Unlock it and keep the screen awake before rerunning the tri-client smoke.`);
  }
}

function parseUiNodeBounds(xml, textMatcher) {
  const matcher = typeof textMatcher === 'string' ? (value) => value === textMatcher : (value) => textMatcher.test(value);
  const nodePattern = /text="([^"]*)"[^>]*bounds="(\[\d+,\d+\]\[\d+,\d+\])"/g;
  let match;
  while ((match = nodePattern.exec(xml)) !== null) {
    if (matcher(match[1])) return match[2];
  }
  return null;
}

function parseUiNodeBoundsByAttributes(xml, predicate) {
  const nodePattern = /<node\b[^>]*bounds="(\[\d+,\d+\]\[\d+,\d+\])"[^>]*\/?>/g;
  let match;
  while ((match = nodePattern.exec(xml)) !== null) {
    const node = match[0];
    const readAttribute = (name) => {
      const attributeMatch = node.match(new RegExp(`${name}="([^"]*)"`, 'i'));
      return attributeMatch?.[1] ?? '';
    };
    const attrs = {
      text: readAttribute('text'),
      resourceId: readAttribute('resource-id'),
      contentDesc: readAttribute('content-desc'),
      className: readAttribute('class'),
      enabled: readAttribute('enabled'),
    };
    if (predicate(attrs)) return match[1];
  }
  return null;
}

function parseBoundsCenter(bounds) {
  const match = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) return null;
  const left = Number.parseInt(match[1], 10);
  const top = Number.parseInt(match[2], 10);
  const right = Number.parseInt(match[3], 10);
  const bottom = Number.parseInt(match[4], 10);
  return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
}

async function tapUiNodeWithText(serial, textMatcher) {
  const xml = await dumpUiHierarchy(serial, 'tri-client-camera-smoke-ui');
  const bounds = parseUiNodeBounds(xml, textMatcher);
  const center = bounds ? parseBoundsCenter(bounds) : null;
  if (!center) return false;
  await runAdb(serial, ['shell', 'input', 'tap', String(center.x), String(center.y)]);
  return true;
}

async function maybeDismissLocationPrompt(serial) {
  for (const text of ['Cancel', 'Not now']) {
    const tapped = await tapUiNodeWithText(serial, text);
    if (tapped) {
      await sleep(500);
      return true;
    }
  }
  return false;
}

async function maybeConfirmCapturedPhoto(serial) {
  const confirmed = await tapUiNodeWithText(serial, 'OK');
  if (confirmed) await sleep(500);
  return confirmed;
}

async function triggerCameraShutter(serial) {
  const isInstafyShutter = (attrs) =>
    attrs.contentDesc === 'Instafy camera shutter' ||
    attrs.resourceId === `${appPackage}:id/instafy_camera_shutter`;
  const isSystemCameraShutter = (attrs) =>
    attrs.contentDesc === 'Take picture' ||
    attrs.resourceId === 'com.sec.android.app.camera:id/normal_center_button';
  const deadline = Date.now() + 12_000;
  let sawDisabledInstafyShutter = false;

  while (Date.now() < deadline) {
    const xml = await dumpUiHierarchy(serial, 'tri-client-camera-smoke-shutter');
    const readyInstafyBounds = parseUiNodeBoundsByAttributes(
      xml,
      (attrs) => isInstafyShutter(attrs) && attrs.enabled !== 'false',
    );
    const readyInstafyCenter = readyInstafyBounds ? parseBoundsCenter(readyInstafyBounds) : null;
    if (readyInstafyCenter) {
      await runAdb(serial, ['shell', 'input', 'tap', String(readyInstafyCenter.x), String(readyInstafyCenter.y)]);
      return;
    }

    const systemShutterBounds = parseUiNodeBoundsByAttributes(xml, isSystemCameraShutter);
    const systemShutterCenter = systemShutterBounds ? parseBoundsCenter(systemShutterBounds) : null;
    if (systemShutterCenter) {
      await runAdb(serial, ['shell', 'input', 'tap', String(systemShutterCenter.x), String(systemShutterCenter.y)]);
      return;
    }

    if (parseUiNodeBoundsByAttributes(xml, isInstafyShutter)) {
      sawDisabledInstafyShutter = true;
    }
    await sleep(400);
  }

  if (sawDisabledInstafyShutter) {
    throw new Error('Timed out waiting for the in-app camera shutter to become enabled.');
  }

  const { width, height } = await getDisplaySize(serial);
  await runAdb(serial, ['shell', 'input', 'tap', String(Math.round(width / 2)), String(Math.round(height * 0.835))]);
}

async function captureDeviceScreenshot(serial, outputPath) {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const { stdout } = await runAdb(serial, ['exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  await fs.promises.writeFile(outputPath, stdout);
}

async function waitForPhoneReady(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await expect.poll(async () => {
    const chatVisible = await page.getByTestId('chat-input').isVisible().catch(() => false);
    const sidebarVisible = await page.getByTestId('sidebar-nav-chat').isVisible().catch(() => false);
    const sidebarToggleVisible = await page.getByTestId('topbar-sidebar-toggle').isVisible().catch(() => false);
    const extensionsVisible = await page.getByTestId('extensions-panel').isVisible().catch(() => false);
    const emailVisible = await page.getByRole('textbox', { name: /email address/i }).isVisible().catch(() => false);
    const guestVisible = await page.getByRole('button', { name: /continue as guest/i }).isVisible().catch(() => false);
    return (
      chatVisible ||
      sidebarVisible ||
      sidebarToggleVisible ||
      extensionsVisible ||
      emailVisible ||
      guestVisible
    );
  }, { timeout: 30000 }).toBe(true);
}

async function openRuntimeAiMenu(page) {
  const triggers = [
    page.getByTestId('runtime-selector-button'),
    page.getByTestId('composer-agent-toggle'),
  ];
  const popover = page.getByTestId('runtime-selector-popover');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await popover.isVisible().catch(() => false)) {
      return true;
    }
    for (const trigger of triggers) {
      if (await trigger.isVisible().catch(() => false)) {
        await trigger.click().catch(async () => {
          await trigger.click({ force: true }).catch(() => {});
        });
        await expect(popover).toBeVisible({ timeout: 5_000 }).catch(() => {});
        if (await popover.isVisible().catch(() => false)) {
          return true;
        }
        await page.keyboard.press('Escape').catch(() => {});
      }
    }
    if (attempt < 2) {
      await page.waitForTimeout(750);
    }
  }
  return false;
}

async function closeRuntimeAiMenu(page) {
  const closeButton = page.getByRole('button', { name: /close agent menu/i }).first();
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click().catch(() => {});
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page
    .getByTestId('runtime-selector-popover')
    .waitFor({ state: 'hidden', timeout: 5_000 })
    .catch(() => {});
}

async function disableAssistantIfPossible(
  page,
  { projectId = null, conversationControllerId = null } = {},
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const debugBefore = await readActiveConversationDebug(page).catch(() => null);
    if (isAssistantDisabledDebug(debugBefore, conversationControllerId)) {
      return true;
    }

    const opened = await openRuntimeAiMenu(page);
    if (!opened) {
      return false;
    }

    const toggle = page.getByTestId('chat-assistant-toggle');
    if (await toggle.isVisible().catch(() => false)) {
      await expect(toggle).toBeVisible({ timeout: 15_000 });
      await toggle.click().catch(async () => {
        await toggle.click({ force: true }).catch(() => {});
      });
      const debugDeadline = Date.now() + 15_000;
      while (Date.now() < debugDeadline) {
        const debug = await readActiveConversationDebug(page).catch(() => null);
        if (isAssistantDisabledDebug(debug, conversationControllerId)) {
          await closeRuntimeAiMenu(page);
          return true;
        }
        await page.waitForTimeout(500).catch(() => {});
      }
    }

    await closeRuntimeAiMenu(page);
    if (projectId && conversationControllerId) {
      await openConversation(page, projectId, conversationControllerId).catch(() => {});
      await dismissOnboardingPrompt(page).catch(() => {});
    }
    if (attempt < 2) {
      await page.waitForTimeout(1_000);
    }
  }
  return false;
}

async function ensureAssistantDisabledForBootstrap(
  page,
  label,
  { projectId = null, conversationControllerId = null } = {},
) {
  const waitForSyncedDisabledState = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const debug = await readActiveConversationDebug(page).catch(() => null);
      if (isAssistantDisabledDebug(debug, conversationControllerId)) {
        return true;
      }
      await page.waitForTimeout(500).catch(() => {});
    }
    return false;
  };

  const synced = await waitForSyncedDisabledState(15_000);
  if (synced) {
    return;
  }

  if (projectId && conversationControllerId) {
    await openConversation(page, projectId, conversationControllerId).catch(() => {});
    await dismissOnboardingPrompt(page).catch(() => {});
    const syncedAfterReopen = await waitForSyncedDisabledState(10_000);
    if (syncedAfterReopen) {
      return;
    }
  }

  const disabled = await disableAssistantIfPossible(page, { projectId, conversationControllerId });
  const debug = await readActiveConversationDebug(page).catch(() => null);
  if (isAssistantDisabledDebug(debug, conversationControllerId)) {
    return;
  }
  throw new Error(
    `Expected assistant to be disabled for ${label} bootstrap messages. disabledViaUi=${disabled} activeConversationDebug=${JSON.stringify(
      debug,
    )}`,
  );
}

async function openPanel(page, panelId) {
  const target = panelId === 'chat' ? page.getByTestId('chat-input') : page.getByTestId('extensions-panel');
  if (await target.isVisible().catch(() => false)) return;
  const navButton = page.getByTestId(`sidebar-nav-${panelId}`);
  const moreItem = page.getByTestId(`sidebar-more-item-${panelId}`);
  const moreButton = page.getByTestId('sidebar-nav-more');
  const sidebarToggle = page.getByTestId('topbar-sidebar-toggle');
  const buttonFallback =
    panelId === 'extensions'
      ? page.getByRole('button', { name: /^extensions$/i }).last()
      : panelId === 'chat'
        ? page.getByRole('button', { name: /^(assistant|chat)$/i }).last()
        : null;
  const textFallback =
    panelId === 'extensions'
      ? page.getByText(/^Extensions$/)
      : panelId === 'chat'
        ? page.getByText(/^Assistant$/)
        : null;
  const clickAndWaitForTarget = async (locator, timeoutMs = 7_500) => {
    await locator.click().catch(async () => {
      await locator.click({ force: true }).catch(() => {});
    });
    const visible = await target
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(() => true)
      .catch(() => false);
    return visible;
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await waitForPhoneReady(page).catch(() => {});
    if (await target.isVisible().catch(() => false)) {
      return;
    }
    if (await navButton.isVisible().catch(() => false)) {
      if (await clickAndWaitForTarget(navButton)) return;
    }
    if (await moreItem.isVisible().catch(() => false)) {
      if (await clickAndWaitForTarget(moreItem)) return;
    }
    if (buttonFallback && await buttonFallback.isVisible().catch(() => false)) {
      if (await clickAndWaitForTarget(buttonFallback)) return;
    }
    if (textFallback && await textFallback.isVisible().catch(() => false)) {
      if (await clickAndWaitForTarget(textFallback)) return;
    }
    if (await moreButton.isVisible().catch(() => false)) {
      await moreButton.click().catch(async () => {
        await moreButton.click({ force: true }).catch(() => {});
      });
      await moreItem.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      if (await moreItem.isVisible().catch(() => false)) {
        if (await clickAndWaitForTarget(moreItem)) return;
      }
    }
    if (await sidebarToggle.isVisible().catch(() => false)) {
      await sidebarToggle.click({ force: true }).catch(() => {});
      await page.waitForTimeout(750);
      if (await navButton.isVisible().catch(() => false)) {
        if (await clickAndWaitForTarget(navButton)) return;
      }
      if (buttonFallback && await buttonFallback.isVisible().catch(() => false)) {
        if (await clickAndWaitForTarget(buttonFallback)) return;
      }
      if (textFallback && await textFallback.isVisible().catch(() => false)) {
        if (await clickAndWaitForTarget(textFallback)) return;
      }
      if (await moreButton.isVisible().catch(() => false)) {
        await moreButton.click().catch(async () => {
          await moreButton.click({ force: true }).catch(() => {});
        });
        await moreItem.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        if (await moreItem.isVisible().catch(() => false)) {
          if (await clickAndWaitForTarget(moreItem)) return;
        }
      }
    }
    await page.waitForTimeout(750);
  }
  throw new Error(`Unable to open ${panelId} on the Android app.`);
}

async function getNativeCameraStatus(page) {
  return page.evaluate(async () => {
    const plugin = window.Capacitor?.Plugins?.InstafyCameraExtension;
    if (!plugin?.getStatus) return null;
    return await plugin.getStatus();
  });
}

async function ensureCameraReady(page, serial) {
  await runAdb(serial, ['shell', 'pm', 'grant', appPackage, 'android.permission.CAMERA'], { allowFailure: true });
  await page.waitForTimeout(800);
  let status = await getNativeCameraStatus(page);
  if (status?.permissionGranted) return status;
  await page.evaluate(() => {
    const plugin = window.Capacitor?.Plugins?.InstafyCameraExtension;
    if (plugin?.requestCameraPermissions) void plugin.requestCameraPermissions();
  });
  await page.waitForTimeout(500);
  for (const text of ['While using the app', 'Allow only while using the app', 'Allow']) {
    const tapped = await tapUiNodeWithText(serial, text);
    if (tapped) break;
  }
  await page.waitForTimeout(1500);
  status = await getNativeCameraStatus(page);
  if (!status?.permissionGranted) throw new Error('Camera permission is still not granted on the Android device.');
  return status;
}

async function attachDesktopCameraProvider(page) {
  await openPanel(page, 'extensions');
  const providerRow = page.locator('[data-testid^="project-provider-row-camera"]').first();
  await providerRow.waitFor({ state: 'visible', timeout: 30_000 });
  await expect(providerRow).toContainText(/Ready|Attached|Camera/i, { timeout: 30_000 });

  const rowTestId = await providerRow.getAttribute('data-testid');
  const providerId = rowTestId?.replace(/^project-provider-row-/, '') ?? 'camera.native.desktop';
  const attachButton = providerRow.locator('[data-testid^="project-provider-attach-camera"]').first();
  if (await attachButton.isVisible().catch(() => false)) {
    await attachButton.click({ force: true });
  }
  await expect(providerRow.locator('[data-testid^="project-provider-attach-camera"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  await ensureProviderDetailsExpanded(page, providerId).catch(() => {});
  return { providerId, status: null };
}

async function ensureProviderDetailsExpanded(page, providerId) {
  const details = page.getByTestId(`project-provider-details-${providerId}`);
  if (await details.isVisible().catch(() => false)) return;
  const toggle = page.getByTestId(`project-provider-details-toggle-${providerId}`);
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
    await expect(details).toBeVisible({ timeout: 30000 });
  }
}

async function switchPreferredCameraDeviceInExtensions(page, rowProviderId, targetProviderId) {
  await openPanel(page, 'extensions');
  await page.getByTestId(`project-provider-row-${rowProviderId}`).waitFor({
    state: 'visible',
    timeout: 30_000,
  });
  await ensureProviderDetailsExpanded(page, rowProviderId);
  const button = page.getByTestId(
    `project-provider-camera-attached-devices-${rowProviderId}-make-default-${targetProviderId}`,
  );
  await button.waitFor({ state: 'visible', timeout: 30_000 });
  await button.click({ force: true });
}

async function upsertCameraProjectIntegrationFromDeviceSession(page) {
  const result = await page.evaluate(async ({ controllerBaseUrl }) => {
    const projectIdFromUrl = new URL(window.location.href).searchParams.get('projectId')?.trim() ?? '';
    const projectIdFromWindow = typeof window.__INSTAFY_ACTIVE_PROJECT_ID__ === 'string' ? window.__INSTAFY_ACTIVE_PROJECT_ID__.trim() : '';
    const projectId = projectIdFromUrl || projectIdFromWindow;
    if (!projectId) return { success: false, error: 'Missing active project id.' };
    const supabase = window.__INSTAFY_SUPABASE__;
    if (!supabase?.auth?.getSession) return { success: false, error: 'Instafy Supabase session unavailable on device.' };
    const sessionResult = await supabase.auth.getSession().catch(() => null);
    const accessToken = sessionResult?.data?.session?.access_token ?? '';
    if (!accessToken) return { success: false, error: 'Missing controller access token for device session.' };
    const cameraStatus = await window.Capacitor?.Plugins?.InstafyCameraExtension?.getStatus?.().catch(() => null);
    const providerId = typeof cameraStatus?.providerId === 'string' && cameraStatus.providerId.trim().length > 0 ? cameraStatus.providerId.trim() : 'camera';
    const deviceId = typeof cameraStatus?.deviceId === 'string' && cameraStatus.deviceId.trim().length > 0 ? cameraStatus.deviceId.trim() : providerId.replace(/^camera:/, '');
    const deviceLabel = typeof cameraStatus?.deviceLabel === 'string' && cameraStatus.deviceLabel.trim().length > 0 ? cameraStatus.deviceLabel.trim() : 'This device';
    const integrationUrl = `${controllerBaseUrl.replace(/\/+$/, '')}/projects/${encodeURIComponent(projectId)}/integrations/${encodeURIComponent(providerId)}`;
    const listUrl = `${controllerBaseUrl.replace(/\/+$/, '')}/projects/${encodeURIComponent(projectId)}/integrations`;
    const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    const existingResponse = await fetch(listUrl, { headers }).catch(() => null);
    const existingIntegrations = existingResponse?.ok ? await existingResponse.json().catch(() => []) : [];
    const existingIntegration = Array.isArray(existingIntegrations)
      ? existingIntegrations.find((entry) => entry && typeof entry === 'object' && (entry.provider === providerId || entry.provider === 'camera')) ?? null
      : null;
    const existingMetadata = existingIntegration?.metadata && typeof existingIntegration.metadata === 'object' ? existingIntegration.metadata : {};
    const existingCapabilities = Array.isArray(existingIntegration?.capabilities) ? existingIntegration.capabilities.filter((entry) => typeof entry === 'string') : [];
    const nowIso = new Date().toISOString();
    const response = await fetch(integrationUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        status: 'attached',
        connectionType: 'native_runtime',
        metadata: {
          ...existingMetadata,
          attached: true,
          enabled: true,
          attachedAt: typeof existingMetadata.attachedAt === 'string' && existingMetadata.attachedAt.trim().length > 0 ? existingMetadata.attachedAt : nowIso,
          attachedFrom: 'tri_client_local_camera_smoke',
          attachedVia: 'native_runtime',
          selectedDevice: {
            transport: 'native_camera',
            identifier: deviceId,
            address: deviceId,
            name: deviceLabel,
            nativePlatform: 'android',
            connectedAt: nowIso,
          },
          updatedAt: nowIso,
        },
        capabilities: Array.from(new Set([...existingCapabilities, 'camera_observation'])),
      }),
    }).catch((error) => ({ ok: false, status: 0, text: async () => String(error), json: async () => null }));
    if (!response.ok) {
      return { success: false, error: await response.text().catch(() => `Controller responded with status ${response.status}.`) };
    }
    const integration = await response.json().catch(() => null);
    return { success: true, integration, providerId };
  }, { controllerBaseUrl: controllerUrl });
  if (!result?.success) throw new Error(result?.error || 'Unable to attach Camera through the device controller session.');
  return result.providerId || 'camera';
}

async function ensureCameraAttached(page, providerId, timeoutMs = 30000) {
  const attachButton = page.getByTestId(`project-provider-attach-${providerId}`);
  const detachButton = page.getByTestId(`project-provider-detach-${providerId}`);
  const statusIndicator = page.getByTestId(`project-provider-status-${providerId}`);
  const deadline = Date.now() + timeoutMs;
  let attachAttempted = false;
  let apiFallbackUsed = false;
  while (Date.now() < deadline) {
    const attachVisible = await attachButton.isVisible().catch(() => false);
    const statusLabel = ((await statusIndicator.getAttribute('aria-label').catch(() => '')) || '').trim();
    const attachedVisible = statusLabel === 'Attached';
    if ((await detachButton.isVisible().catch(() => false)) || (attachedVisible && !attachVisible)) {
      return { attachedViaApiFallback: apiFallbackUsed };
    }
    if (attachVisible) {
      const disabled = await attachButton.isDisabled().catch(() => false);
      if (!disabled) {
        attachAttempted = true;
        const clicked = await attachButton.click({ force: true, timeout: 3000 }).then(() => true).catch(() => false);
        await page.waitForTimeout(1500);
        if (clicked) continue;
      }
    }
    if (!apiFallbackUsed && (attachAttempted || attachVisible)) {
      await upsertCameraProjectIntegrationFromDeviceSession(page);
      apiFallbackUsed = true;
      await page.waitForTimeout(1500);
      await openPanel(page, 'extensions');
      continue;
    }
    await page.waitForTimeout(500);
  }
  throw new Error('Timed out waiting for Camera to become attached in Extensions.');
}

async function connectAndroidWebView(serial, port) {
  await runAdb(serial, ['shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', '2'], { allowFailure: true });
  await runAdb(serial, ['shell', 'svc', 'power', 'stayon', 'usb'], { allowFailure: true });
  for (const reversePort of androidReversePorts) {
    await ensureAdbReverse(serial, reversePort);
  }
  await runAdb(serial, ['shell', 'pm', 'clear', appPackage], { allowFailure: true });
  await runAdb(serial, ['shell', 'am', 'force-stop', appPackage], { allowFailure: true });
  await sleep(1000);
  await launchInstafyApp(serial);
  const pid = await waitForAppPid(serial, appPackage);
  await runAdb(serial, ['forward', '--remove', `tcp:${port}`], { allowFailure: true });
  await runAdb(serial, ['forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`]);
  await waitForWebViewList(port, 30000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages().find((entry) => entry.url().includes('/studio') || entry.url().includes('/login')) || context.pages()[0];
  if (!page) throw new Error('Unable to find the Instafy page in the Android WebView.');
  await waitForPhoneReady(page);
  await ensureAndroidDeviceUnlocked(serial, 'android webview bootstrap');
  return { browser, context, page };
}

async function runMultiDeviceMain() {
  if (!adbPath) {
    throw new Error('Unable to resolve adb. Set ANDROID_HOME, ANDROID_SDK_ROOT, ANDROID_ADB, or ADB.');
  }

  const serial = await resolveDeviceSerial(preferredSerial);
  const desktopCdpPort = await resolveAvailablePort(preferredDesktopCdpPort);
  const androidWebviewPort = await resolveAvailablePort(preferredAndroidWebviewPort);
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  let browser = null;
  let browserContext = null;
  let browserPage = null;
  let frontendProcess = null;
  let desktopProcess = null;
  const desktopLogs = [];
  let desktopBrowser = null;
  let desktopContext = null;
  let desktopPage = null;
  let androidBrowser = null;
  let androidContext = null;
  let androidPage = null;
  let iosSession = null;
  let androidProviderId = null;
  let iosProviderId = null;
  let desktopUserDataDir = null;
  const cleanupHandlers = [];
  let cleanupStarted = false;

  const registerCleanup = (handler) => {
    cleanupHandlers.unshift(handler);
  };

  const runCleanup = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    for (const handler of cleanupHandlers) {
      try {
        await handler();
      } catch {}
    }
  };

  const handleSignal = (signal) => {
    console.error(`Received ${signal}, cleaning up tri-client smoke resources...`);
    void runCleanup().finally(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  registerCleanup(async () => {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
  });
  registerCleanup(async () => {
    await cleanupOwnedAutomationProcesses({
      ownedTmpDirs: [automationTempDir],
      minAgeSeconds: 0,
    });
    cleanupOwnedAutomationTempDirs({
      ownedTmpDirs: [automationTempDir],
      removeEmptyRoot: true,
    });
  });

  try {
    await cleanupStaleAutomationRuns(automationTempDir);
    await ensureLocalSmokeUser();
    frontendProcess = await ensureFrontendServer(baseUrl, registerCleanup);

    browser = await chromium.launch({ headless: true });
    registerCleanup(async () => {
      await browser?.close().catch(() => {});
    });
    browserContext = await browser.newContext();
    browserPage = await browserContext.newPage();

    desktopUserDataDir = createOwnedDesktopUserDataDir();
    registerCleanup(async () => {
      if (desktopUserDataDir) {
        await fs.promises.rm(desktopUserDataDir, { recursive: true, force: true }).catch(() => {});
      }
    });
    desktopProcess = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [
      '--filter',
      '@instafy/desktop-app',
      'start',
      '--',
      '--allow-multiple-instances',
      `--remote-debugging-port=${desktopCdpPort}`,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        INSTAFY_APP_URL: `${baseUrl}/studio`,
        INSTAFY_DESKTOP_ALLOW_MULTIPLE_INSTANCES: '1',
        INSTAFY_DESKTOP_USER_DATA_DIR: desktopUserDataDir,
        ...(desktopFakeMediaEnabled ? { INSTAFY_DESKTOP_FAKE_MEDIA: '1' } : {}),
        ELECTRON_ENABLE_LOGGING: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [desktopProcess.stdout, desktopProcess.stderr]) {
      stream?.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        desktopLogs.push(text);
        if (desktopLogs.length > 200) {
          desktopLogs.shift();
        }
      });
    }
    registerCleanup(async () => {
      await terminateDesktopProcess(desktopProcess).catch(() => {});
    });

    await waitForDesktopCdpOrExit(desktopCdpPort, desktopProcess, desktopLogs, 150_000);
    desktopBrowser = await connectDesktopBrowser(desktopCdpPort, 150_000);
    registerCleanup(async () => {
      await desktopBrowser?.close().catch(() => {});
    });
    desktopContext = desktopBrowser.contexts()[0];
    desktopPage =
      desktopContext.pages().find((entry) => entry.url().includes('/studio') || entry.url().includes('/login')) ||
      desktopContext.pages()[0];
    if (!desktopPage) {
      throw new Error('Unable to find the Electron Studio page.');
    }

    ({ browser: androidBrowser, context: androidContext, page: androidPage } =
      await connectAndroidWebView(serial, androidWebviewPort));
    registerCleanup(async () => {
      for (const reversePort of androidReversePorts) {
        await clearAdbReverse(serial, reversePort);
      }
    });
    registerCleanup(async () => {
      await runAdb(serial, ['forward', '--remove', `tcp:${androidWebviewPort}`], { allowFailure: true });
    });
    registerCleanup(async () => {
      await androidBrowser?.close().catch(() => {});
    });
    console.log(`Using Android device ${serial}`);

    iosSession =
      multiDeviceIosPlatform === 'ios-simulator'
        ? await createIosSimulatorTriClientPhoneSession({
            repoRoot,
            artifactsDir,
            controllerUrl,
            email,
            password,
          })
        : await createIosTriClientPhoneSession({
            repoRoot,
            artifactsDir,
            email,
            password,
          });
    registerCleanup(async () => {
      await iosSession?.cleanup().catch(() => {});
    });
    console.log(
      multiDeviceIosPlatform === 'ios-simulator'
        ? `Using iPhone Simulator ${iosSession.deviceName} (${iosSession.udid})`
        : `Using iPhone ${iosSession.deviceName} (${iosSession.udid})`,
    );

    console.log('Signing into browser, Electron, and Android WebView...');
    await Promise.all([
      ensureLoggedIn(browserPage, `${baseUrl}/studio`, { email, password }),
      ensureLoggedIn(desktopPage, `${baseUrl}/studio`, { email, password }),
      ensureLoggedIn(androidPage, null, { email, password }),
    ]);

    const accessToken = await readSupabaseAccessToken(browserPage);
    if (!accessToken) throw new Error('Missing Supabase access token after browser login.');

    const currentProjectId = await waitForActiveProjectId(browserPage);
    if (!currentProjectId) throw new Error('Unable to resolve the current project id after login.');
    const currentProject = await getProjectSummary(currentProjectId, accessToken);
    const orgId = typeof currentProject?.orgId === 'string' ? currentProject.orgId.trim() : '';
    if (!orgId) throw new Error(`Unable to resolve orgId for project ${currentProjectId}.`);

    const projectName = `Two-device camera smoke ${new Date().toISOString().slice(0, 19)}`;
    const projectPayload = await createProjectInOrg(orgId, projectName, accessToken);
    const projectId =
      typeof projectPayload?.projectId === 'string' && projectPayload.projectId.trim()
        ? projectPayload.projectId.trim()
        : null;
    if (!projectId) {
      throw new Error(`Project creation did not return projectId. body=${JSON.stringify(projectPayload)}`);
    }

    const conversationPayload = await createBlankConversation(projectId, accessToken);
    const conversationControllerId =
      typeof conversationPayload?.conversationId === 'string' &&
      conversationPayload.conversationId.trim()
        ? conversationPayload.conversationId.trim()
        : null;
    if (!conversationControllerId) {
      throw new Error(
        `Blank conversation creation did not return conversationId. body=${JSON.stringify(conversationPayload)}`,
      );
    }
    await disableAssistantForBootstrapConversation(conversationControllerId, accessToken);

    console.log(`Project ${projectId}`);
    console.log(`Conversation ${conversationControllerId}`);

    await Promise.all([
      openConversation(browserPage, projectId, conversationControllerId),
      openConversation(desktopPage, projectId, conversationControllerId),
    ]);
    await Promise.all([
      dismissOnboardingPrompt(browserPage),
      dismissOnboardingPrompt(desktopPage),
      dismissOnboardingPrompt(androidPage),
    ]);
    await Promise.all([
      ensureAssistantDisabledForBootstrap(browserPage, 'browser', {
        projectId,
        conversationControllerId,
      }),
      ensureAssistantDisabledForBootstrap(desktopPage, 'desktop', {
        projectId,
        conversationControllerId,
      }),
    ]);

    const browserMessage = `browser hello ${runId}`;
    await sendChatMessage(browserPage, browserMessage, { conversationControllerId });
    await waitForConversationMessage(conversationControllerId, accessToken, {
      role: 'user',
      content: browserMessage,
    });

    const desktopMessage = `desktop hello ${runId}`;
    await sendChatMessage(desktopPage, desktopMessage, { conversationControllerId });
    await waitForConversationMessage(conversationControllerId, accessToken, {
      role: 'user',
      content: desktopMessage,
    });

    console.log('Attaching Android Camera first...');
    await ensureAndroidDeviceUnlocked(serial, 'project handoff');
    androidPage = await openAndroidProjectPanel(serial, androidPage, androidContext, projectId, 'extensions');
    await dismissOnboardingPrompt(androidPage);
    await ensureLoggedIn(androidPage, null, { email, password });
    console.log(`Android active project ${await readActiveProjectId(androidPage)}`);
    androidPage = await openAndroidProjectPanel(serial, androidPage, androidContext, projectId, 'extensions');
    const androidStatus = await ensureCameraReady(androidPage, serial);
    const discoveredAndroidProviderId =
      typeof androidStatus?.providerId === 'string' && androidStatus.providerId.trim()
        ? androidStatus.providerId.trim()
        : 'camera';
    androidProviderId = await upsertCameraProjectIntegrationFromDeviceSession(androidPage).catch(
      () => discoveredAndroidProviderId,
    );
    androidPage = await openAndroidProjectPanel(serial, androidPage, androidContext, projectId, 'extensions');
    await expect(androidPage.getByTestId(`project-provider-row-${androidProviderId}`)).toBeVisible({
      timeout: 30_000,
    });
    await ensureCameraAttached(androidPage, androidProviderId).catch(() => {});
    await ensureProviderDetailsExpanded(androidPage, androidProviderId);

    console.log('Attaching iPhone Camera second...');
    await iosSession.prepareForProject({ projectId, projectName, runId });

    const attachedCameraIntegrations = await waitForAttachedCameraIntegrations(projectId, accessToken, {
      expectedCount: 2,
      timeoutMs: 120_000,
    });
    const normalizedAndroidProviderId = androidProviderId.trim().toLowerCase();
    const iosIntegration =
      attachedCameraIntegrations.iosIntegration ??
      attachedCameraIntegrations.all.find(
        (entry) => entry.provider.trim().toLowerCase() !== normalizedAndroidProviderId,
      ) ??
      null;
    if (!iosIntegration) {
      throw new Error(
        `Unable to identify the attached iPhone Camera integration. Attached camera providers: ${attachedCameraIntegrations.all
          .map((entry) => entry.provider)
          .join(', ')}`,
      );
    }
    iosProviderId = iosIntegration.provider.trim().toLowerCase();
    await waitForPreferredCameraProvider(projectId, accessToken, normalizedAndroidProviderId, 45_000);
    console.log(`Android provider ${androidProviderId}`);
    console.log(`iPhone provider ${iosProviderId}`);

    console.log('Sending first camera request to the default Android device...');
    await ensureAndroidDeviceUnlocked(serial, 'camera request dispatch');
    await launchInstafyApp(serial, 8_000);
    await waitForPhoneReady(androidPage);
    const messagesBeforeFirstCapture = await fetchConversationMessages(conversationControllerId, accessToken);
    const assistantCaptureCountBeforeFirst = countConversationMessages(messagesBeforeFirstCapture, {
      role: 'assistant',
      contentPattern: expectedCameraResponsePattern,
    });
    const userCaptureCountBeforeFirst = countConversationMessages(messagesBeforeFirstCapture, {
      role: 'user',
      content: cameraPrompt,
    });
    const firstRequestStartedAt = Date.now() - 1_000;
    await sendChatMessage(desktopPage, cameraPrompt, { conversationControllerId });
    await waitForConversationMessageCount(conversationControllerId, accessToken, {
      role: 'user',
      content: cameraPrompt,
      minimumCount: userCaptureCountBeforeFirst + 1,
      timeoutMs: 45_000,
    });
    await waitForProviderRequestAfter(projectId, normalizedAndroidProviderId, accessToken, {
      afterMs: firstRequestStartedAt,
      timeoutMs: 45_000,
    });
    await waitForCameraForeground(serial, 30_000);
    await maybeDismissLocationPrompt(serial);
    await sleep(800);
    await triggerCameraShutter(serial);
    await sleep(2_500);
    await maybeConfirmCapturedPhoto(serial);
    await waitForResumedActivityMatch(
      serial,
      (activity) =>
        activity.packageName === appPackage &&
        activity.activity.includes('MainActivity'),
      45_000,
      'Instafy main activity',
    );
    androidPage = await recoverPhoneStudioPage(androidPage, androidContext, projectId, 45_000);
    await dismissOnboardingPrompt(androidPage);
    await waitForPhoneReady(androidPage).catch(() => {});
    await waitForConversationMessageCount(conversationControllerId, accessToken, {
      role: 'assistant',
      contentPattern: expectedCameraResponsePattern,
      minimumCount: assistantCaptureCountBeforeFirst + 1,
      timeoutMs: 120_000,
    });
    console.log('First camera response landed in the shared conversation.');

    console.log('Switching the preferred Camera device to iPhone from Extensions...');
    await switchPreferredCameraDeviceInExtensions(browserPage, normalizedAndroidProviderId, iosProviderId);
    await waitForPreferredCameraProvider(projectId, accessToken, iosProviderId, 45_000);

    console.log('Sending second camera request to the preferred iPhone device...');
    const messagesBeforeSecondCapture = await fetchConversationMessages(conversationControllerId, accessToken);
    const assistantCaptureCountBeforeSecond = countConversationMessages(messagesBeforeSecondCapture, {
      role: 'assistant',
      contentPattern: expectedCameraResponsePattern,
    });
    const userCaptureCountBeforeSecond = countConversationMessages(messagesBeforeSecondCapture, {
      role: 'user',
      content: secondCameraPrompt,
    });
    const secondRequestStartedAt = Date.now() - 1_000;
    await sendChatMessage(desktopPage, secondCameraPrompt, { conversationControllerId });
    await waitForConversationMessageCount(conversationControllerId, accessToken, {
      role: 'user',
      content: secondCameraPrompt,
      minimumCount: userCaptureCountBeforeSecond + 1,
      timeoutMs: 45_000,
    });
    await waitForProviderRequestAfter(projectId, iosProviderId, accessToken, {
      afterMs: secondRequestStartedAt,
      timeoutMs: 45_000,
    });
    await iosSession.waitForCapture();
    await waitForConversationMessageCount(conversationControllerId, accessToken, {
      role: 'assistant',
      contentPattern: expectedCameraResponsePattern,
      minimumCount: assistantCaptureCountBeforeSecond + 1,
      timeoutMs: 120_000,
    });
    console.log('Second camera response landed in the shared conversation.');

    await waitForAssistantText(desktopPage, expectedCameraResponsePattern, 30_000);
    await waitForAssistantText(browserPage, expectedCameraResponsePattern, 30_000);

    const browserShot = path.join(artifactsDir, `browser-two-device-${runId}.png`);
    const desktopShot = path.join(artifactsDir, `desktop-two-device-${runId}.png`);
    const androidWebviewShot = path.join(artifactsDir, `android-webview-two-device-${runId}.png`);
    const androidDeviceShot = path.join(artifactsDir, `android-device-two-device-${runId}.png`);
    await browserPage.screenshot({ path: browserShot, fullPage: true });
    await desktopPage.screenshot({ path: desktopShot, fullPage: true });
    await androidPage.screenshot({ path: androidWebviewShot, fullPage: true }).catch(() => {});
    await captureDeviceScreenshot(serial, androidDeviceShot).catch(() => {});

    console.log(`Browser screenshot: ${browserShot}`);
    console.log(`Desktop screenshot: ${desktopShot}`);
    console.log(`Android webview screenshot: ${androidWebviewShot}`);
    console.log(`Android device screenshot: ${androidDeviceShot}`);
    const iosArtifacts = iosSession.getArtifacts();
    if (iosArtifacts.attachmentsPath) {
      console.log(`iPhone attachments: ${iosArtifacts.attachmentsPath}`);
    }
    if (iosArtifacts.resultBundlePath) {
      console.log(`iPhone result bundle: ${iosArtifacts.resultBundlePath}`);
    }
    console.log('Two-device tri-client local camera smoke: passed');
  } finally {
    await runCleanup();
  }
}

async function main() {
  if (!email || !password) {
    throw new Error('Missing local smoke credentials. Set TRI_CLIENT_EMAIL/TRI_CLIENT_PASSWORD or TEST_USER_1_EMAIL/TEST_USER_1_PASSWORD in .env.user.');
  }

  if (multiDeviceMode) {
    await runMultiDeviceMain();
    return;
  }

  fs.mkdirSync(artifactsDir, { recursive: true });
  const phonePlatform = await resolvePhonePlatform();
  if (phonePlatform === 'android' && !adbPath) {
    throw new Error('Unable to resolve adb. Set ANDROID_HOME, ANDROID_SDK_ROOT, ANDROID_ADB, or ADB.');
  }
  const serial = phonePlatform === 'android' ? await resolveDeviceSerial(preferredSerial) : null;
  const desktopCdpPort = await resolveAvailablePort(preferredDesktopCdpPort);
  const androidWebviewPort =
    phonePlatform === 'android' ? await resolveAvailablePort(preferredAndroidWebviewPort) : null;
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  let browser = null;
  let browserContext = null;
  let browserPage = null;
  let automationProcessTempDir = null;
  let frontendProcess = null;
  let desktopProcess = null;
  const desktopLogs = [];
  let desktopBrowser = null;
  let desktopContext = null;
  let desktopPage = null;
  let phoneBrowser = null;
  let phoneContext = null;
  let phonePage = null;
  let phoneSession = null;
  let phoneProviderId = null;
  let desktopUserDataDir = null;
  const cleanupHandlers = [];
  let cleanupStarted = false;

  const registerCleanup = (handler) => {
    cleanupHandlers.unshift(handler);
  };

  const runCleanup = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    for (const handler of cleanupHandlers) {
      try {
        await handler();
      } catch {}
    }
  };

  const handleSignal = (signal) => {
    console.error(`Received ${signal}, cleaning up tri-client smoke resources...`);
    void runCleanup().finally(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  registerCleanup(async () => {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
  });
  registerCleanup(async () => {
    await cleanupOwnedAutomationProcesses({
      ownedTmpDirs: [automationTempDir, automationProcessTempDir].filter(Boolean),
      minAgeSeconds: 0,
    });
    cleanupOwnedAutomationTempDirs({
      ownedTmpDirs: [automationTempDir, automationProcessTempDir].filter(Boolean),
      removeEmptyRoot: true,
    });
  });

  try {
    await cleanupStaleAutomationRuns(automationTempDir);
    automationProcessTempDir = createAutomationProcessTempDir('tri-client-local-camera-smoke');
    await ensureLocalSmokeUser();
    frontendProcess = await ensureFrontendServer(baseUrl, registerCleanup);
    browser = await chromium.launch({ headless: true });
    registerCleanup(async () => {
      await browser?.close().catch(() => {});
    });
    browserContext = await browser.newContext();
    browserPage = await browserContext.newPage();

    desktopUserDataDir = createOwnedDesktopUserDataDir();
    registerCleanup(async () => {
      if (desktopUserDataDir) {
        await fs.promises.rm(desktopUserDataDir, { recursive: true, force: true }).catch(() => {});
      }
    });
    desktopProcess = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [
      '--filter',
      '@instafy/desktop-app',
      'start',
      '--',
      '--allow-multiple-instances',
      `--remote-debugging-port=${desktopCdpPort}`,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        INSTAFY_APP_URL: `${baseUrl}/studio`,
        INSTAFY_DESKTOP_ALLOW_MULTIPLE_INSTANCES: '1',
        INSTAFY_DESKTOP_USER_DATA_DIR: desktopUserDataDir,
        ...(desktopFakeMediaEnabled ? { INSTAFY_DESKTOP_FAKE_MEDIA: '1' } : {}),
        ELECTRON_ENABLE_LOGGING: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [desktopProcess.stdout, desktopProcess.stderr]) {
      stream?.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        desktopLogs.push(text);
        if (desktopLogs.length > 200) {
          desktopLogs.shift();
        }
      });
    }
    registerCleanup(async () => {
      await terminateDesktopProcess(desktopProcess).catch(() => {});
    });

    await waitForDesktopCdpOrExit(desktopCdpPort, desktopProcess, desktopLogs, 150_000);
    desktopBrowser = await connectDesktopBrowser(desktopCdpPort, 150_000);
    registerCleanup(async () => {
      await desktopBrowser?.close().catch(() => {});
    });
    desktopContext = desktopBrowser.contexts()[0];
    desktopPage = desktopContext.pages().find((entry) => entry.url().includes('/studio') || entry.url().includes('/login')) || desktopContext.pages()[0];
    if (!desktopPage) throw new Error('Unable to find the Electron Studio page.');

    if (phonePlatform === 'android') {
      ({ browser: phoneBrowser, context: phoneContext, page: phonePage } = await connectAndroidWebView(serial, androidWebviewPort));
      registerCleanup(async () => {
        for (const reversePort of androidReversePorts) {
          await clearAdbReverse(serial, reversePort);
        }
      });
      registerCleanup(async () => {
        await runAdb(serial, ['forward', '--remove', `tcp:${androidWebviewPort}`], { allowFailure: true });
      });
      registerCleanup(async () => {
        await phoneBrowser?.close().catch(() => {});
      });
      console.log(`Using Android device ${serial}`);
    } else {
      const iosSessionOptions = reverseDesktopProviderFlow
        ? {
            testSelector: reverseIosTestSelector,
            extraEnv: {
              INSTAFY_UI_TEST_CAMERA_PROMPT: cameraPrompt,
              INSTAFY_UI_TEST_EXPECTED_CAMERA_RESULT_TEXT: 'captured a rear photo',
              ...(desktopFakeMediaEnabled
                ? { INSTAFY_UI_TEST_EXPECTED_CAMERA_DEVICE_TEXT: 'Fake Video Device' }
                : {}),
            },
          }
        : {};
      phoneSession =
        phonePlatform === 'ios-simulator'
          ? await createIosSimulatorTriClientPhoneSession({
              repoRoot,
              artifactsDir,
              controllerUrl,
              email,
              password,
              ...iosSessionOptions,
            })
          : await createIosTriClientPhoneSession({
              repoRoot,
              artifactsDir,
              email,
              password,
              ...iosSessionOptions,
            });
      registerCleanup(async () => {
        await phoneSession?.cleanup().catch(() => {});
      });
      console.log(
        phonePlatform === 'ios-simulator'
          ? `Using iPhone Simulator ${phoneSession.deviceName} (${phoneSession.udid})`
          : `Using iPhone ${phoneSession.deviceName} (${phoneSession.udid})`,
      );
    }

    console.log('Signing into browser and Electron...');
    await Promise.all([
      ensureLoggedIn(browserPage, `${baseUrl}/studio`, { email, password }),
      ensureLoggedIn(desktopPage, `${baseUrl}/studio`, { email, password }),
    ]);

    if (phonePlatform === 'android') {
      console.log('Signing into Android WebView...');
      await ensureLoggedIn(phonePage, null, { email, password });
    }

    const accessToken = await readSupabaseAccessToken(browserPage);
    if (!accessToken) throw new Error('Missing Supabase access token after browser login.');

    const currentProjectId = await waitForActiveProjectId(browserPage);
    if (!currentProjectId) throw new Error('Unable to resolve the current project id after login.');
    const currentProject = await getProjectSummary(currentProjectId, accessToken);
    const orgId = typeof currentProject?.orgId === 'string' ? currentProject.orgId.trim() : '';
    if (!orgId) throw new Error(`Unable to resolve orgId for project ${currentProjectId}.`);

    const projectName = `Tri-client camera smoke ${new Date().toISOString().slice(0, 19)}`;
    const projectPayload = await createProjectInOrg(orgId, projectName, accessToken);
    const projectId = typeof projectPayload?.projectId === 'string' && projectPayload.projectId.trim() ? projectPayload.projectId.trim() : null;
    if (!projectId) throw new Error(`Project creation did not return projectId. body=${JSON.stringify(projectPayload)}`);

    const conversationPayload = await createBlankConversation(projectId, accessToken);
    const conversationControllerId = typeof conversationPayload?.conversationId === 'string' && conversationPayload.conversationId.trim() ? conversationPayload.conversationId.trim() : null;
    if (!conversationControllerId) throw new Error(`Blank conversation creation did not return conversationId. body=${JSON.stringify(conversationPayload)}`);
    await disableAssistantForBootstrapConversation(conversationControllerId, accessToken);

    console.log(`Project ${projectId}`);
    console.log(`Conversation ${conversationControllerId}`);

    await Promise.all([
      openConversation(browserPage, projectId, conversationControllerId),
      openConversation(desktopPage, projectId, conversationControllerId),
    ]);
    await Promise.all([
      dismissOnboardingPrompt(browserPage),
      dismissOnboardingPrompt(desktopPage),
      ...(phonePlatform === 'android' ? [dismissOnboardingPrompt(phonePage)] : []),
    ]);
    await Promise.all([
      ensureAssistantDisabledForBootstrap(browserPage, 'browser', {
        projectId,
        conversationControllerId,
      }),
      ensureAssistantDisabledForBootstrap(desktopPage, 'desktop', {
        projectId,
        conversationControllerId,
      }),
    ]);

    const browserMessage = `browser hello ${runId}`;
    await sendChatMessage(browserPage, browserMessage, { conversationControllerId });
    await waitForConversationMessage(conversationControllerId, accessToken, {
      role: 'user',
      content: browserMessage,
    });

    const desktopMessage = `desktop hello ${runId}`;
    await sendChatMessage(desktopPage, desktopMessage, { conversationControllerId });
    await waitForConversationMessage(conversationControllerId, accessToken, {
      role: 'user',
      content: desktopMessage,
    });

    if (reverseDesktopProviderFlow) {
      if (phonePlatform === 'android') {
        throw new Error('TRI_CLIENT_CAMERA_FLOW=desktop-provider is currently wired for iOS/iOS simulator phone consumers.');
      }

      console.log('Attaching Electron Desktop Camera provider...');
      const desktopCamera = await attachDesktopCameraProvider(desktopPage);
      console.log(`Desktop Camera provider ${desktopCamera.providerId}`);

      console.log(
        phonePlatform === 'ios-simulator'
          ? 'Opening iPhone Simulator on the same project to consume Desktop Camera...'
          : 'Opening iPhone on the same project to consume Desktop Camera...',
      );
      await phoneSession.prepareForProject({ projectId, projectName, runId });

      await waitForConversationMessage(conversationControllerId, accessToken, {
        role: 'user',
        content: cameraPrompt,
        timeoutMs: 120000,
      });
      await phoneSession.waitForCapture();
      await waitForConversationMessage(conversationControllerId, accessToken, {
        role: 'assistant',
        contentPattern: expectedCameraResponsePattern,
        timeoutMs: 120000,
      });

      await waitForAssistantText(desktopPage, expectedCameraResponsePattern, 30000).catch(() => {});
      await waitForAssistantText(browserPage, expectedCameraResponsePattern, 30000).catch(() => {});

      const browserShot = path.join(artifactsDir, `browser-reverse-${runId}.png`);
      const desktopShot = path.join(artifactsDir, `desktop-reverse-${runId}.png`);
      await browserPage.screenshot({ path: browserShot, fullPage: true });
      await desktopPage.screenshot({ path: desktopShot, fullPage: true });

      console.log(`Browser screenshot: ${browserShot}`);
      console.log(`Desktop screenshot: ${desktopShot}`);
      const iosArtifacts = phoneSession.getArtifacts();
      if (iosArtifacts.attachmentsPath) {
        console.log(
          phonePlatform === 'ios-simulator'
            ? `iPhone simulator attachments: ${iosArtifacts.attachmentsPath}`
            : `iPhone attachments: ${iosArtifacts.attachmentsPath}`,
        );
      }
      if (iosArtifacts.resultBundlePath) {
        console.log(
          phonePlatform === 'ios-simulator'
            ? `iPhone simulator result bundle: ${iosArtifacts.resultBundlePath}`
            : `iPhone result bundle: ${iosArtifacts.resultBundlePath}`,
        );
      }
      console.log('Tri-client reverse Desktop Camera smoke: passed');
      return;
    }

    if (phonePlatform === 'android') {
      console.log('Opening Android on the same project and attaching Camera...');
      await ensureAndroidDeviceUnlocked(serial, 'project handoff');
      phonePage = await openAndroidProjectPanel(serial, phonePage, phoneContext, projectId, 'extensions', 45_000);
      await dismissOnboardingPrompt(phonePage);
      await ensureLoggedIn(phonePage, null, { email, password });
      console.log(`Phone active project ${await readActiveProjectId(phonePage)}`);
      phonePage = await openAndroidProjectPanel(serial, phonePage, phoneContext, projectId, 'extensions', 45_000);
      const status = await ensureCameraReady(phonePage, serial);
      const discoveredProviderId =
        typeof status?.providerId === 'string' && status.providerId.trim() ? status.providerId.trim() : 'camera';
      phoneProviderId = await upsertCameraProjectIntegrationFromDeviceSession(phonePage).catch(
        () => discoveredProviderId,
      );
      phonePage = await openAndroidProjectPanel(serial, phonePage, phoneContext, projectId, 'extensions', 45_000);
      await expect(phonePage.getByTestId(`project-provider-row-${phoneProviderId}`)).toBeVisible({ timeout: 30000 });
      await ensureCameraAttached(phonePage, phoneProviderId).catch(() => {});
      await ensureProviderDetailsExpanded(phonePage, phoneProviderId);
    } else {
      console.log(
        phonePlatform === 'ios-simulator'
          ? 'Opening iPhone Simulator on the same project and waiting for Camera readiness...'
          : 'Opening iPhone on the same project and waiting for Camera readiness...',
      );
      await phoneSession.prepareForProject({ projectId, projectName, runId });
    }

    console.log('Sending camera request from Electron...');
    if (phonePlatform === 'android') {
      await ensureAndroidDeviceUnlocked(serial, 'camera request dispatch');
      await launchInstafyApp(serial, 8_000);
      await waitForPhoneReady(phonePage);
    }
    await sendChatMessage(desktopPage, cameraPrompt, { conversationControllerId });
    await waitForConversationMessage(conversationControllerId, accessToken, {
      role: 'user',
      content: cameraPrompt,
    });

    if (phonePlatform === 'android') {
      let captureCompletedWithoutForeground = false;
      try {
        await waitForCameraForeground(serial, 30000);
      } catch (error) {
        if (phoneProviderId && accessToken) {
          const latestRequest = await getLatestProviderRequest(projectId, phoneProviderId, accessToken).catch(
            () => null,
          );
          if (latestRequest?.status === 'completed') {
            captureCompletedWithoutForeground = true;
          } else if (latestRequest) {
            throw new Error(
              `Timed out waiting for the in-app camera surface to appear. Latest provider request ${latestRequest.id} is ${latestRequest.status}${latestRequest.error ? `: ${latestRequest.error}` : ''}`,
            );
          }
        }
        if (!captureCompletedWithoutForeground) {
          throw error;
        }
      }
      if (!captureCompletedWithoutForeground) {
        await maybeDismissLocationPrompt(serial);
        await sleep(800);
        await triggerCameraShutter(serial);
        await sleep(2500);
        await maybeConfirmCapturedPhoto(serial);
        await waitForResumedActivityMatch(
          serial,
          (activity) =>
            activity.packageName === appPackage &&
            activity.activity.includes('MainActivity'),
          45000,
          'Instafy main activity',
        );
      }
      phonePage = await recoverPhoneStudioPage(phonePage, phoneContext, projectId, 45000);
      await dismissOnboardingPrompt(phonePage);
      await waitForPhoneReady(phonePage).catch(() => {});
    } else {
      await phoneSession.waitForCapture();
    }

    await waitForConversationMessage(conversationControllerId, accessToken, {
      role: 'assistant',
      contentPattern: expectedCameraResponsePattern,
      timeoutMs: 120000,
    });

    await waitForAssistantText(desktopPage, expectedCameraResponsePattern, 30000).catch(() => {});
    await waitForAssistantText(browserPage, expectedCameraResponsePattern, 30000).catch(() => {});

    const browserShot = path.join(artifactsDir, `browser-${runId}.png`);
    const desktopShot = path.join(artifactsDir, `desktop-${runId}.png`);
    await browserPage.screenshot({ path: browserShot, fullPage: true });
    await desktopPage.screenshot({ path: desktopShot, fullPage: true });

    console.log(`Browser screenshot: ${browserShot}`);
    console.log(`Desktop screenshot: ${desktopShot}`);
    if (phonePlatform === 'android') {
      const phoneShot = path.join(artifactsDir, `phone-webview-${runId}.png`);
      const deviceShot = path.join(artifactsDir, `phone-device-${runId}.png`);
      await phonePage.screenshot({ path: phoneShot, fullPage: true }).catch(() => {});
      await captureDeviceScreenshot(serial, deviceShot).catch(() => {});
      console.log(`Phone webview screenshot: ${phoneShot}`);
      console.log(`Phone device screenshot: ${deviceShot}`);
    } else {
      const iosArtifacts = phoneSession.getArtifacts();
      if (iosArtifacts.attachmentsPath) {
        console.log(
          phonePlatform === 'ios-simulator'
            ? `iPhone simulator attachments: ${iosArtifacts.attachmentsPath}`
            : `iPhone attachments: ${iosArtifacts.attachmentsPath}`,
        );
      }
      if (iosArtifacts.resultBundlePath) {
        console.log(
          phonePlatform === 'ios-simulator'
            ? `iPhone simulator result bundle: ${iosArtifacts.resultBundlePath}`
            : `iPhone result bundle: ${iosArtifacts.resultBundlePath}`,
        );
      }
    }
    console.log('Tri-client local camera smoke: passed');
  } finally {
    await runCleanup();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
