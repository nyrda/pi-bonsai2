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
  version = "prism-b10777-e3de715";
  src = fetchurl {
    url = "https://github.com/PrismML-Eng/llama.cpp/archive/e3de715222b2667c54a267441159a5729f11155e.tar.gz";
    hash = "sha256-4Nvl/ekWoVqTzxH+ZGezIL8jtrYPynctPBNv34gP2nA=";
  };
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
    "-DLLAMA_BUILD_NUMBER=10777"
    "-DLLAMA_BUILD_COMMIT=e3de715"
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
