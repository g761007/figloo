---
description: The prompt Figloo's popup copies for a selected screen
tags: [trigger]
model: sonnet
max_turns: 4
allowed_tools: [Skill, Read, Glob, Grep]
---

I want to implement the Figma page I selected in my browser; use the Figloo MCP tools.

File: Shop app (tab 42)
Page: Checkout
Layer: Order summary (Frame), ref 12:34
Path: Checkout > Order summary

Call get_anchor with tabId 42 first; it should return ref 12:34. If it returns another layer, ask me to select this one again. Then call snapshot_layer on it: it reads every layer of the page at once, with a screenshot, which takes up to three minutes while I leave Figma alone. Look layers up with query_snapshot, and use export_asset for icons and images.

Build it as a React component in src/screens/OrderSummary.tsx.
