{ fetchurl }:
let
  registry = builtins.fromJSON (builtins.readFile ./variants.json);
  fetch =
    entry:
    fetchurl {
      url = "https://huggingface.co/${entry.repo}/resolve/${entry.revision}/${entry.filename}";
      inherit (entry) sha256;
    };
in
builtins.mapAttrs (_: fetch) registry
// {
  # Vision projector shared by the 27B variants, including the default.
  vision = fetch registry.abliterated-mtp.mmproj;
}
