import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_APP_PATH = "/Applications/МТС Линк.app";
export const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";

export function sanitizeUrl(value) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function validateDeepLink(value) {
  const url = new URL(value);
  if (!["https:", "http:", "mtslinkchats:"].includes(url.protocol)) {
    throw new Error("URL must use https, http, or mtslinkchats");
  }
  if (url.username || url.password) {
    throw new Error("URL credentials are not allowed");
  }
  if (value.length > 8192) {
    throw new Error("URL is too long");
  }
  return value;
}

export function validateLoopbackEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("CDP endpoint must be an HTTP loopback URL");
  }
  return url.toString().replace(/\/$/, "");
}

export async function getAppInfo(appPath = DEFAULT_APP_PATH) {
  const { stdout } = await execFileAsync(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", `${appPath}/Contents/Info.plist`],
    { maxBuffer: 1024 * 1024 },
  );
  const plist = JSON.parse(stdout);
  return {
    name: plist.CFBundleDisplayName ?? plist.CFBundleName,
    bundleId: plist.CFBundleIdentifier,
    version: plist.CFBundleShortVersionString,
    build: plist.CFBundleVersion,
    appPath,
    defaultWorkspace: "my.mts-link.ru",
    deepLinkScheme: "mtslinkchats",
  };
}

export async function openApp({ appPath = DEFAULT_APP_PATH, url } = {}) {
  const args = ["-a", appPath];
  if (url) args.push(validateDeepLink(url));
  await execFileAsync("/usr/bin/open", args);
  return { opened: true, target: url ? sanitizeUrl(url) : null};
}
