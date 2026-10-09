"""Tests for check_workflow_hardening.py. Run from the repository root:

    python3 -m unittest discover -s .github/scripts -p 'test_*.py'
"""

import contextlib
import importlib.util
import io
import os
import pathlib
import tempfile
import textwrap
import unittest

SCRIPT = pathlib.Path(__file__).with_name("check_workflow_hardening.py")
REPO_ROOT = SCRIPT.parents[2]

spec = importlib.util.spec_from_file_location("check_workflow_hardening", SCRIPT)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

POLICY = "mode: enforce\nallow:\n  - api.github.com\n"
# A local action that is this action: it declares a pi_args input.
LOCAL_ACTION = "name: test\ninputs:\n  pi_args:\n    description: x\nruns:\n  using: composite\n  steps: []\n"


def pi_job(runs_on="ubuntu-24.04-firewall", uses="./", with_lines=""):
    with_block = textwrap.indent(textwrap.dedent(with_lines).strip(), " " * 10)
    return textwrap.dedent(
        f"""\
        jobs:
          agent:
            runs-on: {runs_on}
            steps:
              - uses: actions/checkout@v6
              - name: Run the agent
                uses: {uses}
                with:
                  model: opencode/x
        """
    ) + (with_block + "\n" if with_block else "")


class HardeningCheckTest(unittest.TestCase):
    def setUp(self):
        self._cwd = os.getcwd()
        self._tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self._tmp.name)
        (self.root / ".github/workflows").mkdir(parents=True)
        (self.root / ".github/egress-firewall.yaml").write_text(POLICY)
        (self.root / "action.yml").write_text(LOCAL_ACTION)
        os.chdir(self.root)

    def tearDown(self):
        os.chdir(self._cwd)
        self._tmp.cleanup()

    def workflow(self, text, name="wf.yml"):
        (self.root / ".github/workflows" / name).write_text(text)

    def run_check(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = check.main()
        return code, out.getvalue()

    def assert_passes(self):
        code, out = self.run_check()
        self.assertEqual(code, 0, out)
        return out

    def assert_fails(self, *fragments):
        code, out = self.run_check()
        self.assertEqual(code, 1, out)
        for fragment in fragments:
            self.assertIn(fragment, out)
        return out

    # Recognising jobs that run the agent

    def test_local_action_job_on_firewall_runner_passes(self):
        self.workflow(pi_job())
        out = self.assert_passes()
        self.assertIn("checked 1 job(s)", out)

    def test_local_action_job_needs_firewall_runner(self):
        self.workflow(pi_job(runs_on="ubuntu-latest"))
        self.assert_fails("job 'agent'", "runs-on: ubuntu-24.04-firewall", "runs-on: ubuntu-latest")

    def test_published_action_is_recognised(self):
        self.workflow(pi_job(runs_on="ubuntu-latest", uses="lw396/pi-agent-action@v1"))
        self.assert_fails("runs-on: ubuntu-24.04-firewall")

    def test_job_running_the_pi_package_is_recognised(self):
        self.workflow(
            "jobs:\n  cli:\n    runs-on: ubuntu-latest\n    steps:\n"
            "      - run: npx @earendil-works/pi-coding-agent -p hi\n"
        )
        self.assert_fails("job 'cli'", "runs-on: ubuntu-24.04-firewall")

    def test_local_action_without_pi_args_is_not_this_action(self):
        (self.root / "other").mkdir()
        (self.root / "other/action.yml").write_text("name: other\ninputs:\n  x:\n    description: x\n")
        self.workflow(pi_job(runs_on="ubuntu-latest", uses="./other"))
        out = self.assert_passes()
        self.assertIn("nothing to check", out)

    def test_upstream_permission_mode_is_no_longer_required(self):
        self.workflow(pi_job(with_lines="allowed_tools: Bash"))
        self.assert_passes()

    def test_firewall_runner_exemption(self):
        self.workflow(pi_job(runs_on="ubuntu-latest"))
        key = "wf.yml:agent"
        check.EXEMPT_FROM_FIREWALL_RUNNER[key] = "test reason"
        try:
            out = self.assert_passes()
        finally:
            del check.EXEMPT_FROM_FIREWALL_RUNNER[key]
        self.assertIn("test reason", out)

    # The tool allowlist

    def test_named_tools_and_bash_patterns_pass(self):
        self.workflow(
            pi_job(
                with_lines="""
                allowed_tools: |
                  Bash(git add:*), Bash(bun test)
                  Edit Write
                  mcp__github_ci__*
                """
            )
        )
        self.assert_passes()

    def test_wildcard_naming_every_tool_fails(self):
        self.workflow(pi_job(with_lines='allowed_tools: "Bash,*"'))
        self.assert_fails("step 'Run the agent'", "'*'", "allowed_tools")

    def test_wildcard_outside_mcp_tools_fails(self):
        self.workflow(pi_job(with_lines="allowed_tools: b*"))
        self.assert_fails("'b*'")

    def test_wildcard_naming_every_mcp_tool_passes(self):
        self.workflow(pi_job(with_lines="allowed_tools: mcp__*"))
        self.assert_passes()

    def test_wildcard_in_disallowed_tools_passes(self):
        self.workflow(pi_job(with_lines="disallowed_tools: '*'"))
        self.assert_passes()

    def test_commented_out_rule_is_ignored(self):
        self.workflow(pi_job(with_lines="allowed_tools: |\n  # *\n  Bash"))
        self.assert_passes()

    def test_unmatched_parenthesis_fails(self):
        self.workflow(pi_job(with_lines="allowed_tools: Bash(git add"))
        self.assert_fails("'('")

    def test_tool_allowlist_exemption(self):
        self.workflow(pi_job(with_lines="allowed_tools: '*'"))
        key = "wf.yml:agent"
        check.EXEMPT_FROM_TOOL_ALLOWLIST[key] = "test reason"
        try:
            out = self.assert_passes()
        finally:
            del check.EXEMPT_FROM_TOOL_ALLOWLIST[key]
        self.assertIn("test reason", out)

    # The network allow list

    def test_missing_policy_fails(self):
        (self.root / ".github/egress-firewall.yaml").unlink()
        self.workflow(pi_job())
        self.assert_fails("egress-firewall.yaml is missing")

    def test_policy_not_enforced_fails(self):
        (self.root / ".github/egress-firewall.yaml").write_text("mode: audit\nallow: [a.com]\n")
        self.workflow(pi_job())
        self.assert_fails("must be 'enforce'")

    def test_policy_wildcard_host_fails(self):
        (self.root / ".github/egress-firewall.yaml").write_text(
            "mode: enforce\nallow: ['*.github.com']\n"
        )
        self.workflow(pi_job())
        self.assert_fails("contains '*'")


class RepositoryWorkflowsTest(unittest.TestCase):
    def test_this_repository_passes(self):
        cwd = os.getcwd()
        os.chdir(REPO_ROOT)
        try:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = check.main()
        finally:
            os.chdir(cwd)
        self.assertEqual(code, 0, out.getvalue())
        self.assertNotIn("checked 0", out.getvalue())


if __name__ == "__main__":
    unittest.main()
