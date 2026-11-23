#!/usr/bin/env python3
"""Pre-deploy sanity check for the frontend JS.

Flags bare function calls that are never defined or imported in the same file (e.g. a helper
accidentally deleted during a refactor). It's a heuristic: words in UI text that happen to look
like calls go in IGNORE. Exits non-zero if anything unexpected turns up.

Usage: python3 scripts/check_js.py public/*.js
"""
import re
import sys

# Words from UI strings and browser globals that the regex picks up as "calls".
IGNORE = set("Details FormData GPS address climb in location photo this var ftyp and Price".split())

BUILTINS = set("""if for while switch catch return typeof function async await new super import
setTimeout clearTimeout setInterval clearInterval requestAnimationFrame fetch String Number Boolean Array Object
Math Date JSON Promise Set Map WeakMap URL URLSearchParams Intl Error TypeError DOMException Image Blob File
encodeURIComponent decodeURIComponent parseInt parseFloat isNaN isFinite confirm alert structuredClone CSS L
AbortController AbortSignal performance indexedDB createImageBitmap Uint8Array Request Response""".split())

IDENT = r"[A-Za-z_$][\w$]*"


def check(path):
    src = open(path).read()
    # Comments start after whitespace/punctuation — not inside text like "image/*" or "https://".
    code = re.sub(r"(?<![:\w\"'/])//[^\n]*|(?<![\w\"'/])/\*.*?\*/", "", src, flags=re.S)
    called = set(re.findall(rf"(?<![\w.$'\"`])({IDENT})\s*\(", code))
    defined = set(re.findall(rf"function\s*\*?\s*({IDENT})", code))
    defined |= set(re.findall(rf"(?:const|let|var)\s+({IDENT})", code))
    for group in re.findall(r"import\s*\{([^}]*)\}", code):
        defined |= {x.split(" as ")[-1].strip() for x in group.split(",") if x.strip()}
    defined |= set(re.findall(rf"import\s+({IDENT})\s+from", code))
    params = re.findall(r"\(([^()]*)\)\s*=>", code) + re.findall(r"function\s*[\w$]*\s*\(([^()]*)\)", code)
    for p in params:
        defined |= set(re.findall(IDENT, p))
    defined |= set(re.findall(rf"({IDENT})\s*=>", code))
    return sorted(called - defined - BUILTINS - IGNORE)


bad = False
for path in sys.argv[1:]:
    missing = check(path)
    if missing:
        bad = True
        print(f"{path}: called but never defined/imported: {', '.join(missing)}")
print("check_js: " + ("FAILED" if bad else "ok"))
sys.exit(1 if bad else 0)
