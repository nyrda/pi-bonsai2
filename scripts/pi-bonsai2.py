#!@python@
"""Start a private Bonsai server, run Pi, and release GPU memory on exit."""

import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SERVER = "@server@"
PI = "@pi@"
EXTENSION = "@extension@"
REGISTRY = json.loads(Path("@registry@").read_text())


def main():
    env = os.environ.copy()
    options = sys.argv[1:]
    pi_options = []
    variant = env.get("BONSAI_VARIANT", "abliterated-mtp")
    while options:
        option, *options = options
        if option == "--":
            pi_options.extend([option, *options])
            break
        if option == "--list-variants":
            for name, entry in REGISTRY.items():
                print(f"{name:20} {entry['label']}")
            return 0
        if option == "--variant":
            if not options:
                sys.exit("--variant requires a name")
            variant, *options = options
        elif option.startswith("--variant="):
            variant = option.split("=", 1)[1]
        else:
            pi_options.append(option)
    if variant not in REGISTRY:
        sys.exit("Unknown BONSAI_VARIANT: " + variant)
    env["BONSAI_VARIANT"] = variant
    if env.setdefault("BONSAI_VISION", "1") not in ("0", "1"):
        sys.exit("BONSAI_VISION must be 0 or 1")
    agent_dir = Path(
        env.get(
            "BONSAI_AGENT_DIR",
            str(
                Path(env.get("XDG_DATA_HOME", str(Path.home() / ".local/share")))
                / "pi-bonsai2/agent"
            ),
        )
    )
    agent_dir.mkdir(parents=True, exist_ok=True)
    env["PI_CODING_AGENT_DIR"] = str(agent_dir)
    env["PI_OFFLINE"] = "1"
    env["PI_SKIP_VERSION_CHECK"] = "1"
    env["PI_TELEMETRY"] = "0"
    try:
        context = int(env.setdefault("BONSAI_CTX", "131072"))
        if not 4096 <= context <= 262144:
            raise ValueError
    except ValueError:
        sys.exit("BONSAI_CTX must be an integer between 4096 and 262144")
    settings = {
        "defaultProvider": "bonsai2",
        "defaultThinkingLevel": "medium",
        "enableInstallTelemetry": False,
        "enableAnalytics": False,
        "defaultProjectTrust": "never",
        "compaction": {
            "enabled": True,
            "reserveTokens": min(8192, context // 3),
            "keepRecentTokens": min(16384, context // 4),
        },
        "branchSummary": {"reserveTokens": min(4096, context // 3)},
        "thinkingBudgets": {"medium": 2048, "high": 4096, "xhigh": 6144},
        "retry": {"enabled": True, "maxRetries": 1},
        "images": {"autoResize": True, "blockImages": False},
    }
    try:
        with (agent_dir / "settings.json").open("x") as handle:
            json.dump(settings, handle, indent=2)
            handle.write("\n")
    except FileExistsError:
        path = agent_dir / "settings.json"
        saved = json.loads(path.read_text())
        changed = False
        # Preserve custom settings, but bound history budgets to this context.
        for section, keys in (
            ("compaction", ("reserveTokens", "keepRecentTokens")),
            ("branchSummary", ("reserveTokens",)),
        ):
            values = saved.setdefault(section, {})
            for key in keys:
                limit = settings[section][key]
                if key not in values or values[key] > limit:
                    values[key] = limit
                    changed = True
        if changed:
            temporary = path.with_suffix(".json.tmp")
            temporary.write_text(json.dumps(saved, indent=2) + "\n")
            temporary.replace(path)
    args = [
        PI,
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-approve",
        "-e",
        EXTENSION,
        "--provider",
        "bonsai2",
        "--model",
        f"bonsai2-{variant}",
        *pi_options,
    ]
    # Help, version, and catalog inspection do not need a GPU or running server.
    options = pi_options
    if "--" in options:
        options = options[: options.index("--")]
    if any(a in options for a in ("--help", "-h", "--version", "-v", "--list-models")):
        os.execve(PI, args, env)
    # An explicitly supplied backend remains owned by its caller.
    if env.get("BONSAI_BASE_URL"):
        os.execve(PI, args, env)

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env["BONSAI_PORT"] = str(port)
    env["BONSAI_API_KEY"] = secrets.token_urlsafe(32)
    env["BONSAI_BASE_URL"] = f"http://127.0.0.1:{port}/v1"
    state = Path(env.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "pi-bonsai2"
    state.mkdir(parents=True, exist_ok=True)
    log = tempfile.NamedTemporaryFile(prefix=f"{variant}-", suffix=".log", dir=state, delete=False)
    server = None
    pi = None

    lock = threading.Lock()
    control = None
    closing = threading.Event()
    status = {"phase": "Preparing model", "started": time.monotonic()}

    def set_phase(phase):
        status.update(phase=phase, started=time.monotonic())
        if pi is None:
            print(phase, file=sys.stderr, flush=True)

    def stop_server():
        nonlocal server
        if server is not None and server.poll() is None:
            os.killpg(server.pid, signal.SIGTERM)
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(server.pid, signal.SIGKILL)
                server.wait()
        server = None

    def download(selected):
        set_phase(f"Checking / downloading {REGISTRY[selected]['label']}")
        process = subprocess.Popen(
            [SERVER, "--download-model"],
            env=dict(env, BONSAI_VARIANT=selected),
            stdout=log,
            stderr=log,
            start_new_session=True,
        )
        try:
            deadline = time.monotonic() + 3600
            next_update = time.monotonic() + 10
            while process.poll() is None:
                if closing.wait(0.1):
                    raise RuntimeError("Launcher is shutting down")
                if pi is None and time.monotonic() >= next_update:
                    elapsed = int(time.monotonic() - status["started"])
                    print(
                        f"Preparing weights: {elapsed}s elapsed. Ctrl+C to cancel.", file=sys.stderr
                    )
                    next_update = time.monotonic() + 10
                if time.monotonic() >= deadline:
                    raise RuntimeError("Model download timed out")
            if process.returncode:
                raise RuntimeError(f"Model download failed. See {log.name}")
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()

    def start_server(selected):
        nonlocal server
        if closing.is_set():
            raise RuntimeError("Launcher is shutting down")
        set_phase(f"Loading {REGISTRY[selected]['label']} on GPU")
        server = subprocess.Popen(
            [SERVER, "--api-key", env["BONSAI_API_KEY"]],
            env=dict(env, BONSAI_VARIANT=selected),
            stdout=log,
            stderr=log,
            start_new_session=True,
        )
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            if closing.is_set():
                raise RuntimeError("Launcher is shutting down")
            if server.poll() is not None:
                raise RuntimeError(f"Backend exited with status {server.returncode}")
            try:
                request = urllib.request.Request(
                    env["BONSAI_BASE_URL"] + "/models",
                    headers={"Authorization": "Bearer " + env["BONSAI_API_KEY"]},
                )
                with urllib.request.urlopen(request, timeout=2) as response:
                    models = json.load(response)
                if any(m["id"] == f"bonsai2-{selected}" for m in models["data"]):
                    set_phase("Ready")
                    return
            except OSError, ValueError:
                pass
            time.sleep(0.5)
        raise RuntimeError("Backend did not become ready within 300 seconds")

    class ControlHandler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            if self.headers.get("Authorization") != "Bearer " + env["BONSAI_API_KEY"]:
                self.send_error(401)
                return
            if self.path != "/status":
                self.send_error(404)
                return
            payload = json.dumps(
                {
                    "phase": status["phase"],
                    "elapsed": int(time.monotonic() - status["started"]),
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload)

        def do_POST(self):
            nonlocal variant
            if self.headers.get("Authorization") != "Bearer " + env["BONSAI_API_KEY"]:
                self.send_error(401)
                return
            if self.path != "/switch":
                self.send_error(404)
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 1024:
                    raise ValueError("Invalid request size")
                selected = json.loads(self.rfile.read(size))["variant"]
                if not isinstance(selected, str) or selected not in REGISTRY:
                    raise ValueError("Unknown variant")
                with lock:
                    if selected != variant:
                        download(selected)
                        stop_server()
                        try:
                            start_server(selected)
                        except OSError, RuntimeError:
                            stop_server()
                            start_server(variant)
                            raise
                        variant = selected
                payload = json.dumps({"variant": variant}).encode()
                self.send_response(200)
            except (
                OSError,
                RuntimeError,
                ValueError,
                KeyError,
                subprocess.TimeoutExpired,
            ) as error:
                payload = json.dumps({"error": str(error)}).encode()
                self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            try:
                self.wfile.write(payload)
            except OSError:
                pass

    def interrupted(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    try:
        print(f"Backend log: {log.name}", file=sys.stderr)
        download(variant)
        start_server(variant)
        control = ThreadingHTTPServer(("127.0.0.1", 0), ControlHandler)
        control.timeout = 1
        env["BONSAI_CONTROL_URL"] = f"http://127.0.0.1:{control.server_port}"
        threading.Thread(target=control.serve_forever, daemon=True).start()
        pi = subprocess.Popen(args, env=env)
        return pi.wait()
    except KeyboardInterrupt:
        return 130
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"{error}. See {log.name}", file=sys.stderr)
        print(Path(log.name).read_text(errors="replace")[-6000:], file=sys.stderr)
        return 1
    finally:
        closing.set()
        if pi is not None and pi.poll() is None:
            pi.terminate()
            try:
                pi.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pi.kill()
                pi.wait()
        if control is not None:
            control.shutdown()
            control.server_close()
        stop_server()
        log.close()


if __name__ == "__main__":
    sys.exit(main())
