#!/usr/bin/env python3
"""
Parse Pi session JSONL files and extract per-turn metrics as CSV.

Extracts from each `message` event line:
  - timestamp, direction, token usage (input/output/cacheRead/cacheWrite/reasoning/total),
    stopReason, rawStopReason, contentTypes (comma-joined), toolCallIds (comma-joined)

Usage:
    python3 parse_session.py <path-to-jsonl> [--output output.csv]

If --output is omitted, writes to <input-stem>-metrics.csv.
"""

import csv
import json
import sys
from pathlib import Path
from datetime import datetime, timezone


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def iso_to_str(ts):
    """Convert ISO 8601 or epoch-ms timestamp to a readable string."""
    if isinstance(ts, (int, float)):
        dt = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
        return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"
    # Already ISO string — normalize
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def direction_for_role(role):
    """Map message role to a human-readable direction label."""
    mapping = {
        "user": "sent-to-llm",
        "assistant": "received-from-llm",
        "toolResult": "tool-result",
    }
    return mapping.get(role, role)


def extract_tool_call_ids(message):
    """Extract tool call IDs from a message.

    - Assistant: collect `id` from all content items with type == "toolCall"
    - ToolResult: use the `toolCallId` field, appended with tool name in parens
    - User: empty
    """
    role = message.get("role", "")

    if role == "assistant":
        ids = []
        for c in message.get("content", []):
            if isinstance(c, dict) and c.get("type") == "toolCall":
                ids.append(c["id"])
        return ",".join(ids)

    if role == "toolResult":
        tc_id = message.get("toolCallId", "")
        tool_name = message.get("toolName", "")
        if tc_id and tool_name:
            return f"{tc_id}({tool_name})"
        return tc_id if tc_id else ""

    return ""


def extract_content_types(message):
    """Extract and comma-join content types from a message's content array.

    For toolResult messages, appends the tool name in parens to the types
    (e.g. "text(bash)" instead of just "text").
    """
    role = message.get("role", "")
    types = []
    for c in message.get("content", []):
        if isinstance(c, dict):
            types.append(c.get("type", ""))

    if role == "toolResult":
        tool_name = message.get("toolName", "")
        if types and tool_name:
            types[-1] = f"{types[-1]}({tool_name})"

    return ",".join(types)


def extract_usage(message):
    """Extract token usage metrics (excluding cost) from an assistant message."""
    usage = message.get("usage", {})
    return {
        "input_tokens": usage.get("input", 0),
        "output_tokens": usage.get("output", 0),
        "cache_read_tokens": usage.get("cacheRead", 0),
        "cache_write_tokens": usage.get("cacheWrite", 0),
        "reasoning_tokens": usage.get("reasoning", 0),
        "total_tokens": usage.get("totalTokens", 0),
    }


# ---------------------------------------------------------------------------
# Core parser
# ---------------------------------------------------------------------------

