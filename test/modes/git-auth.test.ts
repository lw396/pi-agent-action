// How the modes set git up for the agent's commits: which git-config helper
// each commit method uses, and what a failure does.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as gitConfig from "../../src/github/operations/git-config";
import { setupGitAuth } from "../../src/modes/git-auth";
import { createMockAutomationContext } from "../mockContext";

describe("setupGitAuth", () => {
  let spies: Record<
    "configureGitAuth" | "replaceCheckoutCredentials" | "setupSshSigning",
    ReturnType<typeof spyOn>
  >;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spies = {
      configureGitAuth: spyOn(gitConfig, "configureGitAuth").mockImplementation(
        async () => {},
      ),
      replaceCheckoutCredentials: spyOn(
        gitConfig,
        "replaceCheckoutCredentials",
      ).mockImplementation(async () => {}),
      setupSshSigning: spyOn(gitConfig, "setupSshSigning").mockImplementation(
        async () => {},
      ),
    };
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const spy of Object.values(spies)) spy.mockRestore();
    errorSpy.mockRestore();
  });

  function setup(
    inputs: { sshSigningKey?: string; useCommitSigning?: boolean },
    failOnError = true,
  ) {
    const context = createMockAutomationContext({ inputs });
    const method = setupGitAuth({
      githubToken: "token",
      context,
      untrustedInput: true,
      failOnError,
    });
    return { context, method };
  }

  test("plain git: sets the bot user and the action's credential", async () => {
    const { context, method } = setup({});

    expect(await method).toBe("git");
    expect(spies.configureGitAuth).toHaveBeenCalledWith(
      "token",
      context,
      { login: context.inputs.botName, id: parseInt(context.inputs.botId) },
      true,
    );
    expect(spies.setupSshSigning).not.toHaveBeenCalled();
  });

  test("API commits: only replaces the checkout credential", async () => {
    const { context, method } = setup({ useCommitSigning: true });

    expect(await method).toBe("api");
    expect(spies.replaceCheckoutCredentials).toHaveBeenCalledWith(
      "token",
      context,
      true,
    );
    expect(spies.configureGitAuth).not.toHaveBeenCalled();
  });

  test("SSH signing takes precedence over use_commit_signing", async () => {
    const { method } = setup({
      sshSigningKey: "key",
      useCommitSigning: true,
    });

    expect(await method).toBe("ssh-signed");
    expect(spies.setupSshSigning).toHaveBeenCalledWith("key");
    expect(spies.configureGitAuth).toHaveBeenCalledTimes(1);
    expect(spies.replaceCheckoutCredentials).not.toHaveBeenCalled();
  });

  test("a credential failure fails the run only with failOnError", async () => {
    spies.configureGitAuth.mockImplementation(async () => {
      throw new Error("git config failed");
    });

    await expect(setup({}, true).method).rejects.toThrow("git config failed");
    expect(await setup({}, false).method).toBe("git");
  });

  test("an SSH signing failure always fails the run", async () => {
    spies.setupSshSigning.mockImplementation(async () => {
      throw new Error("bad key");
    });

    await expect(setup({ sshSigningKey: "key" }, false).method).rejects.toThrow(
      "bad key",
    );
  });
});
