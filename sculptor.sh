#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Load environment
set -a
source .env
source telegram-bot/.env
set +a

# Ensure .sculptor directory exists
mkdir -p .sculptor

# Read the sculptor prompt
PROMPT=$(cat sculptor-prompt.md)

# Unset CLAUDECODE to avoid nested-session error
unset CLAUDECODE 2>/dev/null || true

echo "[$(date -Iseconds)] Starting KB Sculptor analysis..."

# Run Claude Code in print mode with JSON output
RESULT=$(/home/imdavid/.local/bin/claude \
  -p "$PROMPT" \
  --output-format json \
  --dangerously-skip-permissions \
  --model claude-opus-4-6 \
  2>/dev/null)

# Extract session ID and result from JSON output
SESSION_ID=$(echo "$RESULT" | python3 -c "import sys, json; print(json.load(sys.stdin)['session_id'])")

echo "[$(date -Iseconds)] Analysis complete. Session: $SESSION_ID"

# Write pending.json for the bot to pick up
python3 -c "
import json, sys
from datetime import datetime, timezone
data = {
    'session_id': sys.argv[1],
    'timestamp': datetime.now(timezone.utc).isoformat(),
    'status': 'pending_review',
    'telegram_message_id': None
}
with open('.sculptor/pending.json', 'w') as f:
    json.dump(data, f, indent=2)
" "$SESSION_ID"

echo "[$(date -Iseconds)] Wrote .sculptor/pending.json — waiting for bot to send notification"
