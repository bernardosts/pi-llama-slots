#!/usr/bin/env python3
"""
Analyze JSONL session logs for prefill time measurement.

Extracts the time between each subagent-completion tool_result and the
next assistant tool_call — this is the prefill/re-encode gap.

Auto-detects the tool name used for subagent dispatch:
  - "get_subagent_result" (original test pattern)
  - "Agent" (newer test pattern via direct Agent tool calls)

Usage:
    python3 analyze_turn_gaps.py <path-to-jsonl> [path2 ...] [--tool-name NAME]

Outputs a comparison table suitable for the TEST_SCENARIO.md metrics.
"""

import json
import sys
from datetime import datetime, timezone


def ts_to_ms(ts):
    """Convert ISO timestamp or epoch ms to milliseconds."""
    if isinstance(ts, (int, float)):
        return int(ts)
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return int(dt.timestamp() * 1000)


def auto_detect_tool_name(filepath):
    """Auto-detect which tool name is used for subagent completions in the file.
    
    Priority:
      1. "get_subagent_result" — canonical test pattern (always prefer if present)
      2. "Agent" — newer test pattern (direct Agent tool calls)
      3. "get_subagent_result" — fallback
    
    This ordering handles mixed runs where both patterns may appear.
    """
    has_subagent = False
    has_agent = False
    with open(filepath) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            evt = json.loads(line)
            msg = evt.get("message", {})
            if msg.get("role") == "toolResult":
                name = msg.get("toolName", "")
                if name == "get_subagent_result":
                    has_subagent = True
                elif name == "Agent":
                    has_agent = True
    
    if has_subagent:
        return "get_subagent_result"
    if has_agent:
        return "Agent"
    return "get_subagent_result"  # fallback


def analyze_file(filepath, tool_name=None):
    """Parse a single JSONL file and return prefill gaps.
    
    If tool_name is None, auto-detect from the file content.
    """
    with open(filepath) as f:
        lines = [l.strip() for l in f if l.strip()]

    if tool_name is None:
        tool_name = auto_detect_tool_name(filepath)

    # Build map: toolCallId -> tool name (from assistant messages)
    tool_call_names = {}
    for line in lines:
        evt = json.loads(line)
        if evt.get("type") == "message" and evt.get("message", {}).get("role") == "assistant":
            for c in evt.get("message", {}).get("content", []):
                if isinstance(c, dict) and c.get("type") == "toolCall":
                    tool_call_names[c["id"]] = c.get("name", "")

    # Collect all events with absolute timestamps
    events = []
    for line in lines:
        evt = json.loads(line)
        ts = ts_to_ms(evt["timestamp"])
        msg = evt.get("message", {})

        if evt.get("type") == "message":
            role = msg.get("role", "")
            if role == "toolResult":
                tc_id = msg.get("toolCallId", "")
                tool_name_resolved = tool_call_names.get(tc_id, "")
                events.append({"ts": ts, "type": "tool_result", "tool_name": tool_name_resolved})
            elif role == "assistant":
                for c in msg.get("content", []):
                    if isinstance(c, dict) and c.get("type") == "toolCall":
                        events.append({
                            "ts": ts,
                            "type": "assistant_call",
                            "tool_name": c.get("name", ""),
                        })

    # Find subagent completion events and measure gap to next assistant call
    gaps = []
    for i, evt in enumerate(events):
        if evt["type"] != "tool_result" or evt["tool_name"] != tool_name:
            continue

        # Find the next assistant tool_call after this
        for j in range(i + 1, len(events)):
            if events[j]["type"] == "assistant_call":
                gap_ms = events[j]["ts"] - evt["ts"]
                gaps.append({
                    "gap_ms": gap_ms,
                    "next_call": events[j]["tool_name"],
                })
                break

    return gaps, tool_name


