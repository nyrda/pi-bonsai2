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
  version = "prism-b10709-9a9394a";
  src = fetchurl {
    url = "https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b10709-9a9394a/llama-prism-b10709-9a9394a-bin-ubuntu-rocm-7.2-x64.tar.gz";
    sha256 = "230f879d538bb9f794d25c908bc8c0f676774c41c3e70ea719131c86d899841d";
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
