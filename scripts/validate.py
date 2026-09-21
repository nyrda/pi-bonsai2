#!/usr/bin/env python3
"""Exercise real GPU inference and Pi tools for registered Bonsai variants."""

import argparse
import base64
import json
import os
import re
import socket
import struct
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zlib
from pathlib import Path


def test_image():
    def chunk(kind, data):
        return (
            struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        )

    row = b"\x00" + bytes([255, 0, 0]) * 128 + bytes([0, 0, 255]) * 128
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 256, 256, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(row * 256))
        + chunk(b"IEND", b"")
    )


def request(url, data=None, timeout=300):
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode() if data else None,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def check_image(answer):
    assert re.search(r"left\s*[:=]\s*red", answer, re.I), answer
    assert re.search(r"right\s*[:=]\s*blue", answer, re.I), answer


def validate(args, variant, work):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = dict(
        os.environ,
        BONSAI_VARIANT=variant,
        BONSAI_PORT=str(port),
        BONSAI_CTX=str(args.context),
        BONSAI_AGENT_DIR=str(work / "agent"),
    )
    vision = args.registry[variant]["vision"] and env.get("BONSAI_VISION", "1") != "0"
    base = f"http://127.0.0.1:{port}"
    env["BONSAI_BASE_URL"] = base + "/v1"
    logfile = work / f"{variant}.log"
    print(f"Testing {variant} at {args.context} context; log {logfile}", flush=True)
    vram_files = list(Path("/sys/class/drm").glob("card[0-9]*/device/mem_info_vram_used"))

    def vram_used():
        return sum(int(p.read_text()) for p in vram_files)

    baseline = vram_used()
    samples = [baseline]
    stop_sampling = threading.Event()

    def sample():
        while not stop_sampling.wait(0.1):
            samples.append(vram_used())

    monitor = threading.Thread(target=sample, daemon=True)
    monitor.start()
    with logfile.open("w") as log:
        subprocess.run([args.server, "--download-model"], env=env, check=True, timeout=3600)
        server = subprocess.Popen([args.server], env=env, stdout=log, stderr=log)
        try:
            start = time.monotonic()
            while time.monotonic() - start < 300:
                assert server.poll() is None, logfile.read_text()[-6000:]
                try:
                    if request(base + "/health").get("status") == "ok":
                        break
                except OSError, ValueError:
                    pass
                time.sleep(1)
            else:
                raise RuntimeError("Backend startup timed out")
            results = {
                "variant": variant,
                "context": args.context,
                "startup_seconds": time.monotonic() - start,
            }
            body = {
                "model": f"bonsai2-{variant}",
                "temperature": 0,
                "max_tokens": 128,
                "reasoning_effort": "none",
                "messages": [
                    {
                        "role": "user",
                        "content": "What is 17 multiplied by 19? Answer with only the number.",
                    }
                ],
            }
            response = request(base + "/v1/chat/completions", body)
            answer = response["choices"][0]["message"]["content"]
            assert "323" in answer, answer
            results["text"] = {"answer": answer, "timings": response.get("timings")}
            print(f"{variant}: text passed", flush=True)

            if vision:
                image = test_image()
                (work / "colors.png").write_bytes(image)
                prompt = "Identify the color of each half of this image. Reply exactly: left=COLOR,right=COLOR."
                body["messages"] = [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": "data:image/png;base64,"
                                    + base64.b64encode(image).decode()
                                },
                            },
                        ],
                    }
                ]
                response = request(base + "/v1/chat/completions", body)
                answer = response["choices"][0]["message"]["content"]
                check_image(answer)
                results["vision"] = {"answer": answer, "timings": response.get("timings")}
                print(f"{variant}: API image passed", flush=True)

            # A longer, fixed task gives a more useful decode measurement than the arithmetic reply.
            body["messages"] = [
                {"role": "user", "content": "Explain how a hash table handles collisions."}
            ]
            body["max_tokens"] = 256
            response = request(base + "/v1/chat/completions", body)
            assert response["choices"][0]["message"]["content"], response
            results["generation"] = {
                "timings": response.get("timings"),
                "usage": response.get("usage"),
            }

            command = [args.pi, "--no-session", "--thinking", "off", "-p"]
            if vision:
                result = subprocess.run(
                    [*command, "--no-tools", "@" + str(work / "colors.png"), prompt],
                    env=env,
                    cwd=work,
                    text=True,
                    capture_output=True,
                    timeout=300,
                )
                assert result.returncode == 0, result.stderr + result.stdout
                check_image(result.stdout)
                results["pi_image"] = result.stdout.strip()
                print(f"{variant}: Pi image passed", flush=True)

            # The model must actually read an unpredictable value, not guess the expected answer.
            secret = os.urandom(12).hex()
            (work / "fact.txt").write_text(f"The validation token is {secret}.\n")
            result = subprocess.run(
                [
                    *command,
                    "--tools",
                    "read",
                    "Read fact.txt using the read tool. "
                    "Reply with only the validation token from the file.",
                ],
                env=env,
                cwd=work,
                text=True,
                capture_output=True,
                timeout=300,
            )
            assert result.returncode == 0, result.stderr + result.stdout
            assert secret in result.stdout, result.stdout + result.stderr
            results["pi_tool"] = "read tool retrieved the randomly generated token"
            print(f"{variant}: Pi tool call passed", flush=True)
            result = subprocess.run(
                [
                    args.pi,
                    "--no-session",
                    "--no-tools",
                    "-p",
                    "What is 23 multiplied by 37? Reply with only the number.",
                ],
                env=env,
                cwd=work,
                text=True,
                capture_output=True,
                timeout=300,
            )
            assert result.returncode == 0, result.stderr + result.stdout
            assert "851" in result.stdout, result.stdout + result.stderr
            results["pi_thinking"] = result.stdout.strip()
            print(f"{variant}: Pi default thinking passed", flush=True)
            if args.long_context_tokens:
                token = os.urandom(8).hex()
                prompt = (
                    f"The secret validation token is {token}. Remember it.\n"
                    + " neutral" * args.long_context_tokens
                    + "\nWhat was the secret validation token at the start? Reply with only that token."
                )
                count = len(request(base + "/tokenize", {"content": prompt})["tokens"])
                assert count < args.context - 512, f"Prompt too large: {count} tokens"
                print(
                    f"{variant}: processing {count} tokens for long-context retrieval", flush=True
                )
                body["messages"] = [{"role": "user", "content": prompt}]
                body["max_tokens"] = 128
                response = request(base + "/v1/chat/completions", body, timeout=1800)
                answer = response["choices"][0]["message"]["content"]
                assert token in answer, answer
                results["long_context"] = {
                    "input_tokens": count,
                    "retrieval": "passed",
                    "timings": response.get("timings"),
                }
                print(f"{variant}: long-context retrieval passed", flush=True)
            results["vram"] = {
                "baseline_bytes": baseline,
                "peak_total_bytes": max(samples),
                "peak_increase_bytes": max(samples) - baseline,
                "note": "Device-wide VRAM measurements; includes other GPU allocations.",
            }
            print(json.dumps(results, indent=2), flush=True)
            return results
        finally:
            server.terminate()
            try:
                server.wait(timeout=15)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
            stop_sampling.set()
            monitor.join()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", required=True, type=lambda p: str(Path(p).resolve()))
    parser.add_argument("--pi", required=True, type=lambda p: str(Path(p).resolve()))
    parser.add_argument("--context", type=int, default=131072)
    parser.add_argument("--registry", required=True, type=Path)
    parser.add_argument("--variant", default="both")
    parser.add_argument(
        "--long-context-tokens",
        type=int,
        default=0,
        help="Also test synthetic long-context retrieval on each selected model with this many filler tokens",
    )
    parser.add_argument("--output", type=Path, default=Path("validation.json"))
    args = parser.parse_args()
    args.registry = json.loads(args.registry.read_text())
    if args.variant != "both" and args.variant not in args.registry:
        parser.error("Unknown variant: " + args.variant)
    work = Path(tempfile.mkdtemp(prefix="bonsai2-validation-"))
    results = []
    for variant in ["pq2", "ptq1"] if args.variant == "both" else [args.variant]:
        results.append(validate(args, variant, work))
        args.output.write_text(json.dumps(results, indent=2) + "\n")
    print(f"Passed. Results: {args.output}; logs and fixtures: {work}")


if __name__ == "__main__":
    main()
