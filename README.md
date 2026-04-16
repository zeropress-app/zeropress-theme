# @zeropress/theme

![npm](https://img.shields.io/npm/v/%40zeropress%2Ftheme)
![license](https://img.shields.io/npm/l/%40zeropress%2Ftheme)
![node](https://img.shields.io/node/v/%40zeropress%2Ftheme)

ZeroPress theme development toolkit.

This package provides the public CLI for previewing, validating, and packaging ZeroPress themes.

---

## Install

```bash
# Run directly with npx
npx @zeropress/theme --help

# Or install globally
npm install -g @zeropress/theme
zeropress-theme --help
```

---

## Quick Start

```bash
npx @zeropress/theme dev ./my-theme
```

---

## Usage

```bash
zeropress-theme dev <themeDir> [--data <path>] [--host <ip>] [--port <n>] [--open]
zeropress-theme validate <themeDir|theme.zip> [--strict] [--json]
zeropress-theme pack <themeDir> [--out <dir>] [--name <zipFile>] [--dry-run]
```

### Arguments

- `<themeDir>`: Theme directory
- `<theme.zip>`: Packaged theme zip file

### Options

- `--help, -h`: Show help
- `--version, -v`: Show version

---

## Examples

```bash
zeropress-theme dev ./my-theme --data ./preview-data.json
zeropress-theme validate ./my-theme --strict
zeropress-theme pack ./my-theme --out ./artifacts
```

---

## Commands

### `dev`

Launches a local preview server with WebSocket-based live reload.

#### Usage

```bash
zeropress-theme dev <themeDir> [--data <path>] [--host <ip>] [--port <n>] [--open]
```

#### Arguments

- `<themeDir>`: Theme directory to preview

#### Options

| Option | Description | Default |
| --- | --- | --- |
| `--data <path>` | Local preview-data v0.5 JSON file | Built-in sample data |
| `--host <ip>` | Bind address | `127.0.0.1` |
| `--port <n>` | Server port | `4321` |
| `--open` | Open the browser automatically | — |

#### Examples

```bash
zeropress-theme dev ./my-theme
zeropress-theme dev ./my-theme --data ./preview-data.json
```

#### Notes

- Builds the theme through `@zeropress/build-core` and serves the latest in-memory output snapshot
- Watches theme directory changes and performs a full rebuild with full reload
- Watches the `--data` file too when one is provided
- Non-matching routes return `404`
- If `404.html` exists at theme root, it is rendered; otherwise a built-in fallback page is used
- `dev` only accepts canonical preview-data v0.5
- `--data` must point to a local file path
- Built-in sample data includes enabled `primary` and `footer` menus for `{{menu:*}}` previews
- Post templates can render optional comments markup via `{{post.comments_html}}`
- Output behavior follows build-core parity for archive, category, tag, `404`, and special files

### `validate`

Validates a theme directory or packaged zip against Theme Runtime v0.3.

#### Usage

```bash
zeropress-theme validate <themeDir|theme.zip> [--strict] [--json]
```

#### Arguments

- `<themeDir|theme.zip>`: Theme directory or packaged theme zip file

#### Options

| Option | Description |
| --- | --- |
| `--strict` | Treat warnings as errors |
| `--json` | Output results as JSON |

#### Examples

```bash
zeropress-theme validate ./my-theme
zeropress-theme validate ./dist/my-theme-1.0.0.zip --strict
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

- `archive.html`, `category.html`, `tag.html` missing
- `post.html` does not include `{{post.comments_html}}`
- `{{post.comments_html}}` used outside `post.html`
- macOS metadata files such as `__MACOSX/` and `._*` are ignored

#### Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | No errors or warnings |
| `1` | Errors found |
| `2` | Warnings only |

With `--strict`, warnings also return exit code `1`.

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
| `--name <zipFile>` | Zip filename | `{name}-{version}.zip` |
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

---

## CI Usage

```bash
zeropress-theme validate ./theme --strict
zeropress-theme validate ./artifacts/theme-1.0.0.zip --strict
zeropress-theme pack ./theme --dry-run
zeropress-theme pack ./theme --out ./artifacts
```

---

## Requirements

- Node.js >= 18.18.0
- ESM only

---

## Related

- [create-zeropress-theme](https://www.npmjs.com/package/create-zeropress-theme)
- [ZeroPress Theme Runtime v0.3](https://zeropress.dev/spec/theme-runtime-v0.3.html)

---

## License

MIT
