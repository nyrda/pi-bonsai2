#!/usr/bin/env python3
"""Compare MTP against ordinary decoding using the same weights and runtime."""

import argparse
import json
import socket
import statistics
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

PROMPTS = {
    "code": "Write a Python function that merges overlapping integer intervals. Include type hints, a docstring, and a short example.",
    "json": "Return only JSON: an array of 20 objects describing fictional books, each with id, title, author, year and genre.",
    "reasoning": "Explain step by step why the sum of the first n odd positive integers is n squared. Give an algebraic and a geometric proof.",
    "technical": "Explain how a hash table handles collisions. Compare chaining and open addressing with concrete examples.",
    "prose": "Write a short story about a botanist who discovers a garden growing inside an abandoned railway station.",
}


def request(url, payload=None):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode() if payload else None,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=300) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--context", type=int, default=32768)
    parser.add_argument("--tokens", type=int, default=400)
    parser.add_argument("--output", type=Path, default=Path("validation-mtp.json"))
    args = parser.parse_args()
    results = {"context": args.context, "kv_type": "q8_0", "max_tokens": args.tokens, "modes": {}}
    vram_files = list(Path("/sys/class/drm").glob("card[0-9]*/device/mem_info_vram_used"))
    for mode in ("none", "draft-mtp"):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        url = f"http://127.0.0.1:{port}"
        command = [
            args.server,
            "-m",
            args.model,
            "--alias",
            "bonsai-mtp-test",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "-ngl",
            "99",
            "--device",
            "ROCm0",
            "--parallel",
            "1",
            "-fa",
            "on",
            "-c",
            str(args.context),
            "--cache-type-k",
            "q8_0",
            "--cache-type-v",
            "q8_0",
            "--batch-size",
            "1024",
            "--ubatch-size",
            "128",
            "--jinja",
            "--spec-type",
            mode,
            "--spec-draft-n-max",
            "2",
        ]
        with tempfile.NamedTemporaryFile(prefix=f"bonsai-mtp-{mode}-", suffix=".log") as log:
            process = subprocess.Popen(command, stdout=log, stderr=log)
            try:
                for _ in range(300):
                    if process.poll() is not None:
                        raise RuntimeError(Path(log.name).read_text()[-10000:])
                    try:
                        if request(url + "/health").get("status") == "ok":
                            break
                    except OSError, ValueError:
                        pass
                    time.sleep(1)
                else:
                    raise RuntimeError("Server startup timed out")
                body = {
                    "model": "bonsai-mtp-test",
                    "temperature": 0,
                    "seed": 42,
                    "max_tokens": args.tokens,
                    "reasoning_effort": "none",
                    "cache_prompt": False,
                }
                warmup = request(
                    url + "/v1/chat/completions",
                    {
                        **body,
                        "max_tokens": 16,
                        "messages": [
                            {
                                "role": "user",
                                "content": "What is 17 multiplied by 19? Reply with the number only.",
                            }
                        ],
                    },
                )
                assert "323" in warmup["choices"][0]["message"]["content"], warmup
                rows = []
                for name, prompt in PROMPTS.items():
                    response = request(
                        url + "/v1/chat/completions",
                        {
                            **body,
                            "messages": [{"role": "user", "content": prompt}],
                        },
                    )
                    text = response["choices"][0]["message"]["content"]
                    assert text, response
                    rows.append(
                        {
                            "prompt": name,
                            "timings": response["timings"],
                            "usage": response["usage"],
                            "text": text,
                            "device_vram_bytes": sum(int(p.read_text()) for p in vram_files),
                        }
                    )
                    print(
                        f"{mode}: {name}: {response['timings']['predicted_per_second']:.1f} tok/s",
                        flush=True,
                    )
                results["modes"][mode] = {
                    "samples": rows,
                    "median_tokens_per_second": statistics.median(
                        r["timings"]["predicted_per_second"] for r in rows
                    ),
                }
                args.output.write_text(json.dumps(results, indent=2) + "\n")
            finally:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
    base = results["modes"]["none"]["median_tokens_per_second"]
    mtp = results["modes"]["draft-mtp"]["median_tokens_per_second"]
    print(f"Median: {base:.1f} -> {mtp:.1f} tok/s ({(mtp / base - 1) * 100:+.1f}%)")


if __name__ == "__main__":
    main()
