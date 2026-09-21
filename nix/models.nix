{ fetchurl }:
let
  registry = builtins.fromJSON (builtins.readFile ./variants.json);
  weights = builtins.mapAttrs (
    _: entry:
    fetchurl {
      url = "https://huggingface.co/${entry.repo}/resolve/${entry.revision}/${entry.filename}";
      inherit (entry) sha256;
    }
  ) registry;
in
weights
// {
  vision = fetchurl {
    url = "https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/6ed5e12bf84b7a63069882c91dd9e9218647d17b/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf";
    sha256 = "6807ede61d570bb86ba34b756a0fa109edc33668604de867c6ea6d8f1d631903";
  };
}
