#!/usr/bin/env bash
#
# run_analysis.sh — Analyze test scenario results via pi
#
# Usage:
#   ./run_analysis.sh [output_dir]
#
# If output_dir is not specified, finds the most recent run-XXX/ directory
# under docs/artifacts/test-outputs/.
#
set -euo pipefail

# ── Resolve project root (cd first so all paths are relative to project) ──────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

# ── Resolve output directory ──────────────────────────────────────────────────
if [[ $# -ge 1 ]]; then
    OUTPUT_DIR="$1"
    if [[ ! -d "$OUTPUT_DIR" ]]; then
        echo "ERROR: Directory not found: $OUTPUT_DIR" >&2
        exit 1
    fi
else
    OUTPUT_DIR="$(find docs/artifacts/test-outputs -maxdepth 1 -type d -name 'run-[0-9]*' | sort | tail -n1)"
    if [[ -z "$OUTPUT_DIR" ]]; then
        echo "ERROR: No run-XXX directory found under docs/artifacts/test-outputs/" >&2
        exit 1
    fi
fi
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"

# ── Extract run number from directory name ────────────────────────────────────
RUN_NUMBER="$(basename "$OUTPUT_DIR" | sed 's/^run-//')"

# ── Expected files ────────────────────────────────────────────────────────────
ON_JSONL="$OUTPUT_DIR/slots-on-session.jsonl"
OFF_JSONL="$OUTPUT_DIR/slots-off-session.jsonl"
LOG_FILE="$OUTPUT_DIR/pi-llama-slots.log"

# ── Validate required files ──────────────────────────────────────────────────
errors=0

for f in "$ON_JSONL" "$OFF_JSONL"; do
    if [[ ! -f "$f" ]]; then
        echo "ERROR: Required file not found: $f" >&2
        errors=$((errors + 1))
    fi
done

if [[ ! -f "$LOG_FILE" ]]; then
    LOG_FILE_MISSING=1
else
    LOG_FILE_MISSING=0
fi

if [[ $errors -gt 0 ]]; then
    echo "" >&2
    echo "ERROR: Missing required files. Aborting." >&2
    exit 1
fi

# ── Run the analysis script ──────────────────────────────────────────────────
ANALYSIS_RAW="$OUTPUT_DIR/analysis_raw_output.txt"

echo "Running analysis script..."
echo "  $ON_JSONL"
echo "  $OFF_JSONL"
echo ""

python3 docs/artifacts/analyze_turn_gaps.py "$ON_JSONL" "$OFF_JSONL" > "$ANALYSIS_RAW" 2>&1

echo "──────────────────────────────────────────────────────────────────────────────"
cat "$ANALYSIS_RAW"
echo "──────────────────────────────────────────────────────────────────────────────"
echo ""

# ── Prepare artifacts for pi ─────────────────────────────────────────────────
# Build list of @file arguments for pi (absolute paths)
PI_ARGS=()
PI_ARGS+=("@$(realpath "$ON_JSONL")")
PI_ARGS+=("@$(realpath "$OFF_JSONL")")

if [[ $LOG_FILE_MISSING -eq 0 ]]; then
    PI_ARGS+=("@$(realpath "$LOG_FILE")")
fi

# ── Prepare the prompt message ────────────────────────────────────────────────
# The analysis output is embedded inline so pi has full context.
# The JSONL files are passed via @ for pi to read if needed.
ANALYSIS_TEXT="$(cat "$ANALYSIS_RAW")"

LOG_NOTE=""
if [[ $LOG_FILE_MISSING -eq 1 ]]; then
    LOG_NOTE="  - Extension log not present (slots-off log not expected, slots-on log may be in output_dir)"
else
    LOG_NOTE="  - Extension log: $(realpath "$LOG_FILE")"
fi

PROMPT="Analyze these test scenario results for the pi-llama-slots extension.

Context:
  - Slots ON session JSONL: $(realpath "$ON_JSONL")
  - Slots OFF session JSONL: $(realpath "$OFF_JSONL")
${LOG_NOTE}
  - Analysis script output: see below

Analysis output from analyze_turn_gaps.py:
---
${ANALYSIS_TEXT}
---

Based on the analysis output, produce a comprehensive analysis document that includes:
- Executive summary: does slot save/restore provide measurable benefit?
- Prefill time comparison: avg/min/max with delta
- Consistency analysis: variance comparison between ON and OFF
- Outlier analysis: any anomalous values
- Extension log findings: key events from the slot save/restore log (if available)
- Conclusion: is the extension effective at the tested hardware/context scale?

Save the output as a markdown document to: docs/artifacts/analysis-${RUN_NUMBER}-results.md
"

# ── Invoke pi in print mode ──────────────────────────────────────────────────
OUTPUT_MD="docs/artifacts/analysis-${RUN_NUMBER}-results.md"

echo "Invoking pi to generate analysis document..."
echo "  Output: $OUTPUT_MD"
echo "  Args:   ${PI_ARGS[*]}"
echo "  Prompt: ${#PROMPT} chars"
echo ""

# Invoke pi in print mode (-p = non-interactive, single-turn).
# Tools remain enabled so pi can use the write tool to save the doc.
# stdout goes to terminal; stderr goes to terminal for debugging.
# The write tool creates the file internally.
pi -p \
    --system-prompt "You are a senior technical data analyst. Analyze test results and produce structured, data-driven markdown reports. Be precise, quantify findings, note uncertainties, and avoid speculation. Always save your output document to the specified path using the write tool." \
    "${PI_ARGS[@]}" \
    "$PROMPT"

echo ""
if [[ -f "$OUTPUT_MD" ]]; then
    echo "Analysis document saved to: $OUTPUT_MD"
else
    echo "WARNING: Output file not created. Check pi output above for errors." >&2
fi
echo ""

# ── Print summary of findings ────────────────────────────────────────────────
echo "═══ Quick Summary ═══"

# Extract key metrics from the analysis output
if grep -q "Avg Slots ON" "$ANALYSIS_RAW" || grep -q "Avg Delta" "$ANALYSIS_RAW"; then
    echo "Prefill time comparison (from analysis script):"
    grep -E "^(    (Avg Slots|Avg Delta|Delta:))" "$ANALYSIS_RAW" | sed 's/^/  /' then
    echo "Prefill time comparison (from analysis script):"
    grep -E "(Avg Slots|Avg Delta)" "$ANALYSIS_RAW" | sed 's/^/  /'
else
    echo "(No structured metrics found in analysis output)"
fi

echo ""
echo "  Full document: docs/artifacts/analysis-${RUN_NUMBER}-results.md"
echo "  Raw output:    $ANALYSIS_RAW"
