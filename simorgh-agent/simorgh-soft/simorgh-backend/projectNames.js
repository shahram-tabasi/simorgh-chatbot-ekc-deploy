// Project names, and the one question the duplicate rule turns on.
//
// Its own file rather than a couple of functions inside server.js, because
// server.js starts a server the moment it is imported: a test that wanted to
// check this logic would have had to copy it, and a copy of a rule is a rule
// that drifts from the one that ships.

/**
 * A project name as the uniqueness rule compares them.
 *
 * Case and run-together spaces are not a different project: "Sarmad Iron &
 * Steel CO." and "sarmad  iron & steel co." are somebody typing the same thing
 * twice, and the point of the rule is to catch exactly that.
 */
export function projectNameKey(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Is this save changing the project's name, or keeping it?
 *
 * Everything about the duplicate-name fix hangs off this. The check used to
 * run on every save, and on a database that already held two projects of the
 * same name — which is the situation that made the rule worth adding — it made
 * both of them permanently unsaveable: saving either found the other, answered
 * 409, and the autosave retried every fifteen seconds forever. A guard against
 * creating a second duplicate had become a guard against working at all.
 *
 * So a save that keeps the name it already has is never a clash, and only a
 * real rename is checked against the other projects.
 *
 * It compares against the stored *name* and not a stored key, because a
 * document written before the key field existed has none, and treating a
 * missing field as "different" would call every save a rename and put us
 * straight back where we started.
 */
export function isRename(storedName, newName) {
  if (storedName === undefined || storedName === null) return true;
  return projectNameKey(storedName) !== projectNameKey(newName);
}
