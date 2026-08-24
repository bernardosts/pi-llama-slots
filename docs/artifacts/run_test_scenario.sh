#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# run_test_scenario.sh — Automate the slot prefill time comparison test
#
# Runs the test scenario from TEST_SCENARIO.md twice:
#   1. Slots ON  (PI_LLAMA_SLOT_PAGING_DISABLED=0)
#   2. Slots OFF (PI_LLAMA_SLOT_PAGING_DISABLED=1)
#
# Usage:
#   ./run_test_scenario.sh [run_number]
#
# Example:
#   ./run_test_scenario.sh run-004
#   ./run_test_scenario.sh            # defaults to run-003
###############################################################################

# --- Arguments ---------------------------------------------------------------
RUN_NUMBER="${1:-run-003}"

# --- Paths -------------------------------------------------------------------
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && cd .. && pwd)"
OUTPUT_DIR="${PROJECT_ROOT}/docs/artifacts/test-outputs"
RUN_DIR="${OUTPUT_DIR}/${RUN_NUMBER}"
SESSIONS_DIR="$HOME/.pi/agent/sessions/--home-bernardo-Projetos-Outros-pi-llama-slots--"
LOG_FILE="${PROJECT_ROOT}/pi-llama-slots.log"
TEST_SCENARIO="${PROJECT_ROOT}/docs/artifacts/TEST_SCENARIO.md"

# --- Helpers -----------------------------------------------------------------

# Find the most recently modified .jsonl file in the sessions directory.
# Prints the full path to the newest JSONL file.
# Args:
#   $1 - path to the sessions directory
find_latest_session() {
    local sessions_dir="$1"
    local latest
    latest=$(find "$sessions_dir" -maxdepth 1 -name '*.jsonl' -type f -printf '%T@ %p\n' 2>/dev/null \
             | sort -rn | head -1 | cut -d' ' -f2-)
    if [[ -n "$latest" && -f "$latest" ]]; then
        echo "$latest"
    else
        echo ""
    fi
}

# Print a separator line.
separator() {
    echo ""
    echo "======================================================================="
}

# --- Pre-flight checks -------------------------------------------------------

separator
echo "=== Test Scenario Runner ==="
echo "Run number : ${RUN_NUMBER}"
echo "Project    : ${PROJECT_ROOT}"
echo "Output dir : ${RUN_DIR}"
echo ""

# Ensure we run from the project root
cd "${PROJECT_ROOT}"

# Create output directory (including parent dirs)
mkdir -p "${RUN_DIR}"
echo "[OK] Output directory created: ${RUN_DIR}"

# Verify the test scenario file exists
if [[ ! -f "${TEST_SCENARIO}" ]]; then
    echo "[ERROR] Test scenario not found: ${TEST_SCENARIO}"
    exit 1
fi
echo "[OK] Test scenario found: ${TEST_SCENARIO}"

# Verify the sessions directory exists (pi must have been started at least once)
if [[ ! -d "${SESSIONS_DIR}" ]]; then
    echo "[WARN] Sessions directory not found: ${SESSIONS_DIR}"
    echo "       It will be created when pi starts the first session."
fi

echo ""
echo "Session storage: ${SESSIONS_DIR}"
echo ""

# --- Slots ON run ------------------------------------------------------------
separator
echo ">>> PHASE 1: SLOTS ON (PI_LLAMA_SLOT_PAGING_DISABLED=0)"
separator
echo ""

# Remove any existing log file before starting (clean slate)
rm -f "${LOG_FILE}"
echo "[OK] Previous log file removed (clean start)"

# Get a snapshot of existing session files before the run (to detect new ones)
# This helps us identify which session belongs to this run.
EXISTING_ON=()
if [[ -d "${SESSIONS_DIR}" ]]; then
    while IFS= read -r f; do
        EXISTING_ON+=("$f")
    done < <(find "$SESSIONS_DIR" -maxdepth 1 -name '*.jsonl' -type f 2>/dev/null | sort)
fi

# Run pi with slots enabled and debug logging active.
# PI_LLAMA_SLOT_PAGING_LOGGING=1 ensures the extension logs slot save/restore events.
# The scenario file is passed via @-prefix so pi reads it as instructions.
# The appended command asks pi to export the session JSONL upon completion.
echo "Starting slots ON session..."
echo "  PI_LLAMA_SLOT_PAGING_DISABLED=0  (slots enabled)"
echo "  PI_LLAMA_SLOT_PAGING_LOGGING=1   (debug logging enabled)"
echo ""

