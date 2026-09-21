"""Check process ownership and profile isolation without a GPU or model download."""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


class LauncherTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.env = dict(
            os.environ,
            BONSAI_AGENT_DIR=str(self.root / "agent"),
            XDG_STATE_HOME=str(self.root / "state"),
            PI_CODING_AGENT_DIR=str(self.root / "regular-pi"),
            TEST_ROOT=str(self.root),
        )
        self.env.pop("BONSAI_BASE_URL", None)
        self.env["BONSAI_VARIANT"] = "pq2"
        self.fake_server = self.write(
            "server",
            """
import json, os, sys, time
from pathlib import Path
if "--download-model" in sys.argv:
    if os.environ.get("TEST_SLOW_DOWNLOAD") and os.environ["BONSAI_VARIANT"] == "abliterated-pq2":
        Path(os.environ["TEST_ROOT"], "download-pid").write_text(str(os.getpid()))
        time.sleep(60)
    raise SystemExit(0)
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
Path(os.environ["TEST_ROOT"], "server-pid").write_text(str(os.getpid()))
with Path(os.environ["TEST_ROOT"], "all-server-pids").open("a") as f:
    f.write(str(os.getpid()) + "\\n")
if os.environ.get("TEST_SERVER_FAIL") or os.environ.get("TEST_FAIL_VARIANT") == os.environ["BONSAI_VARIANT"]:
    raise SystemExit(17)
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get("Authorization") != "Bearer " + os.environ["BONSAI_API_KEY"]:
            self.send_response(401)
            self.end_headers()
            return
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps({"data": [{"id": "bonsai2-" + os.environ["BONSAI_VARIANT"]}]}).encode())
HTTPServer(("127.0.0.1", int(os.environ["BONSAI_PORT"])), Handler).serve_forever()
""",
        )
        self.fake_pi = self.write(
            "pi",
            """
import json, os, sys, time
from pathlib import Path
Path(os.environ["TEST_ROOT"], "pi-call").write_text(json.dumps({
    "args": sys.argv[1:], "agent": os.environ["PI_CODING_AGENT_DIR"],
    "offline": os.environ["PI_OFFLINE"], "base": os.environ.get("BONSAI_BASE_URL")
}))
if os.environ.get("TEST_SWITCH"):
    import urllib.request, urllib.error
    def switch(variant, key):
        req = urllib.request.Request(os.environ["BONSAI_CONTROL_URL"] + "/switch",
            data=json.dumps({"variant":variant}).encode(),
            headers={"Authorization":"Bearer " + key, "Content-Type":"application/json"})
        try:
            with urllib.request.urlopen(req) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as e:
            return e.code, None
    assert switch("abliterated-pq2", "wrong")[0] == 401
    key = os.environ["BONSAI_API_KEY"]
    assert switch("invalid", key)[0] == 500
    if os.environ.get("TEST_SLOW_DOWNLOAD"):
        import threading
        threading.Thread(target=lambda: switch("abliterated-pq2", key), daemon=True).start()
        time.sleep(0.3)
        req = urllib.request.Request(os.environ["BONSAI_CONTROL_URL"] + "/status",
            headers={"Authorization":"Bearer " + key})
        with urllib.request.urlopen(req, timeout=2) as response:
            assert "downloading" in json.load(response)["phase"]
        Path(os.environ["TEST_ROOT"], "status-checked").touch()
        time.sleep(60)
    code, data = switch("abliterated-pq2", key)
    if os.environ.get("TEST_FAIL_VARIANT"):
        assert code == 500
        target = "pq2"
    else:
        assert code == 200 and data["variant"] == "abliterated-pq2"
        target = "abliterated-pq2"
    req = urllib.request.Request(os.environ["BONSAI_BASE_URL"] + "/models",
        headers={"Authorization":"Bearer " + key})
    with urllib.request.urlopen(req) as response:
        assert json.load(response)["data"][0]["id"] == "bonsai2-" + target
    assert switch("pq2", key)[0] == 200
if os.environ.get("TEST_PI_WAIT"):
    Path(os.environ["TEST_ROOT"], "pi-pid").write_text(str(os.getpid()))
    time.sleep(60)
raise SystemExit(int(os.environ.get("TEST_PI_EXIT", "0")))
""",
        )
        source = (Path(__file__).parents[1] / "scripts/pi-bonsai2.py").read_text()
        for name, value in {
            "python": sys.executable,
            "server": str(self.fake_server),
            "pi": str(self.fake_pi),
            "extension": "/test/provider.ts",
            "registry": str(Path(__file__).parents[1] / "nix/variants.json"),
        }.items():
            source = source.replace("@" + name + "@", value)
        self.launcher = self.root / "launcher"
        self.launcher.write_text(source)
        self.launcher.chmod(0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, content):
        file = self.root / name
        file.write_text(f"#!{sys.executable}\n" + content)
        file.chmod(0o755)
        return file

    def run_launcher(self, *args):
        return subprocess.run(
            [str(self.launcher), *args], env=self.env, text=True, capture_output=True, timeout=15
        )

    def assert_stopped(self):
        pid = int((self.root / "server-pid").read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_registered_variants_isolated_and_cleaned_up(self):
        for variant in ("pq2", "ptq1", "abliterated-pq2", "abliterated-mtp"):
            with self.subTest(variant=variant):
                self.env["BONSAI_VARIANT"] = variant
                result = self.run_launcher("-p", "hello with spaces")
                self.assertEqual(result.returncode, 0, result.stderr)
                call = json.loads((self.root / "pi-call").read_text())
                self.assertEqual(call["agent"], str(self.root / "agent"))
                self.assertEqual(call["offline"], "1")
                self.assertIn(f"bonsai2-{variant}", call["args"])
                self.assertIn("--no-extensions", call["args"])
                self.assertEqual(call["args"][-1], "hello with spaces")
                self.assertFalse((self.root / "regular-pi").exists())
                self.assert_stopped()

    def test_context_change_preserves_preferences(self):
        self.assertEqual(self.run_launcher("--help").returncode, 0)
        path = self.root / "agent/settings.json"
        saved = json.loads(path.read_text())
        saved["defaultThinkingLevel"] = "off"
        saved["compaction"]["enabled"] = False
        saved["branchSummary"]["reserveTokens"] = 500
        path.write_text(json.dumps(saved))
        self.env["BONSAI_CTX"] = "4096"
        result = self.run_launcher("--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        updated = json.loads(path.read_text())
        self.assertLess(updated["compaction"]["reserveTokens"], 4096)
        self.assertLess(updated["compaction"]["keepRecentTokens"], 4096)
        self.assertFalse(updated["compaction"]["enabled"])
        self.assertEqual(updated["branchSummary"]["reserveTokens"], 500)
        self.assertEqual(updated["defaultThinkingLevel"], "off")
        call = json.loads((self.root / "pi-call").read_text())
        self.assertNotIn("--thinking", call["args"])
        self.assertEqual(self.run_launcher("--help", "--thinking", "high").returncode, 0)
        call = json.loads((self.root / "pi-call").read_text())
        self.assertEqual(call["args"][-2:], ["--thinking", "high"])

    def test_default_is_mtp(self):
        self.env.pop("BONSAI_VARIANT")
        result = self.run_launcher("-p", "hello")
        self.assertEqual(result.returncode, 0, result.stderr)
        call = json.loads((self.root / "pi-call").read_text())
        self.assertIn("bonsai2-abliterated-mtp", call["args"])
        self.assert_stopped()

    def test_variant_cli_and_catalog(self):
        result = self.run_launcher("--list-variants")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("abliterated-pq2", result.stdout)
        self.assertFalse((self.root / "agent").exists())
        result = self.run_launcher("--variant", "abliterated-pq2", "-p", "hello")
        self.assertEqual(result.returncode, 0, result.stderr)
        call = json.loads((self.root / "pi-call").read_text())
        self.assertIn("bonsai2-abliterated-pq2", call["args"])
        self.assertNotIn("--variant", call["args"])
        self.assert_stopped()

    def test_switch_and_rollback(self):
        for fail in ("", "abliterated-pq2"):
            with self.subTest(fail=fail):
                self.env["TEST_SWITCH"] = "1"
                self.env["TEST_FAIL_VARIANT"] = fail
                result = self.run_launcher("-p", "hello")
                self.assertEqual(result.returncode, 0, result.stderr)
                for pid in (self.root / "all-server-pids").read_text().splitlines():
                    with self.assertRaises(ProcessLookupError):
                        os.kill(int(pid), 0)

    def test_pi_error_is_propagated_and_server_stopped(self):
        self.env["TEST_PI_EXIT"] = "23"
        self.assertEqual(self.run_launcher("-p", "test").returncode, 23)
        self.assert_stopped()

    def test_backend_failure_does_not_start_pi(self):
        self.env["TEST_SERVER_FAIL"] = "1"
        result = self.run_launcher("-p", "test")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Backend exited with status 17", result.stderr)
        self.assertFalse((self.root / "pi-call").exists())
        self.assert_stopped()

    def test_help_does_not_start_backend(self):
        self.assertEqual(self.run_launcher("--help").returncode, 0)
        self.assertFalse((self.root / "server-pid").exists())

    def test_help_after_separator_is_a_prompt(self):
        result = self.run_launcher("-p", "--", "--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_stopped()

    def test_invalid_variant_does_not_create_profile(self):
        self.env["BONSAI_VARIANT"] = "invalid"
        result = self.run_launcher("-p", "test")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("BONSAI_VARIANT", result.stderr)
        self.assertFalse((self.root / "agent").exists())

    def test_external_backend_is_not_owned(self):
        self.env["BONSAI_BASE_URL"] = "http://127.0.0.1:9999/v1"
        self.assertEqual(self.run_launcher("-p", "test").returncode, 0)
        self.assertFalse((self.root / "server-pid").exists())
        call = json.loads((self.root / "pi-call").read_text())
        self.assertEqual(call["base"], self.env["BONSAI_BASE_URL"])

    def test_termination_during_model_download(self):
        self.env.update(TEST_SWITCH="1", TEST_SLOW_DOWNLOAD="1")
        launcher = subprocess.Popen(
            [str(self.launcher), "-p", "test"],
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            deadline = time.monotonic() + 10
            while not (self.root / "status-checked").exists():
                self.assertLess(time.monotonic(), deadline, "Download did not start")
                time.sleep(0.05)
            launcher.terminate()
            launcher.communicate(timeout=15)
            self.assertEqual(launcher.returncode, 130)
            self.assert_stopped()
            with self.assertRaises(ProcessLookupError):
                os.kill(int((self.root / "download-pid").read_text()), 0)
        finally:
            if launcher.poll() is None:
                launcher.kill()
                launcher.communicate()

    def test_termination_stops_both_children(self):
        self.env["TEST_PI_WAIT"] = "1"
        launcher = subprocess.Popen(
            [str(self.launcher), "-p", "test"],
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            deadline = time.monotonic() + 10
            while not (self.root / "pi-pid").exists():
                self.assertLess(time.monotonic(), deadline, "Pi did not start")
                time.sleep(0.05)
            launcher.terminate()
            launcher.communicate(timeout=10)
            self.assertEqual(launcher.returncode, 130)
            self.assert_stopped()
            with self.assertRaises(ProcessLookupError):
                os.kill(int((self.root / "pi-pid").read_text()), 0)
        finally:
            if launcher.poll() is None:
                launcher.kill()
                launcher.communicate()


if __name__ == "__main__":
    unittest.main()
