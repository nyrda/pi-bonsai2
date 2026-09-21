{
  description = "Bonsai 2 on AMD ROCm, with a text and image capable Pi launcher";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/e8be7818e19ada32105a8af937a6a473b38167ca";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      runtime = pkgs.callPackage ./nix/runtime.nix { };
      runtimeMtp = pkgs.callPackage ./nix/runtime-mtp.nix { };
      models = import ./nix/models.nix { inherit (pkgs) fetchurl; };
      resolver =
        includePtq1:
        pkgs.replaceVarsWith {
          src = ./scripts/model.py;
          isExecutable = true;
          dir = "bin";
          name = "bonsai2-model";
          replacements = {
            python = "${pkgs.python3}/bin/python3";
            nix = "${pkgs.nix}/bin/nix";
            nixStore = "${pkgs.nix}/bin/nix-store";
            registry = "${./nix/variants.json}";
            preloaded = builtins.toJSON (
              {
                abliterated-mtp = "${models.abliterated-mtp}";
              }
              // pkgs.lib.optionalAttrs includePtq1 { ptq1 = "${models.ptq1}"; }
            );
          };
        };
      mkServer =
        includePtq1:
        pkgs.writeShellApplication {
          name = "bonsai2-server";
          text = ''
            export BONSAI_VARIANT="''${BONSAI_VARIANT:-abliterated-mtp}"
            mapfile -t variant_args < <(${pkgs.jq}/bin/jq -r --arg v "$BONSAI_VARIANT" '.[$v].serverArgs[]?' ${./nix/variants.json})
            model=$(${resolver includePtq1}/bin/bonsai2-model "$BONSAI_VARIANT")
            if [[ "''${1:-}" == "--download-model" ]]; then exit 0; fi
            alias="bonsai2-$BONSAI_VARIANT"
            vision_args=()
            case "''${BONSAI_VISION:-1}" in
              1) if ${pkgs.python3}/bin/python3 -c 'import json,sys; sys.exit(not json.load(open(sys.argv[1]))[sys.argv[2]]["vision"])' ${./nix/variants.json} "$BONSAI_VARIANT"; then
                   vision_args=(--mmproj ${models.vision})
                 fi ;;
              0) ;;
              *) echo 'BONSAI_VISION must be 0 or 1' >&2; exit 2 ;;
            esac
            exec ${runtimeMtp}/bin/llama-server \
              --model "$model" --alias "$alias" \
              "''${vision_args[@]}" \
              --host 127.0.0.1 --port "''${BONSAI_PORT:-28743}" \
              --cors-origins "http://127.0.0.1:''${BONSAI_PORT:-28743},http://localhost:''${BONSAI_PORT:-28743}" \
              --ctx-size "''${BONSAI_CTX:-131072}" --parallel 1 \
              --cache-type-k "''${BONSAI_KV_TYPE:-q8_0}" \
              --cache-type-v "''${BONSAI_KV_TYPE:-q8_0}" \
              --batch-size 1024 --ubatch-size 128 \
              --device ROCm0 --n-gpu-layers 99 --flash-attn on --jinja \
              --reasoning-format deepseek \
              --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0 \
              --repeat-penalty 1.0 --image-max-tokens "''${BONSAI_IMAGE_MAX_TOKENS:-1024}" \
              "''${variant_args[@]}" "$@"
          '';
        };
      server = mkServer false;
      serverWithPtq1 = mkServer true;
      mkLauncher =
        backend:
        pkgs.runCommand "pi-bonsai2"
          {
            meta = {
              description = "Standalone Pi with local Bonsai 2 text and image input on AMD";
              homepage = "https://github.com/nyrda/pi-bonsai2";
              license = pkgs.lib.licenses.mit;
              platforms = [ system ];
              mainProgram = "pi-bonsai2";
            };
          }
          ''
            mkdir -p $out/bin $out/share/pi-bonsai2
            ln -s ${pkgs.pi-coding-agent}/lib/node_modules/pi-monorepo/node_modules $out/share/pi-bonsai2/node_modules
            cp ${./pi/provider.ts} $out/share/pi-bonsai2/provider.ts
            cp ${./nix/variants.json} $out/share/pi-bonsai2/variants.json
            cp ${./pi/speed.ts} $out/share/pi-bonsai2/speed.ts
            substitute ${./scripts/pi-bonsai2.py} $out/bin/pi-bonsai2 \
              --replace-fail '@python@' '${pkgs.python3}/bin/python3' \
              --replace-fail '@server@' '${backend}/bin/bonsai2-server' \
              --replace-fail '@pi@' '${pkgs.pi-coding-agent}/bin/pi' \
              --replace-fail '@registry@' '${./nix/variants.json}' \
              --replace-fail '@extension@' "$out/share/pi-bonsai2/provider.ts"
            chmod +x $out/bin/pi-bonsai2
            ln -s ${backend}/bin/bonsai2-server $out/bin/bonsai2-server
          '';
      launcher = mkLauncher server;
      launcherWithPtq1 = mkLauncher serverWithPtq1;
      mkValidate =
        backend: client: variant:
        pkgs.writeShellApplication {
          name = "bonsai2-validate";
          text = ''
            exec ${pkgs.python3}/bin/python3 ${./scripts/validate.py} \
              --server ${backend}/bin/bonsai2-server \
              --registry ${./nix/variants.json} \
              --pi ${client}/bin/pi-bonsai2 --variant ${variant} "$@"
          '';
        };
      validate = mkValidate server launcher "abliterated-mtp";
      validateBoth = mkValidate serverWithPtq1 launcherWithPtq1 "both";
    in
    {
      formatter.${system} = pkgs.nixfmt;
      devShells.${system}.default = pkgs.mkShellNoCC {
        packages = [
          pkgs.python3
          pkgs.ruff
          pkgs.nixfmt
        ];
      };
      packages.${system} = {
        default = launcher;
        pi-bonsai2 = launcher;
        pi-bonsai2-with-ptq1 = launcherWithPtq1;
        bonsai2-server = server;
        bonsai2-server-with-ptq1 = serverWithPtq1;
        llama-cpp-prism = runtimeMtp;
        llama-cpp-prism-prebuilt = runtime;
        llama-cpp-prism-mtp = runtimeMtp;
        model-pq2 = models.pq2;
        model-ptq1 = models.ptq1;
        model-vision = models.vision;
        model-abliterated-mtp = models.abliterated-mtp;
        model-abliterated-pq2 = models.abliterated-pq2;
        bonsai2-validate = validate;
        bonsai2-validate-both = validateBoth;
      };
      apps.${system} = {
        default = self.apps.${system}.pi-bonsai2;
        pi-bonsai2 = {
          type = "app";
          program = "${launcher}/bin/pi-bonsai2";
          meta.description = "Standalone Pi with local Bonsai 2 text and image input";
        };
        server = {
          type = "app";
          program = "${server}/bin/bonsai2-server";
          meta.description = "Bonsai 2 OpenAI-compatible server on AMD ROCm";
        };
        pi-bonsai2-with-ptq1 = {
          type = "app";
          program = "${launcherWithPtq1}/bin/pi-bonsai2";
          meta.description = "Opt-in Pi package including MTP and PTQ1 weights";
        };
        server-with-ptq1 = {
          type = "app";
          program = "${serverWithPtq1}/bin/bonsai2-server";
          meta.description = "Opt-in backend including MTP and PTQ1 weights";
        };
        validate = {
          type = "app";
          program = "${validate}/bin/bonsai2-validate";
          meta.description = "Validate the default MTP model with real GPU inference and Pi";
        };
        validate-both = {
          type = "app";
          program = "${validateBoth}/bin/bonsai2-validate";
          meta.description = "Opt-in validation of both Bonsai 2 formats";
        };
      };
      checks.${system} = {
        speed = pkgs.runCommand "bonsai2-speed-tests" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
          cp -r ${./pi} pi
          cp -r ${./tests} tests
          chmod u+w pi
          cp ${./nix/variants.json} pi/variants.json
          node --experimental-strip-types --test tests/*.test.ts
          touch $out
        '';
        launcher =
          pkgs.runCommand "bonsai2-launcher-tests"
            {
              nativeBuildInputs = [ pkgs.python3 ];
            }
            ''
              cp -r ${./scripts} scripts
              cp -r ${./tests} tests
              cp -r ${./nix} nix
              python -m unittest discover -s tests -v
              touch $out
            '';
      };
    };
}