def parse_session(filepath):
    """Parse a JSONL session file and return a list of metric dicts."""
    rows = []
    with open(filepath, "r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue

            try:
                evt = json.loads(line)
            except json.JSONDecodeError:
                print(f"  [WARN] Skipping malformed JSON on line {line_no}", file=sys.stderr)
                continue

            # Only process message events
            if evt.get("type") != "message":
                continue

            msg = evt.get("message", {})
            role = msg.get("role", "")

            row = {
                "line": line_no,
                "message_id": evt.get("id", ""),
                "parent_id": evt.get("parentId", ""),
                "timestamp": iso_to_str(evt.get("timestamp", "")),
                "direction": direction_for_role(role),
            }

            # Token usage (only meaningful on assistant messages)
            if role == "assistant":
                row.update(extract_usage(msg))
                row["stopReason"] = msg.get("stopReason", "")
                row["rawStopReason"] = msg.get("rawStopReason", "")
            else:
                row.update({
                    "input_tokens": "",
                    "output_tokens": "",
                    "cache_read_tokens": "",
                    "cache_write_tokens": "",
                    "reasoning_tokens": "",
                    "total_tokens": "",
                    "stopReason": "",
                    "rawStopReason": "",
                })

            # Content types and tool call IDs
            row["contentTypes"] = extract_content_types(msg)
            row["toolCallIds"] = extract_tool_call_ids(msg)

            rows.append(row)

    return rows


# ---------------------------------------------------------------------------
# CSV output
# ---------------------------------------------------------------------------

FIELDNAMES = [
    "line",
    "message_id",
    "parent_id",
    "timestamp",
    "direction",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
    "total_tokens",
    "stopReason",
    "rawStopReason",
    "contentTypes",
    "toolCallIds",
]


def write_csv(rows, output_path):
    """Write metric rows to a CSV file."""
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    args = sys.argv[1:]

    if "--help" in args or "-h" in args:
        print("Usage: python3 parse_session.py <path-to-jsonl> [--output output.csv]")
        print()
        print("Parses Pi session JSONL and extracts per-turn metrics as CSV.")
        print()
        print("Output columns:")
        print("  line, message_id, parent_id, timestamp, direction,")
        print("  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,")
        print("  reasoning_tokens, total_tokens, stopReason, rawStopReason,")
        print("  contentTypes, toolCallIds")
        print()
        print("Notes:")
        print("  - toolResult contentTypes show tool name: e.g. 'text(bash)'")
        print("  - toolResult toolCallIds show tool name: e.g. 'abc123(bash)'")
        sys.exit(0)

    if not args:
        print("Usage: python3 parse_session.py <path-to-jsonl> [--output output.csv]")
        print()
        print("Parses Pi session JSONL and extracts per-turn metrics as CSV.")
        print()
        print("Output columns:")
        print("  line, message_id, parent_id, timestamp, direction,")
        print("  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,")
        print("  reasoning_tokens, total_tokens, stopReason, rawStopReason,")
        print("  contentTypes, toolCallIds")
        print()
        print("Notes:")
        print("  - toolResult contentTypes show tool name: e.g. 'text(bash)'")
        print("  - toolResult toolCallIds show tool name: e.g. 'abc123(bash)'")
        sys.exit(1)

    # Parse --output flag
    output_path = None
    input_paths = []
    for i, arg in enumerate(args):
        if arg == "--output" and i + 1 < len(args):
            output_path = args[i + 1]
            # Skip the next arg since it's the output path
            args = args[:i] + args[i + 2:]
            break

    input_paths = args

    for filepath in input_paths:
        print(f"Parsing {filepath} ...")
        rows = parse_session(filepath)
        print(f"  Found {len(rows)} message events")

        if output_path is None:
            out = Path(filepath).with_suffix(".csv")
        else:
            out = Path(output_path) if len(input_paths) == 1 else Path(
                str(Path(output_path).stem) + "-" + Path(filepath).stem + ".csv"
            )

        write_csv(rows, out)
        print(f"  Wrote {out}")

        # Quick summary
        directions = {}
        for r in rows:
            d = r["direction"]
            directions[d] = directions.get(d, 0) + 1

        print("  Direction breakdown:")
        for d, count in sorted(directions.items()):
            print(f"    {d:20s} {count}")

        assistant_rows = [r for r in rows if r["direction"] == "received-from-llm"]
        if assistant_rows:
            total_input = sum(r["input_tokens"] for r in assistant_rows)
            total_output = sum(r["output_tokens"] for r in assistant_rows)
            total_cache_read = sum(r["cache_read_tokens"] for r in assistant_rows)
            total_cache_write = sum(r["cache_write_tokens"] for r in assistant_rows)
            total_reasoning = sum(r["reasoning_tokens"] for r in assistant_rows)
            total_all = sum(r["total_tokens"] for r in assistant_rows)
            print(f"\n  Token totals (assistant messages):")
            print(f"    input:       {total_input:>12,}")
            print(f"    output:      {total_output:>12,}")
            print(f"    cache_read:  {total_cache_read:>12,}")
            print(f"    cache_write: {total_cache_write:>12,}")
            print(f"    reasoning:   {total_reasoning:>12,}")
            print(f"    total:       {total_all:>12,}")


if __name__ == "__main__":
    main()