# Use a subshell with explicit environment variables.
# The command is run from the project root directory.
(
    export PI_LLAMA_SLOT_PAGING_DISABLED=0
    export PI_LLAMA_SLOT_PAGING_LOGGING=1
    exec pi -p "@${TEST_SCENARIO}" "Run this test scenario. Export the session to ${RUN_DIR}/slots-on-session.jsonl when done."
)
echo ""
echo "[OK] Slots ON session completed."

# Wait a moment for pi to finish writing the session file
sleep 2

# Try to find the session exported by /export first, then fall back to the newest auto-saved one.
ON_SESSION=""

# Method 1: Check the exact export path (pi /export may write directly there)
if [[ -f "${RUN_DIR}/slots-on-session.jsonl" ]]; then
    ON_SESSION="${RUN_DIR}/slots-on-session.jsonl"
    echo "[OK] Session found at export path: ${ON_SESSION}"
else
    # Method 2: Find the most recently modified JSONL in the sessions dir
    # that is NEWER than anything we saw before this run.
    LATEST_SESSION=""
    LATEST_TIME=0

    if [[ -d "${SESSIONS_DIR}" ]]; then
        while IFS= read -r f; do
            if [[ -z "$f" ]]; then continue; fi
            # Check if this is a new file (not in the pre-run snapshot)
            is_new=true
            for existing in "${EXISTING_ON[@]+"${EXISTING_ON[@]}"}"; do
                if [[ "$f" == "$existing" ]]; then
                    is_new=false
                    break
                fi
            done
            if $is_new; then
                # Use mtime to pick the newest new file
                file_mtime=$(stat -c %Y "$f" 2>/dev/null || echo 0)
                if (( file_mtime > LATEST_TIME )); then
                    LATEST_TIME=$file_mtime
                    LATEST_SESSION="$f"
                fi
            fi
        done < <(find "$SESSIONS_DIR" -maxdepth 1 -name '*.jsonl' -type f 2>/dev/null)
    fi

    if [[ -n "${LATEST_SESSION}" ]]; then
        # Copy to output dir with the canonical name
        cp "$LATEST_SESSION" "${RUN_DIR}/slots-on-session.jsonl"
        ON_SESSION="${RUN_DIR}/slots-on-session.jsonl"
        echo "[OK] Session copied from auto-save: $(basename "$LATEST_SESSION") → ${ON_SESSION}"
    else
        # Fallback: just take the absolute newest JSONL in the sessions dir
        FALLBACK=$(find_latest_session "${SESSIONS_DIR}")
        if [[ -n "${FALLBACK}" ]]; then
            cp "$FALLBACK" "${RUN_DIR}/slots-on-session.jsonl"
            ON_SESSION="${RUN_DIR}/slots-on-session.jsonl"
            echo "[WARN] No new session detected, using latest: $(basename "$FALLBACK") → ${ON_SESSION}"
        else
            echo "[ERROR] No session JSONL found for slots ON run."
        fi
    fi
fi

# Copy the log file (only useful for ON runs where logging is enabled)
if [[ -f "${LOG_FILE}" ]]; then
    cp "${LOG_FILE}" "${RUN_DIR}/pi-llama-slots.log"
    LOG_SIZE=$(du -h "${RUN_DIR}/pi-llama-slots.log" | cut -f1)
    echo "[OK] Log file copied: pi-llama-slots.log (${LOG_SIZE})"
else
    echo "[WARN] No log file found at ${LOG_FILE}"
fi

# Verify we got a session file
if [[ -z "${ON_SESSION}" ]] || [[ ! -f "${ON_SESSION}" ]]; then
    echo "[ERROR] Slots ON session JSONL was not produced. Aborting."
    exit 1
fi
echo "[OK] Slots ON session verified: $(wc -l < "${ON_SESSION}") lines"

# --- Slots OFF run -----------------------------------------------------------
separator
echo ">>> PHASE 2: SLOTS OFF (PI_LLAMA_SLOT_PAGING_DISABLED=1)"
separator
echo ""

# No need to remove the log file — we want to keep the ON run's log for reference.
# Slots OFF will append to the same log, but that's fine.

# Get a snapshot of existing session files before this run.
EXISTING_OFF=()
if [[ -d "${SESSIONS_DIR}" ]]; then
    while IFS= read -r f; do
        EXISTING_OFF+=("$f")
    done < <(find "$SESSIONS_DIR" -maxdepth 1 -name '*.jsonl' -type f 2>/dev/null | sort)
fi

echo "Starting slots OFF session..."
echo "  PI_LLAMA_SLOT_PAGING_DISABLED=1  (slots disabled)"
echo ""

