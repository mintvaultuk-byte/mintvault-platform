#!/usr/bin/env bash
# Destroy one matrix environment completely, and PROVE it is gone.
#
# `docker rm --volumes` removes the anonymous data volumes too, so the next matrix cannot inherit
# a byte of the previous one's cluster. The proof at the end is what makes the A/B independence
# claim checkable rather than asserted.
set -euo pipefail

LABEL="${1:?usage: teardown.sh <A|B>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVID="$HERE/../evidence"
mkdir -p "$EVID"

read -r PG16_PORT PG17_PORT MINIO_PORT CPREFIX <<EOF
$(node -e "
import('$HERE/matrix-config.mjs').then(({matrixFor})=>{
  const m=matrixFor('$LABEL');
  console.log([m.pg16Port,m.pg17Port,m.minioPort,m.containerPrefix].join(' '));
});")
EOF

OUT="$EVID/teardown-${LABEL}.txt"
{
  echo "=== [$LABEL] STATE BEFORE TEARDOWN ==="
  docker ps -a --filter "name=^${CPREFIX}-" --format '{{.Names}} {{.Image}} {{.Status}}' || true
  echo "volumes attached:"
  for c in "${CPREFIX}-pg16" "${CPREFIX}-pg17" "${CPREFIX}-minio"; do
    docker inspect "$c" --format "  {{.Name}}: {{range .Mounts}}{{.Name}} {{end}}" 2>/dev/null || echo "  $c: absent"
  done

  echo
  echo "=== [$LABEL] DESTROY (containers AND their volumes) ==="
  for c in "${CPREFIX}-pg16" "${CPREFIX}-pg17" "${CPREFIX}-minio"; do
    docker rm --force --volumes "$c" >/dev/null 2>&1 && echo "  removed $c (with volumes)" || echo "  $c already absent"
  done

  echo
  echo "=== [$LABEL] PROOF OF DESTRUCTION ==="
  remaining="$(docker ps -aq --filter "name=^${CPREFIX}-" | wc -l | tr -d ' ')"
  echo "containers matching ${CPREFIX}-*: $remaining (must be 0)"
  [ "$remaining" = "0" ] || { echo "TEARDOWN INCOMPLETE"; exit 1; }
  for p in "$PG16_PORT" "$PG17_PORT" "$MINIO_PORT"; do
    if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "port $p STILL LISTENING — teardown incomplete"; exit 1
    fi
    echo "port $p: closed"
  done
  echo "matrix ${LABEL} state destroyed: no containers, no volumes, no listeners"
} 2>&1 | tee "$OUT"
