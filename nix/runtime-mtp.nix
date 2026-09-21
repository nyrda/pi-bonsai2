{
  stdenv,
  fetchurl,
  cmake,
  ninja,
  pkg-config,
  openssl,
  rocmPackages,
  gpuTargets ? [ "gfx1100" ],
  buildJobs ? 2,
}:
stdenv.mkDerivation {
  pname = "llama-cpp-prism-rocm-mtp";
  version = "prism-b10709-9a9394a-mtp";
  src = fetchurl {
    url = "https://github.com/PrismML-Eng/llama.cpp/archive/9a9394a895b96003ca842a6041cb28ac49a108f7.tar.gz";
    hash = "sha256-PtuRA+6VKsDWN+9UhJW3y9nOAcKbb51ic68zEU0pcv0=";
  };
  patches = [ ./patches/mtp-hadamard.patch ];
  nativeBuildInputs = [
    cmake
    ninja
    pkg-config
  ];
  buildInputs = [
    openssl
    rocmPackages.clr
    rocmPackages.hipblas
    rocmPackages.rocblas
  ];
  cmakeFlags = [
    "-DGGML_NATIVE=OFF"
    "-DGGML_HIP=ON"
    "-DCMAKE_HIP_COMPILER=${rocmPackages.clr.hipClangPath}/clang++"
    "-DCMAKE_HIP_ARCHITECTURES=${builtins.concatStringsSep ";" gpuTargets}"
    "-DLLAMA_BUILD_TESTS=OFF"
    "-DLLAMA_BUILD_EXAMPLES=OFF"
    "-DLLAMA_BUILD_SERVER=ON"
    "-DLLAMA_BUILD_TOOLS=ON"
    "-DLLAMA_BUILD_NUMBER=10709"
    "-DLLAMA_BUILD_COMMIT=9a9394a-mtp"
  ];
  # Keep compiler memory use bounded alongside a loaded model.
  enableParallelBuilding = true;
  buildPhase = "cmake --build . --target llama-server -j ${toString buildJobs}";
  installPhase = ''
    mkdir -p $out/bin $out/lib
    cp bin/llama-server $out/bin/
    cp -P bin/lib*.so* $out/lib/
    patchelf --set-rpath "$out/lib:$(patchelf --print-rpath $out/bin/llama-server)" $out/bin/llama-server
    for lib in $out/lib/*.so*; do
      if [ ! -L "$lib" ]; then
        patchelf --set-rpath "$out/lib:$(patchelf --print-rpath "$lib")" "$lib"
      fi
    done
  '';
}
