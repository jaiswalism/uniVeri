#!/bin/bash
# ==============================================================================
# setup-netem.sh: Network Emulation (tc netem) for uniVeri Testbed
# ==============================================================================

DELAY_MS=${1:-20}
JITTER_MS=${2:-5}
CORRELATION=${3:-25}

echo "[NetEm] Configuring kernel link delay across testbed bridge..."
echo "  Target Delay: ${DELAY_MS}ms ± ${JITTER_MS}ms (${CORRELATION}% distribution)"

# Discover Docker bridge interface for testbed-net
BRIDGE_IF=$(ip link show | grep -B 1 "172.28.0.1" | head -n 1 | awk -F': ' '{print $2}' | cut -d'@' -f1)

if [ -z "$BRIDGE_IF" ]; then
  # Fallback to scanning docker bridge interfaces
  BRIDGE_IF=$(brctl show 2>/dev/null | awk 'NR>1 {print $1}' | grep -v '^$' | head -n 1)
fi

if [ -z "$BRIDGE_IF" ]; then
  echo "[NetEm] Warning: Could not automatically detect bridge interface. Trying default docker0..."
  BRIDGE_IF="docker0"
fi

echo "[NetEm] Applying tc netem on interface: ${BRIDGE_IF}"

# Clear existing qdisc
sudo tc qdisc del dev "${BRIDGE_IF}" root 2>/dev/null || true

# Apply netem delay
sudo tc qdisc add dev "${BRIDGE_IF}" root netem delay "${DELAY_MS}ms" "${JITTER_MS}ms" "${CORRELATION}%"

echo "[NetEm] Successfully configured:"
sudo tc qdisc show dev "${BRIDGE_IF}"

