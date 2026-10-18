import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  deriveAutoDevProfileName,
  resolveAppIdentifier,
  resolveUserDataPath,
} from "./dev-profile.mjs";

const PROD_APP_IDENTIFIER = "ai.marsai.desktop";
const DEV_APP_IDENTIFIER = "ai.marsai.desktop.dev";
const APP_DATA_PATH = path.join("tmp", "appData");

function resolveProfile({
  appIdentifierOverride = "",
  appRootPath = path.join("tmp", "mars"),
  devProfile = "",
  isDevMode = true,
  isPackaged = false,
  userDataOverride = "",
} = {}) {
  const baseAppIdentifier = isDevMode ? DEV_APP_IDENTIFIER : PROD_APP_IDENTIFIER;
  const appIdentifier = resolveAppIdentifier({
    appIdentifierOverride,
    appRootPath,
    baseAppIdentifier,
    devAppIdentifier: DEV_APP_IDENTIFIER,
    devProfile,
    isDevMode,
    isPackaged,
  });
  return {
    appIdentifier,
    userDataPath: resolveUserDataPath({
      appDataPath: APP_DATA_PATH,
      appIdentifier,
      userDataOverride,
    }),
  };
}

test("unset MARS_DEV_PROFILE keeps the legacy dev identifier", () => {
  const profile = resolveProfile();

  assert.equal(profile.appIdentifier, DEV_APP_IDENTIFIER);
  assert.equal(profile.userDataPath, path.join(APP_DATA_PATH, DEV_APP_IDENTIFIER));
});

test("auto dev profile is stable for one worktree and different for another", () => {
  const firstPath = path.join("tmp", "worktrees", "mars");
  const secondPath = path.join("tmp", "other", "mars");
  const firstProfile = deriveAutoDevProfileName(firstPath);

  assert.equal(deriveAutoDevProfileName(firstPath), firstProfile);
  assert.notEqual(deriveAutoDevProfileName(secondPath), firstProfile);
  assert.match(firstProfile, /^mars-[a-f0-9]{10}$/);
});

test("named dev profile is sanitized into the dev app identifier", () => {
  const profile = resolveProfile({ devProfile: "  Feature/Profile: 01  " });

  assert.equal(profile.appIdentifier, `${DEV_APP_IDENTIFIER}.feature-profile-01`);
  assert.equal(profile.userDataPath, path.join(APP_DATA_PATH, `${DEV_APP_IDENTIFIER}.feature-profile-01`));
});

test("MARS_ELECTRON_USERDATA beats MARS_DEV_PROFILE for the profile directory", () => {
  const explicitUserData = path.join("tmp", "explicit-user-data");
  const profile = resolveProfile({ devProfile: "auto", userDataOverride: explicitUserData });

  assert.equal(profile.userDataPath, explicitUserData);
});

test("packaged mode ignores MARS_DEV_PROFILE", () => {
  const profile = resolveProfile({ devProfile: "auto", isPackaged: true });

  assert.equal(profile.appIdentifier, DEV_APP_IDENTIFIER);
  assert.equal(profile.userDataPath, path.join(APP_DATA_PATH, DEV_APP_IDENTIFIER));
});
