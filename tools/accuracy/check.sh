#!/bin/zsh
# The M9f accuracy test (docs/HANDOVER.md): a gateway of its own on 5191, on a copy of data/
# made without secrets.json (so it has no keys and downloads nothing), with each coin's older
# days switched on; the ruler against it; the gateway stopped after. The user's own gateway and
# data/ are only read.
set -e
REPO=${0:A:h:h:h}
COPY=$(mktemp -d)/data
mkdir -p $COPY
rsync -a --exclude secrets.json $REPO/data/ $COPY/
test ! -e $COPY/secrets.json
cd $REPO/apps/gateway
DATA_DIR=$COPY GATEWAY_PORT=5191 CRYPTOCAP_OLDER_COINS=1 LIVECOINWATCH_URL=http://127.0.0.1:9 \
  node src/main.ts > ${COPY:h}/gateway.log 2>&1 &
GATEWAY=$!
trap "kill $GATEWAY 2>/dev/null; rm -rf ${COPY:h}" EXIT
until curl -s -o /dev/null http://127.0.0.1:5191/api/older-caps; do sleep 1; done
python3 -I $REPO/tools/accuracy/total2_xrpusd.py http://127.0.0.1:5191 "$@"
