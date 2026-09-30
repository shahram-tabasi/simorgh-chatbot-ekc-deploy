// src/utils/buildStamp.ts
//
// Which build of the app is this?
//
// Every image is published as :latest and :latest is whichever branch pushed
// last, so "that feature was there yesterday and is gone today" is usually a
// question about the image, not the code — and there was no way to ask it. The
// commit, the branch and the build time are stamped into the bundle at build
// time (see the Dockerfile's GIT_SHA / GIT_REF / BUILD_TIME) and written to
// build.json beside it, so the answer can be read either from the screen or
// with one curl.

const env = (import.meta as { env?: Record<string, string> }).env ?? {};

export interface BuildStamp {
  sha: string;
  ref: string;
  built: string;
}

export const buildStamp: BuildStamp = {
  sha: env.VITE_BUILD_SHA || '',
  ref: env.VITE_BUILD_REF || '',
  built: env.VITE_BUILD_TIME || '',
};

/** `a1b2c3d · claude/nifty-keller-0t006m · 2026-09-15`, or '' in a dev run. */
export function buildLabel(stamp: BuildStamp = buildStamp): string {
  const parts: string[] = [];
  // A full sha is noise on screen and the short one is what a person types
  // back at git; the whole value is still in the title attribute and in
  // build.json for when the exact commit matters.
  if (stamp.sha && stamp.sha !== 'unknown') parts.push(stamp.sha.slice(0, 7));
  if (stamp.ref && stamp.ref !== 'unknown') parts.push(stamp.ref);
  if (stamp.built && stamp.built !== 'unknown') parts.push(stamp.built.slice(0, 10));
  return parts.join(' · ');
}
