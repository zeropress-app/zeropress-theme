# zeropress-theme

![npm](https://img.shields.io/npm/v/zeropress-theme)
![license](https://img.shields.io/npm/l/zeropress-theme)
![node](https://img.shields.io/node/v/zeropress-theme)

Developer toolkit for building, validating, and packaging ZeroPress themes.

---

## Install

```bash
# Run directly with npx
npx zeropress-theme <command>

# Or install globally
npm install -g zeropress-theme
```

* * *

Commands
--------

### dev — Preview Server

```bash
npx zeropress-theme dev [themeDir] [options]
```

Launches a local preview server with WebSocket-based live reload.

Behavior highlights:

- Watches template/assets changes and performs full reload
- Non-matching routes return 404
- If `404.html` exists at theme root, it is rendered; otherwise a built-in 404 page is used

| Option | Description | Default |
| --- | --- | --- |
| `--port <number>` | Server port | `4321` |
| `--host <ip>` | Bind address | `127.0.0.1` |
| `--data <path-or-url>` | Preview data JSON (local path or HTTPS URL) | Built-in sample data |
| `--open` | Open browser automatically | — |
| `--no-js-check` | Skip JS-related checks | — |

Examples:

```bash
# Preview current directory
npx zeropress-theme dev

# Preview specific theme with custom data
npx zeropress-theme dev ./my-theme --data ./preview.json

# Use remote preview data
npx zeropress-theme dev ./my-theme --data https://signed-url/preview.json
```

If `--data` is omitted, built-in sample data is used.  
Remote URLs must use HTTPS (1 MB limit, 5-second timeout).

Data loading rules:

- Local file path and HTTPS URL are both supported
- Redirects are allowed
- No retry on fetch failure
- Download or JSON parse failure aborts `dev` startup

* * *

### validate — Theme Validation

```bash
npx zeropress-theme validate [themeDir] [options]
```

Validates a theme against the ZeroPress Theme Runtime v0.1 contract.

Options:

| Option | Description |
| --- | --- |
| `--strict` | Treat warnings as errors |
| `--json` | Output results as JSON |

#### Errors (block upload)

*   `theme.json` missing or invalid
*   Missing required templates: `layout.html`, `index.html`, `post.html`, `page.html`
*   Invalid semver in `version`
*   `assets/style.css` missing
*   Invalid slot usage in `layout.html`
*   `<script>` tag inside `layout.html`
*   Nested slots or Mustache block syntax
*   Path traversal or symlink escape

#### Warnings

*   `archive.html`, `category.html`, `tag.html` missing

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
npx zeropress-theme pack [themeDir] [options]
```

Creates an upload-ready zip file.

| Option | Description | Default |
| --- | --- | --- |
| `--out <dir>` | Output directory | `dist` |
| `--name <file>` | Zip filename | `{name}-{version}.zip` |

Workflow:

1.  Runs `validate`
2.  Excludes unnecessary files
3.  Generates a root-flattened zip
4.  Re-validates the archive

Excluded automatically:  
`.git`, `node_modules`, `dist`, `*.log`, `__MACOSX`, `.DS_Store`, lockfiles

* * *

CI Usage
--------

```bash
npx zeropress-theme validate ./theme --strict
npx zeropress-theme pack ./theme --out ./artifacts
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
*   ZeroPress Theme Spec: [https://zeropress.dev](https://zeropress.dev)

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
