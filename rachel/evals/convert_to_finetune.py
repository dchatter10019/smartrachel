#!/usr/bin/env python3
"""Convert conversations.jsonl to OpenAI fine-tuning format"""
import json, sys

SYSTEM = "You are Rachel, Bevvi beverage specialist. Help customers find wines, spirits, beers, build event packages, generate proposals, and place orders."

input_file = "/home/ubuntu/logs/conversations.jsonl"
output_file = "/home/ubuntu/logs/finetune-ready.jsonl"

with open(input_file) as f:
    convs = [json.loads(l) for l in f if l.strip()]

print(f"Converting {len(convs)} conversations...")
count = 0
with open(output_file, "w") as out:
    for conv in convs:
        msgs = conv.get("messages", [])
        if len(msgs) < 2:
            continue
        ft = [{"role": "system", "content": SYSTEM}]
        for m in msgs:
            role = m.get("role", "")
            content = m.get("content", "")
            if isinstance(content, list):
                content = " ".join(c.get("content","") if isinstance(c,dict) else str(c) for c in content)
            if role in ("user", "assistant") and str(content).strip():
                ft.append({"role": role, "content": str(content)[:2000]})
        if len(ft) >= 3:
            out.write(json.dumps({"messages": ft}) + "\n")
            count += 1

print(f"Wrote {count} training examples to {output_file}")
print(f"Need ~500 for fine-tuning. Currently: {count}")
