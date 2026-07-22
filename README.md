# @zeropress/theme

![npm](https://img.shields.io/npm/v/%40zeropress%2Ftheme)
![license](https://img.shields.io/npm/l/%40zeropress%2Ftheme)
![node](https://img.shields.io/node/v/%40zeropress%2Ftheme)

Public ZeroPress theme developer toolkit for Theme Runtime v0.7.

This package provides the CLI for previewing, validating, and packaging ZeroPress themes.

It uses directly:

- [@zeropress/build-core](https://www.npmjs.com/package/@zeropress/build-core) for dev-server preview rendering
- [@zeropress/theme-validator](https://www.npmjs.com/package/@zeropress/theme-validator) for theme manifest and file validation

Public contract references:

- [Theme Runtime v0.7 Spec](https://zeropress.dev/reference/theme-runtime/specs/v0.7/)
- [Theme Runtime v0.7 Schema](https://schemas.zeropress.dev/theme-runtime/v0.7/schema.json)
- [Preview Data v0.7 Spec](https://zeropress.dev/reference/preview-data/specs/v0.7/)
- [Preview Data v0.7 Schema](https://schemas.zeropress.dev/preview-data/v0.7/schema.json)

## Install

```bash
# Run directly with npx
npx @zeropress/theme --help

# Or install globally
npm install -g @zeropress/theme
zeropress-theme --help
```

## Quick Start

If you do not already have a ZeroPress theme and preview-data file, create a starter project first:

```bash
npx @zeropress/create-theme --name my-minimal --template minimal
```

Then preview the generated theme with the generated preview data:

```bash
npx @zeropress/theme dev ./my-minimal/theme --data ./my-minimal/preview-data.json
```

If you already have a theme and preview-data file:

```bash
npx @zeropress/theme dev ./my-theme --data ./preview-data.json
```

`@zeropress/create-theme` creates a starter theme and matching preview-data fixture. `@zeropress/theme` previews, validates, and packages that theme.

## Typical Workflow

`@zeropress/theme` is the theme authoring tool. A common workflow is:

1. Create a starter theme and preview fixture, if needed:

```bash
npx @zeropress/create-theme --name my-minimal --template minimal
```

2. Preview and iterate on the theme:

```bash
npx @zeropress/theme dev ./my-minimal/theme --data ./my-minimal/preview-data.json
```

3. Validate or package the theme:

```bash
npx @zeropress/theme validate ./my-minimal/theme
npx @zeropress/theme pack ./my-minimal/theme --out ./artifacts
```

4. Build a static site with the finished theme:

```bash
npx @zeropress/build ./my-minimal/theme --data ./my-minimal/preview-data.json --out ./dist
```

For Markdown-first sites, use [@zeropress/build-pages](https://www.npmjs.com/package/@zeropress/build-pages) instead of writing preview-data by hand.

## Usage

```bash
zeropress-theme dev <themeDir> [--data <path>] [--public-dir <dir>] [--host <host>] [--port <n>] [--strict-port] [--no-js]
zeropress-theme validate <themeDir|theme.zip> [--json]
zeropress-theme pack <themeDir> [--out <dir>] [--name <zipFile>] [--dry-run]
```

### Arguments

- `<themeDir>`: Theme directory
- `<theme.zip>`: Packaged theme zip file
- Every command accepts exactly one positional theme path.

### Options

- `--help, -h`: Show help
- `--version, -v`: Show version

## Examples

```bash
zeropress-theme dev ./my-theme --data ./preview-data.json
zeropress-theme validate ./my-theme
zeropress-theme pack ./my-theme --out ./artifacts
```

## Commands

### `dev`

Launches a local preview server with WebSocket-based live reload.

#### Usage

```bash
zeropress-theme dev <themeDir> [--data <path>] [--public-dir <dir>] [--host <host>] [--port <n>] [--strict-port] [--no-js]
```

#### Arguments

- `<themeDir>`: Theme directory to preview

#### Options

| Option | Description | Default |
| --- | --- | --- |
| `--data <path>` | Local preview-data v0.7 JSON file | Built-in sample data |
| `--public-dir <dir>` | Public passthrough directory | `./public` |
| `--host <host>` | Hostname, IPv4 address, or IPv6 address to bind | `127.0.0.1` |
| `--port <n>` | Preferred server port | `4000` |
| `--strict-port` | Fail when the preferred port is already in use instead of trying the next port | — |
| `--no-js` | Add a dev-only CSP header that disables JavaScript execution in HTML responses | — |

#### Examples

```bash
zeropress-theme dev ./my-theme
zeropress-theme dev ./my-theme --data ./preview-data.json
zeropress-theme dev ./my-theme --data ./preview-data.json --public-dir ./public
zeropress-theme dev ./my-theme --data ./preview-data.json --no-js
```

#### Notes

- Builds the theme through `@zeropress/build-core` and serves the latest in-memory output snapshot
- Falls back to files in the public directory when a route is not generated
- Streams public fallback files from disk instead of loading each complete file into memory; live-reload injection for public HTML is streaming as well
- The public directory defaults to `./public/`; use `--public-dir <dir>` or `ZEROPRESS_PUBLIC_DIR` when a project needs a different public root
- Precedence is `--public-dir` > `ZEROPRESS_PUBLIC_DIR` > `./public/`
- Relative public directory values are resolved from the current working directory
- If the resolved public path does not exist, `dev` runs without public fallback
- If the resolved public path exists, its final directory entry must be real rather than a symbolic link; accepted roots are pinned to their canonical path before serving and watching
- Generated output is served before public files when paths overlap
- `robots.txt` is a fallback special file: if public `robots.txt` exists, the dev server serves that file instead of generated fallback robots output
- Public `robots.txt` is served as-is. If it needs a `Sitemap` directive, add it to the file manually.
- Root-level public favicon files named `favicon.ico`, `favicon.dark.ico`, `favicon.svg`, `favicon.png`, and `apple-touch-icon.png` are auto-discovered and injected into generated HTML `<head>` output unless preview-data already defines `site.favicon`. When both ICO files exist, `favicon.dark.ico` is used for the dark color scheme and the regular icon variants are used for the light color scheme; a lone ICO file is used for every color scheme
- A root-level public `sitemap.xsl` is served as-is. When ZeroPress generates `sitemap.xml`, it auto-discovers that file and adds an XML stylesheet processing instruction for `/sitemap.xsl`.
- Hidden entries, `node_modules`, `Thumbs.db`, `*.key`, `*.pem`, and symlinks inside the public directory are ignored
- Decoded request paths containing backslashes or control characters are rejected before generated or public path lookup, including on Windows
- The final theme directory entry must be real rather than a symbolic link and must not overlap with the resolved public directory. Symbolic links in ancestor path components are allowed; accepted theme and public roots are resolved once to canonical paths before building, serving, or watching.
- The dev server has no authentication. Binding to a non-loopback host such as `0.0.0.0` exposes the preview and public fallback files to reachable network clients; use a trusted network or an authenticated proxy.
- Starts on the preferred port, or the next available port unless `--strict-port` is used
- Uses one recursive watcher for the real theme root, including hidden asset directories and subdirectories created after startup, and performs a full rebuild with full reload
- Watches the `--data` file too when one is provided
- Uses one recursive watcher for the real public root when it exists at startup; creating it after startup requires restarting `dev`
- Stops with exit code `1` after a watcher failure or when a watched theme, public, or preview-data parent directory disappears or becomes a symbolic link; resolve the filesystem problem and restart `dev`
- Live reload is appended at the end of HTML responses, so literal `</body>` text inside scripts, examples, or comments is not treated as an insertion point
- The live-reload WebSocket is server-to-client only. Client application messages are rejected with close code `1008`, and inbound payloads are limited to 1 KiB.
- `--no-js` adds `Content-Security-Policy: script-src 'none'` to HTML responses and skips live reload injection. It does not rewrite HTML or block `.js` asset requests.
- Non-matching routes return `404`
- If `404.html` exists at theme root, it is rendered; otherwise a built-in fallback page is used
- `dev` only accepts canonical preview-data v0.7
- `--data` must point to a local file path
- Built-in sample data includes enabled `primary` and `footer` menus for `{{menu:*}}` previews
- Every rendered theme route receives effective `site.search`, `site.feed`, `site.archive`, and `site.comments` objects. Check their `.enabled` discriminator before using feature-specific fields such as `site.feed.url` or `site.archive.url`.
- Post and Page templates can render a theme-owned comments island by checking `{{#if comments.enabled}}`. Active detail routes also expose `comments.target_type`, `comments.target_public_id`, `comments.provider`, `comments.api_base_url`, pagination/threading settings, and a ZeroPress-only `comments.request_token`; all other routes receive `{ "comments": { "enabled": false } }`.
- `theme.json.features` is optional. Omitted feature flags use runtime defaults: `comments: false`, `post_index: true`, and `search: false`.
- Output behavior follows build-core parity for archive, category, tag, `404`, and special files

### `validate`

Validates a theme directory or packaged zip against Theme Runtime v0.7.

#### Usage

```bash
zeropress-theme validate <themeDir|theme.zip> [--json]
```

#### Arguments

- `<themeDir|theme.zip>`: Theme directory or packaged theme zip file

#### Options

| Option | Description |
| --- | --- |
| `--json` | Output results as JSON |

When `--json` is present, validation failures, target I/O failures, malformed archives, missing required arguments, and unknown options all use the same JSON result schema on stdout and exit with code `1`. This applies even when an unknown option appears before `--json`. No human-readable error is written to stderr in this mode, so CI can parse stdout consistently.

Human-readable diagnostics make attacker-controlled terminal characters visible as `\uXXXX`, including C0/C1 controls, ESC, line controls, and Unicode direction controls. Tool-owned line breaks and ANSI colors remain intact. JSON output preserves the existing data contract and is not terminal-escaped.

#### Examples

```bash
zeropress-theme validate ./my-theme
zeropress-theme validate ./dist/my-theme-1.0.0.zip
```

#### Errors

- `theme.json` missing or invalid
- Missing or invalid `namespace`, `slug`, `license`, or `runtime`
- Missing required templates: `layout.html`, `index.html`, `post.html`, `page.html`
- Invalid semver in `version`
- `assets/style.css` missing
- Invalid slot usage in `layout.html`
- `<script>` inside `layout.html`
- Nested slots or Mustache block syntax
- Unsafe package paths; literal backslashes and exact empty, `.` and `..` segments are invalid, while ordinary filenames such as `name..txt` are valid
- Directory package paths that collide after NFC and case normalization
- Any symbolic link at the final input-root entry or inside the package, including internal and dangling links. Symbolic links in ancestor path components are allowed, and the accepted root is pinned to its canonical path before validation.
- A ZIP larger than 2 MiB
- More than 128 package entries
- A file larger than 1 MiB
- Expanded package content larger than 4 MiB
- ZIP64, multi-disk, or encrypted ZIP input
- ZIP entry CRC32 mismatch

#### Warnings

- `layout.html` does not start with `<!doctype html>`
- macOS metadata files such as `__MACOSX/` and `._*` are ignored

#### Info

- `archive.html`, `category.html`, `tag.html` missing

#### Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Valid theme, with or without warnings or info notes |
| `1` | Errors found |

### `pack`

Creates an upload-ready zip file for a theme directory.

#### Usage

```bash
zeropress-theme pack <themeDir> [--out <dir>] [--name <zipFile>] [--dry-run]
```

#### Arguments

- `<themeDir>`: Theme directory to package

#### Options

| Option | Description | Default |
| --- | --- | --- |
| `--out <dir>` | Output directory | `dist` |
| `--name <zipFile>` | `.zip` filename without directory components | `{namespace}.{slug}@{version}.zip` |
| `--dry-run` | Run the complete packaging preflight without writing files | — |

#### Examples

```bash
zeropress-theme pack ./my-theme --dry-run
zeropress-theme pack ./my-theme --out ./artifacts
```

#### Notes

- Runs `validate` before packaging
- Excludes unnecessary files such as `.git`, `node_modules`, `dist`, `*.log`, `__MACOSX`, `.DS_Store`, and lockfiles
- When the resolved output directory is a subdirectory of the theme, excludes that entire directory. When `--out` resolves to the theme root, excludes only the current target ZIP, so repeated packs do not validate or include their previous target.
- Allows symbolic links anywhere in the output-directory path, including a final macOS alias such as `/tmp`, by resolving the nearest existing path once to a canonical directory before validation or writing
- Rejects a symbolic-link final zip path in real and dry-run modes
- Rejects every symbolic link included in the theme package
- Rejects a symbolic-link final theme input entry in real and dry-run modes. Ancestor aliases are allowed and resolved once to a canonical theme root.
- Generates a root-flattened zip
- Uses the validated manifest value verbatim for the default `{namespace}.{slug}@{version}.zip` name, preserving SemVer case and build metadata
- Assigns every ZIP entry the fixed `1980-01-01T00:00:00Z` DOS timestamp and explicit DOS platform metadata, so identical input produces byte-identical archives across timezones
- Re-validates the generated archive, including entry CRC32 values
- Applies fixed package limits: 2 MiB ZIP, 4 MiB expanded, 1 MiB per file, and 128 entries
- With `--dry-run`, collects and reads the same files, generates and validates the ZIP in memory, checks package limits and output-path safety, and then prints the plan without creating directories, temporary files, or a destination ZIP

## CI Usage

```bash
zeropress-theme validate ./theme
zeropress-theme validate ./artifacts/theme-1.0.0.zip
zeropress-theme pack ./theme --dry-run
zeropress-theme pack ./theme --out ./artifacts
```

## License

MIT
