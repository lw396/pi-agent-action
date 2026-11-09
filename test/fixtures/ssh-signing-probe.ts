// Runs the real SSH signing setup/cleanup in a process whose HOME the caller
// controls. `src/github/operations/git-config.ts` derives the signing key path
// from homedir() at import time, so the companion test spawns this file with an
// isolated HOME and a throwaway git repository as cwd.
import {
  cleanupSshSigning,
  setupSshSigning,
} from "../../src/github/operations/git-config";

const [action, key = ""] = process.argv.slice(2);

const result = await (action === "cleanup"
  ? cleanupSshSigning()
  : setupSshSigning(key)
).then(
  () => ({ ok: true }),
  (error: unknown) => ({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  }),
);

process.stdout.write(JSON.stringify(result) + "\n");
if (!result.ok) process.exitCode = 1;
