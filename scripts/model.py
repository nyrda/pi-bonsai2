#!@python@
"""Resolve pinned optional weights through Nix, keeping a user GC root."""

import json
import os
import subprocess
import sys
from pathlib import Path

REGISTRY = json.loads(Path("@registry@").read_text())
PRELOADED = json.loads("""@preloaded@""")


def main():
    variant = sys.argv[1]
    if variant not in REGISTRY:
        sys.exit("Unknown BONSAI_VARIANT: " + variant)
    if variant in PRELOADED:
        print(PRELOADED[variant])
        return
    entry = REGISTRY[variant]
    root = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share")))
    root = root / "pi-bonsai2/models" / entry["sha256"]
    if root.exists():
        print(root.resolve())
        return
    root.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {entry['label']} into the Nix store…", file=sys.stderr)
    url = f"https://huggingface.co/{entry['repo']}/resolve/{entry['revision']}/{entry['filename']}"
    result = subprocess.run(
        [
            "@nix@",
            "--extra-experimental-features",
            "nix-command",
            "store",
            "prefetch-file",
            "--json",
            "--expected-hash",
            entry["sha256"],
            "--name",
            entry["filename"],
            url,
        ],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    path = json.loads(result.stdout)["storePath"]
    subprocess.run(
        ["@nixStore@", "--add-root", str(root), "--indirect", "--realise", path],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    print(path)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        sys.exit(error.stderr or str(error))
