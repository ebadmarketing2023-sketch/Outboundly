import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";
import { checkLicenseStatus, activateLicense } from "../dist/application/licensing/ensure-licensed.js";
import { KeygenLicenseService } from "../dist/adapters/licensing/keygen-license-service.js";
import { SystemClock } from "../dist/ports/clock.port.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// A brief internet outage shouldn't lock out an otherwise-valid license -- see
// core/licensing/license-status.ts's own doc comment for why this only ever applies when the
// license server can't be reached at all, never when it's reachable and says "not valid."
const OFFLINE_GRACE_PERIOD_DAYS = 3;

/**
 * Disclosed license-key gate (only ever invoked when app.isPackaged -- see main.js): resolves
 * true once this installation is licensed to run, or calls app.quit() and resolves false if the
 * user declines. Running from source (npm run electron:dev, or the test suite) never calls this
 * at all, so local development is completely unaffected by any of this.
 */
export async function ensureLicensedOrQuit(db, accountId) {
  const licenseService = new KeygenLicenseService(accountId);
  const deps = {
    db,
    licenseService,
    clock: new SystemClock(),
    offlineGracePeriodDays: OFFLINE_GRACE_PERIOD_DAYS,
    machineName: os.hostname()
  };

  const initialStatus = await checkLicenseStatus(deps);
  if (initialStatus.outcome === "valid" || initialStatus.outcome === "grace") {
    if (initialStatus.outcome === "grace") {
      console.warn(`[license] ${initialStatus.reason}`);
    }
    return true;
  }

  return showGateWindow(deps, initialStatus);
}

function showGateWindow(deps, initialStatus) {
  return new Promise((resolve) => {
    const gateWindow = new BrowserWindow({
      width: 420,
      height: 460,
      resizable: false,
      webPreferences: {
        preload: join(__dirname, "license-window", "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    void gateWindow.loadFile(join(__dirname, "license-window", "index.html"));

    let settled = false;
    const settle = (licensed) => {
      if (settled) return;
      settled = true;
      ipcMain.removeHandler("license:getInitialStatus");
      ipcMain.removeHandler("license:activate");
      ipcMain.removeHandler("license:quit");
      resolve(licensed);
    };

    ipcMain.handle("license:getInitialStatus", () => initialStatus);

    ipcMain.handle("license:activate", async (_event, licenseKey) => {
      const result = await activateLicense(deps, licenseKey);
      if (result.ok) {
        settle(true);
        if (!gateWindow.isDestroyed()) gateWindow.close();
      }
      return result;
    });

    ipcMain.handle("license:quit", () => {
      settle(false);
      app.quit();
    });

    // Closing the window without a successful activation (the X button, not just the Quit
    // button) must also count as declining -- otherwise the app would be left running with no
    // window and no license, especially on macOS where closing the last window doesn't quit by
    // default.
    gateWindow.on("closed", () => {
      if (!settled) {
        settle(false);
        app.quit();
      }
    });
  });
}
