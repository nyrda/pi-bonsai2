{
  lib,
  stdenv,
  fetchurl,
  autoPatchelfHook,
  makeWrapper,
  openssl,
  rocmPackages,
}:
stdenv.mkDerivation {
  pname = "llama-cpp-prism-rocm";
  version = "prism-b10777-e3de715";
  src = fetchurl {
    url = "https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b10777-e3de715/llama-prism-b10777-e3de715-bin-ubuntu-rocm-7.2-x64.tar.gz";
    sha256 = "228d484650073036bab3cedfe57374d6ad4237c86562c5f5ee7c638b654caf35";
  };
  nativeBuildInputs = [
    autoPatchelfHook
    makeWrapper
  ];
  buildInputs = [
    stdenv.cc.cc.lib
    openssl
    rocmPackages.clr
    rocmPackages.hipblas
    rocmPackages.rocblas
  ];
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    mkdir -p $out/libexec/prism $out/bin
    cp -a . $out/libexec/prism/
    for executable in llama-server llama-cli llama-bench; do
      makeWrapper $out/libexec/prism/$executable $out/bin/$executable \
        --prefix LD_LIBRARY_PATH : $out/libexec/prism
    done
    runHook postInstall
  '';
  meta = {
    description = "PrismML llama.cpp with Bonsai 2 ternary kernels and AMD HIP acceleration";
    homepage = "https://github.com/PrismML-Eng/llama.cpp";
    license = lib.licenses.mit;
    platforms = [ "x86_64-linux" ];
    mainProgram = "llama-server";
  };
}
