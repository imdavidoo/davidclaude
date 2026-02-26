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
if ! RESULT=$(/home/imdavid/.local/bin/claude \
  -p "$PROMPT" \
  --output-format json \
  --dangerously-skip-permissions \
  --model claude-opus-4-6 \
  2>/dev/null); then
  echo "[$(date -Iseconds)] ERROR: claude -p failed"
  exit 1
fi

# Extract session ID + report text, write pending.json
if ! SESSION_ID=$(echo "$RESULT" | python3 -c "
import sys, json
from datetime import datetime, timezone
result = json.load(sys.stdin)
data = {
    'session_id': result['session_id'],
    'timestamp': datetime.now(timezone.utc).isoformat(),
    'status': 'pending_review',
    'telegram_message_id': None,
    'report': result.get('result', ''),
}
with open('.sculptor/pending.json', 'w') as f:
    json.dump(data, f, indent=2)
print(result['session_id'])
" 2>/dev/null); then
  echo "[$(date -Iseconds)] ERROR: Failed to parse output"
  echo "$RESULT" | head -20
  exit 1
fi

echo "[$(date -Iseconds)] Analysis complete. Session: $SESSION_ID"
echo "[$(date -Iseconds)] Wrote .sculptor/pending.json — waiting for bot to send notification"
