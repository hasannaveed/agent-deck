import assert from "node:assert/strict";
import test from "node:test";
import { desktopLaunchArguments, preferredLinuxOzonePlatform } from "../desktop/windowing.js";

test("the Linux desktop pane uses XWayland for reliable z-order control", () => {
  assert.equal(preferredLinuxOzonePlatform({ platform: "linux", env: {} }), "x11");
  assert.equal(
    preferredLinuxOzonePlatform({
      platform: "linux",
      env: { SWITCHBOARD_NATIVE_WAYLAND: "1" },
    }),
    null,
  );
  assert.equal(preferredLinuxOzonePlatform({ platform: "linux", env: {}, alreadySelected: true }), null);
  assert.equal(preferredLinuxOzonePlatform({ platform: "darwin", env: {} }), null);
});

test("the desktop launcher selects Ozone before Electron starts", () => {
  assert.deepEqual(
    desktopLaunchArguments({ appPath: "/work/app", argv: ["--remote-debugging-port=9228"], platform: "linux", env: {} }),
    ["--ozone-platform=x11", "--class=agent-switchboard", "--remote-debugging-port=9228", "/work/app"],
  );
  assert.deepEqual(
    desktopLaunchArguments({
      appPath: "/work/app",
      argv: ["--ozone-platform=wayland", "--class=custom"],
      platform: "linux",
      env: {},
    }),
    ["--ozone-platform=wayland", "--class=custom", "/work/app"],
  );
});
