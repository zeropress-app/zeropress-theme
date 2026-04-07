# @zeropress/theme

![npm](https://img.shields.io/npm/v/%40zeropress%2Ftheme)
![license](https://img.shields.io/npm/l/%40zeropress%2Ftheme)
![node](https://img.shields.io/node/v/%40zeropress%2Ftheme)

Developer toolkit for building, validating, and packaging ZeroPress themes.

---

## Install

```bash
# Run directly with npx (package name)
npx @zeropress/theme <command>
npx @zeropress/theme --help

# Or install globally, then use the zeropress-theme binary
npm install -g @zeropress/theme
zeropress-theme --help
```

* * *

Commands
--------

### dev — Preview Server

```bash
npx @zeropress/theme dev [themeDir] [options]
```

Launches a local preview server with WebSocket-based live reload.

Behavior highlights:

- Watches theme directory changes and performs full reload
- Non-matching routes return 404
- If `404.html` exists at theme root, it is rendered; otherwise a built-in 404 page is used

| Option | Description | Default |
| --- | --- | --- |
| `--port <number>` | Server port | `4321` |
| `--host <ip>` | Bind address | `127.0.0.1` |
| `--data <path>` | Preview data JSON file path | Built-in sample data |
| `--open` | Open browser automatically | — |

Examples:

```bash
# Preview current directory
npx @zeropress/theme dev

# Preview specific theme with custom data
npx @zeropress/theme dev ./my-theme --data ./preview.json
```

If `--data` is omitted, built-in sample data is used.

Preview data contract:

- `dev` only accepts the canonical preview-data v0.3 payload
- Legacy minimal JSON payloads are rejected at startup
- `--data` must point to a local JSON file that contains a v0.3 payload
- The built-in sample data also conforms to preview-data v0.3

Data loading rules:

- Only local file paths are supported
- JSON parse failure aborts `dev` startup

Template variable note:

- Post templates can render optional comments markup via `{{post.comments_html}}`.

* * *

### validate — Theme Validation

```bash
npx @zeropress/theme validate [themeDir|theme.zip] [options]
```

Validates a theme directory or packaged zip against the ZeroPress Theme Runtime v0.2 contract.

Examples:

```bash
# Validate a theme directory
npx @zeropress/theme validate ./my-theme

# Validate a packaged zip
npx @zeropress/theme validate ./dist/my-theme-1.0.0.zip
```

Options:

| Option | Description |
| --- | --- |
| `--strict` | Treat warnings as errors |
| `--json` | Output results as JSON |

#### Errors (block upload)

*   `theme.json` missing or invalid
*   Missing or invalid `namespace`, `slug`, `license`, or `runtime`
*   Missing required templates: `layout.html`, `index.html`, `post.html`, `page.html`
*   Invalid semver in `version`
*   `assets/style.css` missing
*   Invalid slot usage in `layout.html`
*   `<script>` tag inside `layout.html`
*   Nested slots or Mustache block syntax
*   Path traversal or symlink escape

#### Warnings

*   `archive.html`, `category.html`, `tag.html` missing
*   `post.html` does not include `{{post.comments_html}}` (recommended for comment rendering)
*   `{{post.comments_html}}` used outside `post.html`
*   macOS metadata files such as `__MACOSX/` and `._*` are ignored

#### Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | No errors or warnings |
| `1` | Errors found |
| `2` | Warnings only |

With `--strict`, warnings result in exit code `1`.

* * *

### pack — Zip Packaging

```bash
npx @zeropress/theme pack [themeDir] [options]
```

Creates an upload-ready zip file.

| Option | Description | Default |
| --- | --- | --- |
| `--out <dir>` | Output directory | `dist` |
| `--name <file>` | Zip filename | `{name}-{version}.zip` |
| `--dry-run` | Show the output path and included files without writing a zip | — |

Workflow:

1.  Runs `validate`
2.  Excludes unnecessary files
3.  Generates a root-flattened zip
4.  Re-validates the archive

With `--dry-run`, `pack` performs the same pre-pack validation and file selection, then prints the output path and included files without creating the archive.

Excluded automatically:  
`.git`, `node_modules`, `dist`, `*.log`, `__MACOSX`, `.DS_Store`, lockfiles

* * *

CI Usage
--------

```bash
npx @zeropress/theme validate ./theme --strict
npx @zeropress/theme validate ./artifacts/theme-1.0.0.zip --strict
npx @zeropress/theme pack ./theme --dry-run
npx @zeropress/theme pack ./theme --out ./artifacts
```

* * *

Requirements
------------

*   Node.js >= 18.18.0
*   ESM only

* * *

Related
-------

*   [create-zeropress-theme](https://www.npmjs.com/package/create-zeropress-theme)
*   ZeroPress Theme Spec v0.2: [https://zeropress.dev/spec/theme-runtime-v0.2.html](https://zeropress.dev/spec/theme-runtime-v0.2.html)

* * *

About ZeroPress
---------------

ZeroPress is a CMS built around file-based themes and a defined runtime contract.  
It emphasizes predictable structure and portable theme bundles.

Project website:  
[https://zeropress.app](https://zeropress.app)

* * *

License
-------

MIT
