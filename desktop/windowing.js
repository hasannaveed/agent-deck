export function preferredLinuxOzonePlatform({
  platform = process.platform,
  env = process.env,
  alreadySelected = false,
} = {}) {
  if (platform !== "linux" || alreadySelected) return null;
  return env.SWITCHBOARD_NATIVE_WAYLAND === "1" ? null : "x11";
}

export function desktopLaunchArguments({
  appPath,
  argv = [],
  platform = process.platform,
  env = process.env,
} = {}) {
  const hasOzonePlatform = argv.some((value) =>
    String(value).startsWith("--ozone-platform"),
  );
  const defaults = [];
  const ozonePlatform = preferredLinuxOzonePlatform({
    platform,
    env,
    alreadySelected: hasOzonePlatform,
  });
  if (ozonePlatform) defaults.push(`--ozone-platform=${ozonePlatform}`);
  if (platform === "linux" && !argv.some((value) => String(value).startsWith("--class"))) {
    defaults.push("--class=agent-switchboard");
  }
  return [...defaults, ...argv, appPath];
}
