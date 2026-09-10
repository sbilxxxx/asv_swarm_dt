#!/usr/bin/env bash
set -eu
R=/home/ben_ben/automata2/asv_swarm_dt
D=/home/ben_ben/migration
S=$(date +%Y%m%d)
tar -C "$R" -cf - submission/measurements | zstd -12 -T16 -q -o "$D/asv-measurements-$S.tar.zst"
tar -C "$R" -cf - logs                    | zstd -12 -T16 -q -o "$D/asv-logs-$S.tar.zst"
tar -C /home/ben_ben/.local/share -cf - gpujobs | zstd -12 -T16 -q -o "$D/gpujob-records-$S.tar.zst"
cd "$D" && sha256sum *.tar.zst > SHA256SUMS
echo "DONE"; ls -la "$D"