def main():
    # Parse args: support --tool-name flag
    args = sys.argv[1:]
    tool_name_override = None
    if "--tool-name" in args:
        idx = args.index("--tool-name")
        if idx + 1 < len(args):
            tool_name_override = args[idx + 1]
            args = args[:idx] + args[idx + 2:]

    if not args:
        print("Usage: python3 analyze_turn_gaps.py <path-to-jsonl> [path2 ...] [--tool-name NAME]")
        print()
        print("Analyzes JSONL session logs for prefill time gaps.")
        print("Auto-detects subagent tool name: 'get_subagent_result' or 'Agent'")
        print("Override with --tool-name <name>")
        print()
        print("When two files are provided, they are compared as ON vs OFF.")
        sys.exit(1)

    results = []
    for filepath in args:
        gaps, detected_name = analyze_file(filepath, tool_name_override)
        results.append((filepath, gaps, detected_name))

    # Print individual results
    for filepath, gaps, detected_name in results:
        label = filepath.split("/")[-1]
        print(f"\n{'─' * 70}")
        print(f"  {label}  (detected tool: {detected_name})")
        print(f"{'─' * 70}")

        if not gaps:
            print(f"  No {detected_name} → next tool_call gaps found.")
            continue

        for i, g in enumerate(gaps):
            print(f"  Task {i+1}: → {g['next_call']:<12} = {g['gap_ms']:6d}ms ({g['gap_ms']/1000:.1f}s)")

        # Summary
        vals = [g["gap_ms"] for g in gaps]
        print(f"\n  Summary:")
        print(f"    Count:  {len(vals)}")
        print(f"    Min:    {min(vals):6d}ms ({min(vals)/1000:.1f}s)")
        print(f"    Max:    {max(vals):6d}ms ({max(vals)/1000:.1f}s)")
        print(f"    Avg:    {sum(vals)/len(vals):6.0f}ms ({sum(vals)/len(vals)/1000:.1f}s)")

    # Cross-file comparison if two files provided
    if len(results) == 2:
        on_path, on_gaps, on_name = results[0]
        off_path, off_gaps, off_name = results[1]

        print(f"\n{'=' * 70}")
        print(f"  COMPARISON TABLE (on={on_name}, off={off_name})")
        print(f"{'=' * 70}")

        # Align by task index
        max_tasks = max(len(on_gaps), len(off_gaps))
        for i in range(max_tasks):
            on_val = on_gaps[i]["gap_ms"] if i < len(on_gaps) else None
            off_val = off_gaps[i]["gap_ms"] if i < len(off_gaps) else None

            print(f"\n  Task {i+1} → {on_gaps[i]['next_call'] if i < len(on_gaps) else '?'}")
            if on_val is not None:
                print(f"    Slots ON:  {on_val:6d}ms ({on_val/1000:.1f}s)")
            if off_val is not None:
                print(f"    Slots OFF: {off_val:6d}ms ({off_val/1000:.1f}s)")
            if on_val is not None and off_val is not None:
                delta = on_val - off_val
                sign = "+" if delta >= 0 else ""
                print(f"    Delta:     {sign}{delta:6d}ms ({sign}{delta/1000:.1f}s) {'(ON slower)' if delta > 0 else '(ON faster)'}")

        # Average comparison
        if on_gaps and off_gaps:
            on_avg = sum(g["gap_ms"] for g in on_gaps) / len(on_gaps)
            off_avg = sum(g["gap_ms"] for g in off_gaps) / len(off_gaps)
            delta = on_avg - off_avg
            print(f"\n{'─' * 70}")
            print(f"    Avg Slots ON:  {on_avg:6.0f}ms ({on_avg/1000:.1f}s)")
            print(f"    Avg Slots OFF: {off_avg:6.0f}ms ({off_avg/1000:.1f}s)")
            sign = "+" if delta >= 0 else ""
            print(f"    Avg Delta:     {sign}{delta:6.0f}ms ({sign}{delta/1000:.1f}s) {'(ON slower)' if delta > 0 else '(ON faster)'}")


if __name__ == "__main__":
    main()
