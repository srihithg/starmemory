/** Which agent wrote the transcript an exchange came from. All of them share one
 * store (design doc §16); the tag is what lets a search ask for only one side.
 * A `cowork` transcript is not one the harness wrote: a Cowork session runs in a
 * cloud container that is thrown away, so the model writes a record of it
 * through the `remember` tool instead (src/cowork.ts). */
export const HARNESSES = ['claude', 'codex', 'cowork'];
