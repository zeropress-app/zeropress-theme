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
zeropress-theme dev <themeDir> [--data <path>] [--public-dir <dir>] [--host <ip>] [--port <n>] [--strict-port] [--open] [--no-js]
zeropress-theme validate <themeDir|theme.zip> [--json]
zeropress-theme pack <themeDir> [--out <dir>] [--name <zipFile>] [--dry-run]
```

### Arguments

- `<themeDir>`: Theme directory
- `<theme.zip>`: Packaged theme zip file

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
zeropress-theme dev <themeDir> [--data <path>] [--public-dir <dir>] [--host <ip>] [--port <n>] [--strict-port] [--open] [--no-js]
```

#### Arguments

- `<themeDir>`: Theme directory to preview

#### Options

| Option | Description | Default |
| --- | --- | --- |
| `--data <path>` | Local preview-data v0.7 JSON file | Built-in sample data |
| `--public-dir <dir>` | Public passthrough directory | `./public` |
| `--host <ip>` | Bind address | `127.0.0.1` |
| `--port <n>` | Preferred server port | `4000` |
| `--strict-port` | Fail when the preferred port is already in use instead of trying the next port | — |
| `--open` | Open the browser automatically | — |
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
- The public directory defaults to `./public/`; use `--public-dir <dir>` or `ZEROPRESS_PUBLIC_DIR` when a project needs a different public root
- Precedence is `--public-dir` > `ZEROPRESS_PUBLIC_DIR` > `./public/`
- Relative public directory values are resolved from the current working directory
- If the resolved public path does not exist, `dev` runs without public fallback
- If the resolved public path exists, it must be a real directory; files and symlinked directories are rejected
- Generated output is served before public files when paths overlap
- `robots.txt` is a fallback special file: if public `robots.txt` exists, the dev server serves that file instead of generated fallback robots output
- Public `robots.txt` is served as-is. If it needs a `Sitemap` directive, add it to the file manually.
- Root-level public favicon files named `favicon.ico`, `favicon.dark.ico`, `favicon.svg`, `favicon.png`, and `apple-touch-icon.png` are auto-discovered and injected into generated HTML `<head>` output unless preview-data already defines `site.favicon`. When both ICO files exist, `favicon.dark.ico` is used for the dark color scheme and the regular icon variants are used for the light color scheme; a lone ICO file is used for every color scheme
- A root-level public `sitemap.xsl` is served as-is. When ZeroPress generates `sitemap.xml`, it auto-discovers that file and adds an XML stylesheet processing instruction for `/sitemap.xsl`.
- Hidden entries, `node_modules`, `Thumbs.db`, `*.key`, `*.pem`, and symlinks inside the public directory are ignored
- The theme directory must not overlap with the resolved public directory
- Starts on the preferred port, or the next available port unless `--strict-port` is used
- Watches theme directory changes and performs a full rebuild with full reload
- Watches the `--data` file too when one is provided
- Watches the public directory too when it exists at startup; creating it after startup requires restarting `dev`
- `--no-js` adds `Content-Security-Policy: script-src 'none'` to HTML responses and skips live reload injection. It does not rewrite HTML or block `.js` asset requests.
- Non-matching routes return `404`
- If `404.html` exists at theme root, it is rendered; otherwise a built-in fallback page is used
- `dev` only accepts canonical preview-data v0.7
- `--data` must point to a local file path
- Built-in sample data includes enabled `primary` and `footer` menus for `{{menu:*}}` previews
- Every rendered theme route receives effective `site.search`, `site.feed`, `site.archive`, and `site.comments` objects. Check their `.enabled` discriminator before using feature-specific fields such as `site.feed.url` or `site.archive.url`.
- Post and Page templates can render a theme-owned comments island by checking `{{#if comments.enabled}}`. Active detail routes also expose `comments.target_type`, `comments.target_public_id`, `comments.provider`, `comments.api_base_url`, pagination/threading settings, and a ZeroPress-only `comments.request_token`; all other routes receive `{ "comments": { "enabled": false } }`.
- `theme.json.features` is optional. Omitted feature flags use runtime defaults: `comments: false`, `post_index: true`, `search: false`, and newsletter as capability metadata only.
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
- Path traversal or symlink escape

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
| `--name <zipFile>` | Zip filename | `{namespace}.{slug}@{version}.zip` |
| `--dry-run` | Print the output path and included files without writing a zip | — |

#### Examples

```bash
zeropress-theme pack ./my-theme --dry-run
zeropress-theme pack ./my-theme --out ./artifacts
```

#### Notes

- Runs `validate` before packaging
- Excludes unnecessary files such as `.git`, `node_modules`, `dist`, `*.log`, `__MACOSX`, `.DS_Store`, and lockfiles
- Generates a root-flattened zip
- Re-validates the generated archive
- With `--dry-run`, prints the output path and included files without creating a zip

## CI Usage

```bash
zeropress-theme validate ./theme
zeropress-theme validate ./artifacts/theme-1.0.0.zip
zeropress-theme pack ./theme --dry-run
zeropress-theme pack ./theme --out ./artifacts
```

## License

MIT
