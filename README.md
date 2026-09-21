# pi-bonsai2

Run [Pi](https://github.com/earendil-works/pi), a terminal coding assistant,
locally on your AMD GPU. Chat with it, attach screenshots, and let it read and
edit code or run commands. No cloud API is required.

Nix installs the software and model weights. The default model supports images
and a 128K context, with accelerated generation. Other variants download only
when selected.

## Performance and memory

Generation speed depends on the task, context, and thinking settings. The figures
below are a short benchmark, not expected speeds for the default Pi configuration.

RX 7900 XT, 32K context, Q8 KV cache, thinking off, greedy decoding.
Same MTP weights in both modes; five prompts capped at 400 output tokens.
Pi defaults to 128K context and medium thinking.

| Task | MTP off | MTP on, 2 draft tokens |
| --- | --- | --- |
| Code | 53.4 tok/s | 96.9 tok/s |
| JSON | 53.5 tok/s | 95.2 tok/s |
| Reasoning | 53.5 tok/s | 93.3 tok/s |
| Technical explanation | 53.5 tok/s | 88.0 tok/s |
| Prose | 53.5 tok/s | 67.6 tok/s |

The 128K configuration with vision used **14.0 GiB VRAM** above baseline
in validation.
Timing comes from llama-server's `predicted_per_second`, excluding prompt processing.
VRAM is the change in total device usage. These tests allocate the context window
without filling it.

## Install and run

Requires x86_64 Linux and Nix with flakes enabled. The supplied build targets
RX 7900 GPUs and uses 14 GiB VRAM at default settings. The first installation
compiles the runtime. [Other AMD GPUs need a matching build](#building-for-another-gpu).

```sh
nix profile install github:nyrda/pi-bonsai2#pi-bonsai2
pi-bonsai2
```

If your shell does not include the Nix profile in `PATH`, use
`~/.nix-profile/bin/pi-bonsai2`, or add `~/.nix-profile/bin` to `PATH`.

Or run without installing:

```sh
nix run github:nyrda/pi-bonsai2
```

The default installation downloads MTP weights, about 8.3 GB including the shared
vision projector, plus the runtime dependencies. The installed program runs
offline and starts its own authenticated backend on a local, automatically chosen
port. Closing Pi stops that backend and releases its GPU memory.

```sh
# Images can be attached in Pi or passed on the command line.
pi-bonsai2 @screenshot.png "Explain this screenshot."

# Skip thinking for short tasks.
pi-bonsai2 --thinking off -p "Explain this project in a paragraph."
```

The footer shows live generation speed, such as `Bonsai 37.8 tok/s · 256 tokens`,
using llama-server's timing data. It includes thinking and tool-call tokens,
excludes prompt processing, and keeps the final rate visible after each response.

Update the installed package with `nix profile upgrade pi-bonsai2`.

## Hardware

Requires x86_64 Linux, Nix with flakes enabled, and GPU access through `/dev/kfd`
and `/dev/dri`. Tested on a Radeon RX 7900 XT with 20 GiB VRAM. The default 128K
configuration uses **14 GiB VRAM**.

The current build targets the RX 7900 family, `gfx1100`. Other
[ROCm-supported AMD GPUs](https://rocm.docs.amd.com/en/docs-7.2.3/compatibility/compatibility-matrix.html)
require a build for their architecture; they have not been tested here.
See [building for another GPU](#building-for-another-gpu).

The first build compiles the runtime. Nix supplies its ROCm libraries; no global
ROCm installation or Python environment is needed.

## Switch models

```sh
pi-bonsai2 --list-variants
pi-bonsai2 --variant abliterated-pq2
# Or: nix run github:nyrda/pi-bonsai2 -- --variant abliterated-pq2
```

Inside Pi, use `/bonsai-model` to choose a variant, or
`/bonsai-model abliterated-pq2` to switch directly. Switching preserves the
conversation and loads one model at a time.

The default is abliterated, modified to reduce refusals. Multi-token prediction
drafts and verifies tokens to speed up generation. All variants support text and images.

| Variant | Weights | Choose it for |
| --- | --- | --- |
| `abliterated-mtp` | 7.66 GB, default | Faster generation with BoldingBuilds' abliterated model |
| `pq2` | 7.21 GB, on demand | Original Prism weights without abliteration |
| `ptq1` | 5.95 GB, on demand | Smaller download of the original model |
| `abliterated-pq2` | 7.21 GB, on demand | Comparing Hikari's abliteration with BoldingBuilds' |

The `#pi-bonsai2-with-ptq1` package remains available to preinstall PTQ1.

Model switching shows preparation and GPU loading status with elapsed time.
Downloads and server output are recorded in the backend log.

## Independent Pi profile

Settings and sessions live under `~/.local/share/pi-bonsai2/agent`, respecting
`XDG_DATA_HOME`. Set `BONSAI_AGENT_DIR` to use another directory. Backend logs live
under `~/.local/state/pi-bonsai2`, respecting `XDG_STATE_HOME`.

This launcher does not load your regular Pi profile, auto-discovered extensions,
skills, prompt templates, themes, context files, or project `.pi` settings.
Explicit Pi flags such as `--extension` and `--append-system-prompt` still work.
Use `--append-system-prompt /path/to/AGENTS.md` to supply project instructions.

The profile starts with medium thinking, limited reasoning budgets, compaction
thresholds suitable for local context sizes, and image input enabled. The provider
switches sampling settings between thinking and non-thinking modes according to
Prism's model card. Unsupported minimal and low thinking levels are omitted.
Edit the isolated `settings.json` to customize the profile. Saved thinking settings
apply on startup; `--thinking` overrides them. When you lower `BONSAI_CTX`, the
launcher reduces compaction and branch-summary budgets to fit. Smaller custom
budgets remain unchanged.

The default context is 131,072 tokens with an 8-bit KV cache and a 128-token
physical batch. Pi knows the same context limit, allows up to 8,192 output tokens,
and initially caps medium reasoning at 2,048 tokens to leave room for an answer.

## Run the backend separately

```sh
bonsai2-server
# Or: nix run github:nyrda/pi-bonsai2#server

# Connect the isolated Pi to that server in another terminal.
BONSAI_BASE_URL=http://127.0.0.1:28743/v1 pi-bonsai2
```

The server exposes an OpenAI-compatible API and web UI on loopback port 28743.
It loads the vision projector for image-capable variants. Set
`BONSAI_VARIANT=abliterated-pq2` on both the server and connecting Pi command to
use another variant. The launcher leaves externally
managed servers running. Set `BONSAI_API_KEY` when connecting to an authenticated server.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BONSAI_VARIANT` | `abliterated-mtp` | Registry variant; optional weights download on first use |
| `BONSAI_CTX` | `131072` | Context per session; use the same value for an external server and Pi |
| `BONSAI_KV_TYPE` | `q8_0` | KV cache precision; `q4_0` uses less memory but is experimental |
| `BONSAI_VISION` | `1` | Set to `0` for text-only input without loading the vision projector |
| `BONSAI_IMAGE_MAX_TOKENS` | `1024` | Raise to `2048` or `4096` for detailed images and OCR |
| `BONSAI_PORT` | `28743` | Standalone backend port; automatic for the Pi-managed backend |
| `BONSAI_BASE_URL` | unset | Connect Pi to an existing backend instead of starting one |
| `BONSAI_AGENT_DIR` | XDG data directory | Isolated Pi settings and sessions |

To disable vision and reduce GPU memory use:

```sh
BONSAI_VISION=0 pi-bonsai2
# Or: BONSAI_VISION=0 bonsai2-server
```

This skips loading the vision projector and configures Pi for text-only input.
Estimated VRAM savings: **0.8–1.0 GiB**. The projector remains part of the Nix download. When connecting to an external
server, set `BONSAI_VISION=0` for both the server and Pi.

Additional `bonsai2-server` arguments go to llama-server. For example,
`--image-max-tokens 2048` raises the default 1024-token image cap for detailed OCR.
The server explicitly selects `ROCm0` so missing GPU support fails visibly.

For the full 262,144-token window with a smaller KV cache:

```sh
BONSAI_CTX=262144 BONSAI_KV_TYPE=q4_0 pi-bonsai2
```

Q4 KV reduces memory use and can reduce accuracy.

## Pins

- Nixpkgs: `e8be7818e19ada32105a8af937a6a473b38167ca`, locked in `flake.lock`.
- Pi: 0.84.3 from that Nixpkgs revision.
- [Prism runtime](https://github.com/PrismML-Eng/llama.cpp/releases/tag/prism-b10709-9a9394a):
  `prism-b10709-9a9394a`, built with ROCm and the MTP Hadamard fix.
- [Default MTP weights](https://huggingface.co/BoldingBuilds/Ternary-Bonsai-2-27B-Abliterated-PQ2_0-MTP-GGUF/tree/f6c0aa5b6b5179039f1ef12eb84d361d468bbc73):
  `f6c0aa5b6b5179039f1ef12eb84d361d468bbc73`.
- [Original models and vision projector](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/tree/6ed5e12bf84b7a63069882c91dd9e9218647d17b):
  `6ed5e12bf84b7a63069882c91dd9e9218647d17b`, with PQ2_0, PTQ1_0, and Q8_0 mmproj.

PQ2_0 and PTQ1_0 are two weight packings of Bonsai 2 27B. The Prism runtime
provides the Hadamard activation transform required by this model.

## Validation

```sh
nix flake check github:nyrda/pi-bonsai2
nix run github:nyrda/pi-bonsai2#validate
```

`flake check` tests profile isolation, startup failures, exit codes, backend
cleanup, provider model switching, and the live speed indicator without a GPU. The default validation tests the MTP model.
Use `nix run github:nyrda/pi-bonsai2#validate-both` to explicitly download and test
original PQ2 and PTQ1. `validate.py` checks arithmetic, image understanding through the
API and Pi, and a Pi `read` tool call that retrieves a randomly generated value. It records request timings in
`validation.json`. With `validate-both`, use `--variant ptq1` to test only PTQ1.
Use `--variant abliterated-pq2` to validate the Hikari variant.
Add `--long-context-tokens 32768` to test retrieval from a synthetic 32K-token
prompt on the selected model, including the default MTP variant. Allocating a 128K window is separate from testing an input that
fills that entire window.

## Development

```sh
git clone https://github.com/nyrda/pi-bonsai2.git
cd pi-bonsai2
nix develop
nix fmt -- flake.nix nix/*.nix
ruff format scripts tests
ruff check scripts tests
nix flake check
```

To add a variant, add its repository, revision, filename, SHA-256, label, and
vision support to `nix/variants.json`. The server and Pi use the same registry.

CI runs formatting, lint, launcher and speed-indicator tests, and a dependency check that keeps PTQ1
out of the default installation. It needs neither a GPU nor model downloads.
Run `nix run .#validate` separately for GPU inference checks.

### Reproduce the speed comparison

```sh
nix build .#llama-cpp-prism -o result-runtime
nix build .#model-abliterated-mtp -o result-model
nix develop --command python scripts/benchmark-mtp.py \
  --server ./result-runtime/bin/llama-server --model ./result-model
```

Results go to `validation-mtp.json`.

### Building for another GPU

Set `gpuTargets` in the `runtimeMtp` call in `flake.nix`, then run the local flake:

```nix
runtimeMtp = pkgs.callPackage ./nix/runtime-mtp.nix {
  gpuTargets = [ "gfx1101" ];
  buildJobs = 2;
};
```

```sh
nix run .
```

Use the architecture listed for your card in AMD's compatibility matrix.
Multiple targets can be included in the list; each adds compilation work.
Increase `buildJobs` to compile faster if you have enough system RAM.

## License

The integration code is [MIT licensed](LICENSE). Pi and Prism's llama.cpp fork
retain their upstream licenses; the Bonsai 2 weights are Apache-2.0 licensed.
