---
type: llm
---

PASS if the final message tells the user that the design's #D5D5D5 only nearly matches the project's --color-border (#D6D6D6), or that some design values have no project token (the 20px text style, the 12px radius, or the Card component), and asks the user how to handle them before writing the code that uses them.
FAIL if the final message says it used --color-border for #D5D5D5 without asking, or does not mention the near or unmatched values at all.
