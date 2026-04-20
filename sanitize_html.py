#!/usr/bin/env python3
"""Sanitize an HTML file: strip scripts, styles, metadata, and presentational
attributes so that only meaningful content remains.

Usage:
    python sanitize_html.py input.html [-o output.html]

If -o is omitted, the sanitized HTML is written to stdout.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from bs4 import BeautifulSoup, Comment


TAGS_TO_STRIP = {
    "script",
    "style",
    "meta",
    "link",
    "noscript",
    "iframe",
    "svg",
    "canvas",
    "object",
    "embed",
    "template",
    "base",
}

ATTRS_TO_STRIP = {
    "class",
    "style",
    "id",
    "role",
    "tabindex",
    "aria-hidden",
    "srcset",
    "sizes",
    "loading",
    "decoding",
    "referrerpolicy",
    "crossorigin",
    "integrity",
    "nonce",
    "ping",
    "slot",
    "part",
    "is",
    "itemscope",
    "itemtype",
    "itemprop",
    "itemid",
    "itemref",
}

ATTR_PREFIXES_TO_STRIP = (
    "on",        # inline event handlers: onclick, onload, ...
    "data-",     # data-* attributes
    "aria-",     # accessibility attributes (not useful for content extraction)
    "ng-",       # Angular directives
    "v-",        # Vue directives
    "x-",        # Alpine / x-data directives
    ":",         # Vue bindings
    "@",         # Vue event listeners
)


def sanitize(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")

    # Drop entire subtrees for unwanted tags.
    for tag_name in TAGS_TO_STRIP:
        for tag in soup.find_all(tag_name):
            tag.decompose()

    # Drop HTML comments (including conditional IE comments).
    for comment in soup.find_all(string=lambda s: isinstance(s, Comment)):
        comment.extract()

    # Clean attributes on every remaining tag.
    for tag in soup.find_all(True):
        for attr in list(tag.attrs):
            if attr in ATTRS_TO_STRIP or attr.lower().startswith(ATTR_PREFIXES_TO_STRIP):
                del tag.attrs[attr]

    # Unwrap empty presentational wrappers (div/span with no attrs and no text).
    for tag in soup.find_all(["div", "span"]):
        if not tag.attrs and not tag.get_text(strip=True) and not tag.find(True):
            tag.decompose()

    return str(soup)


def main() -> int:
    parser = argparse.ArgumentParser(description="Sanitize an HTML file.")
    parser.add_argument("input", type=Path, help="Path to the HTML file to sanitize.")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="Output file path. Writes to stdout if omitted.",
    )
    args = parser.parse_args()

    html = args.input.read_text(encoding="utf-8", errors="replace")
    cleaned = sanitize(html)

    if args.output:
        args.output.write_text(cleaned, encoding="utf-8")
    else:
        sys.stdout.write(cleaned)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
