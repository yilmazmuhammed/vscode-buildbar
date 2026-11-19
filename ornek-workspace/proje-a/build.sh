#!/usr/bin/env bash
#
# proje-a: mimari x optimizasyon matrisi ile derleme.
#
#   ./build.sh --list-configs        gecerli konfigurasyonlari listeler
#   ./build.sh --config host-debug   tek bir konfigurasyonu derler
#   ./build.sh --clean               build/ dizinini temizler
#
# Her konfigurasyon .vscode/tasks.json icinde bir gorev olarak duruyor;
# BuildBar butonlari o listeden geliyor. --list-configs elle kullanim ve
# "shell command" tabanli task input'lari icin duruyor.

set -euo pipefail
cd "$(dirname "$0")"

# ad : derleyici : bayraklar
CONFIGS=(
  "host-debug   : cc                          : -O0 -g -Wall -Wextra"
  "host-release : cc                          : -O2 -DNDEBUG -Wall -Wextra"
  "arm-debug    : arm-linux-gnueabihf-gcc     : -O0 -g -Wall -Wextra"
  "arm-release  : arm-linux-gnueabihf-gcc     : -Os -DNDEBUG -Wall -Wextra"
)

trim() { printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }

list_configs() {
  local entry
  for entry in "${CONFIGS[@]}"; do
    trim "${entry%%:*}"
    echo
  done
}

lookup() {
  local want="$1" entry name
  for entry in "${CONFIGS[@]}"; do
    name="$(trim "${entry%%:*}")"
    if [[ "$name" == "$want" ]]; then
      printf '%s' "${entry#*:}"
      return 0
    fi
  done
  return 1
}

usage() {
  cat <<EOF
kullanim: $0 [--config <ad>] [--list-configs] [--clean]

gecerli konfigurasyonlar:
$(list_configs | sed 's/^/  /')
EOF
}

config=""
do_clean=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list-configs) list_configs; exit 0 ;;
    --config)
      [[ $# -ge 2 ]] || { echo "hata: --config bir deger bekliyor" >&2; exit 2; }
      config="$2"; shift 2 ;;
    --clean) do_clean=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "hata: bilinmeyen argüman '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ $do_clean -eq 1 ]]; then
  rm -rf build
  echo "build/ temizlendi"
  [[ -z "$config" ]] && exit 0
fi

if [[ -z "$config" ]]; then
  echo "hata: --config verilmedi" >&2
  usage >&2
  exit 2
fi

if ! spec="$(lookup "$config")"; then
  echo "hata: '$config' tanimli bir konfigurasyon degil" >&2
  usage >&2
  exit 2
fi

cc="$(trim "${spec%%:*}")"
flags="$(trim "${spec#*:}")"

if ! command -v "$cc" >/dev/null 2>&1; then
  echo "hata: derleyici bulunamadi: $cc" >&2
  echo "      (capraz derleyici kurulu degilse host-* konfigurasyonlarini deneyin)" >&2
  exit 127
fi

outdir="build/$config"
mkdir -p "$outdir"

echo "== $config"
echo "   derleyici : $cc"
echo "   bayraklar : $flags"

# shellcheck disable=SC2086
"$cc" $flags -Iinclude -o "$outdir/demo" src/main.c src/checksum.c

echo "   cikti     : $outdir/demo"