(
    export PI_LLAMA_SLOT_PAGING_DISABLED=1
    # Do NOT set PI_LLAMA_SLOT_PAGING_LOGGING — not needed for OFF runs
    exec pi -p "@${TEST_SCENARIO}" "Run this test scenario. Export the session to ${RUN_DIR}/slots-off-session.jsonl when done."
)
echo ""
echo "[OK] Slots OFF session completed."

# Same discovery logic as ON run
sleep 2

OFF_SESSION=""

if [[ -f "${RUN_DIR}/slots-off-session.jsonl" ]]; then
    OFF_SESSION="${RUN_DIR}/slots-off-session.jsonl"
    echo "[OK] Session found at export path: ${OFF_SESSION}"
else
    LATEST_SESSION=""
    LATEST_TIME=0

    if [[ -d "${SESSIONS_DIR}" ]]; then
        while IFS= read -r f; do
            if [[ -z "$f" ]]; then continue; fi
            is_new=true
            for existing in "${EXISTING_OFF[@]+"${EXISTING_OFF[@]}"}"; do
                if [[ "$f" == "$existing" ]]; then
                    is_new=false
                    break
                fi
            done
            if $is_new; then
                file_mtime=$(stat -c %Y "$f" 2>/dev/null || echo 0)
                if (( file_mtime > LATEST_TIME )); then
                    LATEST_TIME=$file_mtime
                    LATEST_SESSION="$f"
                fi
            fi
        done < <(find "$SESSIONS_DIR" -maxdepth 1 -name '*.jsonl' -type f 2>/dev/null)
    fi

    if [[ -n "${LATEST_SESSION}" ]]; then
        cp "$LATEST_SESSION" "${RUN_DIR}/slots-off-session.jsonl"
        OFF_SESSION="${RUN_DIR}/slots-off-session.jsonl"
        echo "[OK] Session copied from auto-save: $(basename "$LATEST_SESSION") → ${OFF_SESSION}"
    else
        FALLBACK=$(find_latest_session "${SESSIONS_DIR}")
        if [[ -n "${FALLBACK}" ]]; then
            cp "$FALLBACK" "${RUN_DIR}/slots-off-session.jsonl"
            OFF_SESSION="${RUN_DIR}/slots-off-session.jsonl"
            echo "[WARN] No new session detected, using latest: $(basename "$FALLBACK") → ${OFF_SESSION}"
        else
            echo "[ERROR] No session JSONL found for slots OFF run."
        fi
    fi
fi

# Verify we got a session file
if [[ -z "${OFF_SESSION}" ]] || [[ ! -f "${OFF_SESSION}" ]]; then
    echo "[ERROR] Slots OFF session JSONL was not produced."
    exit 1
fi
echo "[OK] Slots OFF session verified: $(wc -l < "${OFF_SESSION}") lines"

# --- Summary -----------------------------------------------------------------
separator
echo "=== Test Run Complete ==="
separator
echo ""
echo "Output directory: ${RUN_DIR}/"
echo "Files produced:"
echo ""

# List what's in the output dir
ls -lh "${RUN_DIR}/" 2>/dev/null | awk 'NR>1 {printf "  - %-40s %s\n", $NF, $5}'

echo ""

# --- Auto-run analysis if both artifacts are present ---
separator
echo "=== Auto-Analysis ==="
separator
echo ""

ON_PATH="${RUN_DIR}/slots-on-session.jsonl"
OFF_PATH="${RUN_DIR}/slots-off-session.jsonl"
ANALYZER="${PROJECT_ROOT}/docs/artifacts/analyze_turn_gaps.py"

if [[ -f "${ON_PATH}" ]] && [[ -f "${OFF_PATH}" ]] && [[ -f "${ANALYZER}" ]]; then
    echo "Both session files and analyzer script found. Running analysis..."
    echo ""

    python3 "${ANALYZER}" "${ON_PATH}" "${OFF_PATH}" || echo "[WARN] Analysis script exited with errors."
    echo ""
    echo "[OK] Analysis complete. Output above."
else
    echo "[WARN] Cannot run auto-analysis:"
    [[ ! -f "${ON_PATH}" ]] && echo "  - Missing: ${ON_PATH}"
    [[ ! -f "${OFF_PATH}" ]] && echo "  - Missing: ${OFF_PATH}"
    [[ ! -f "${ANALYZER}" ]] && echo "  - Missing: ${ANALYZER}"
    echo ""
    echo "Run manually:"
    echo "  python3 docs/artifacts/analyze_turn_gaps.py <on.jsonl> <off.jsonl>"
fi
echo ""
separator

