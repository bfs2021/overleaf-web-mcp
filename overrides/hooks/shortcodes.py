"""Version badges for the documentation site.

Turns `<!-- md:version X.Y.Z -->` into a badge naming the release that introduced a feature,
following the version convention of Material for MkDocs
(https://squidfunk.github.io/mkdocs-material/conventions/#version). The badge's text links to
that release in the changelog. A version without a `## [X.Y.Z]` heading in CHANGELOG.md fails
the build, so a badge can never point at a release that does not exist.
"""

from __future__ import annotations

import posixpath
import re
from pathlib import Path

from markdown.extensions.toc import slugify
from mkdocs.config.defaults import MkDocsConfig
from mkdocs.structure.files import Files
from mkdocs.structure.pages import Page

# Not inside an inline code span, so the syntax itself can be shown as `<!-- md:version X.Y.Z -->`.
SHORTCODE = re.compile(r"(?<!`)<!-- md:(\w+)(.*?) -->(?!`)")
FENCE = re.compile(r"^(\s*)(`{3,}|~{3,})")
RELEASE_HEADING = re.compile(r"^## \[(\d+\.\d+\.\d+)\](.*)$", re.MULTILINE)

# Version -> changelog anchor, rebuilt on every build, so a badge for an `Unreleased` release
# follows its heading once the release is dated.
_anchors: dict[str, str] = {}


def on_config(config: MkDocsConfig) -> MkDocsConfig:
    changelog = Path(config.config_file_path).parent / "CHANGELOG.md"
    _anchors.clear()
    for match in RELEASE_HEADING.finditer(changelog.read_text(encoding="utf-8")):
        version, rest = match.groups()
        _anchors[version] = slugify(f"{version}{rest}", "-")
    return config


def on_page_markdown(markdown: str, *, page: Page, config: MkDocsConfig, files: Files) -> str:
    lines = []
    fence = None
    for line in markdown.split("\n"):
        opener = FENCE.match(line)
        if fence is None and opener:
            fence = opener.group(2)[0] * 3
        elif fence is not None and line.strip().startswith(fence):
            fence = None
        elif fence is None:
            line = SHORTCODE.sub(lambda match: _replace(match, page), line)
        lines.append(line)
    return "\n".join(lines)


def _replace(match: re.Match[str], page: Page) -> str:
    kind, args = match.group(1), match.group(2).strip()
    if kind != "version":
        raise RuntimeError(f"{page.file.src_uri}: unknown shortcode md:{kind}")
    if args not in _anchors:
        raise RuntimeError(
            f"{page.file.src_uri}: md:version {args!r} has no '## [{args}]' heading in CHANGELOG.md"
        )
    return _badge(args, page)


def _link(target: str, page: Page) -> str:
    path, _, anchor = target.partition("#")
    relative = posixpath.relpath(path, posixpath.dirname(page.file.src_uri) or ".")
    return f"{relative}#{anchor}" if anchor else relative


def _badge(version: str, page: Page) -> str:
    tags = _link("versions.md#version-tags", page)
    changelog = _link(f"changelog.md#{_anchors[version]}", page)
    return (
        '<span class="mdx-badge">'
        f'<span class="mdx-badge__icon">[:material-tag-outline:]({tags} "Minimum version")</span>'
        f'<span class="mdx-badge__text">[{version}]({changelog})</span>'
        "</span>"
    )
