# zeropress-theme

Developer toolkit for building, validating, and packaging ZeroPress themes.

## Install

```bash
# Run directly with npx (no install required)
npx zeropress-theme <command>

# Or install globally
npm install -g zeropress-theme
```

## Commands

### dev — Preview Server

```bash
npx zeropress-theme dev [themeDir] [options]
```

Launches a local preview server with WebSocket-based live reload on file changes.

| Option | Description | Default |
|--------|-------------|---------|
| `--port <number>` | Server port | `4321` |
| `--host <ip>` | Bind address | `127.0.0.1` |
| `--data <path-or-url>` | Preview data JSON (local path or HTTPS URL) | Built-in sample data |
| `--open` | Open browser automatically | - |
| `--no-js-check` | Skip JS-related checks | - |

```bash
# Preview theme in current directory
npx zeropress-theme dev

# Specify theme path and custom data
npx zeropress-theme dev ./my-theme --data ./preview.json

# Use remote data
npx zeropress-theme dev ./my-theme --data https://signed-url/preview.json
```

When `--data` is omitted, built-in sample data is used. Remote URLs must use HTTPS, with a 1 MB size limit and 5-second timeout.

---

### validate — Theme Validation

```bash
npx zeropress-theme validate [themeDir] [options]
```

Checks whether a theme satisfies the [Theme Spec Runtime v0.1](https://github.com/user/zeropress/blob/main/theme_guide_v2/THEME_SPEC.md) contract.

| Option | Description |
|--------|-------------|
| `--strict` | Treat warnings as errors |
| `--json` | Output results as JSON |

#### Checks

**Errors (block upload)**
- `theme.json` missing, unparseable, or missing required fields (`name`, `version`, `author`)
- `version` not valid semver
- Required templates missing: `layout.html`, `index.html`, `post.html`, `page.html`
- `assets/style.css` missing
- `layout.html` does not contain exactly one `{{slot:content}}`
- `layout.html` contains `<script>` tags
- Slots other than `content`, `header`, `footer`, `meta`
- Nested slots or Mustache block syntax (`{{#...}}`, `{{/...}}`)
- Path traversal (`../`, absolute paths, symlink escape)

**Warnings**
- `archive.html`, `category.html`, `tag.html` missing

#### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | No errors or warnings |
| `1` | Errors found |
| `2` | Warnings only |

With `--strict`, any warning results in exit code `1`.

#### --json Output Example

```json
{
  "ok": false,
  "summary": { "errors": 1, "warnings": 2, "checkedFiles": 14 },
  "errors": [
    { "code": "MISSING_REQUIRED_TEMPLATE", "path": "layout.html", "message": "Required template 'layout.html' is missing" }
  ],
  "warnings": [
    { "code": "MISSING_OPTIONAL_TEMPLATE", "path": "archive.html", "message": "Optional template 'archive.html' is missing" }
  ],
  "meta": {
    "schemaVersion": "1",
    "tool": "zeropress-theme",
    "toolVersion": "0.1.0",
    "timestamp": "2026-02-14T00:00:00.000Z"
  }
}
```

---

### pack — Zip Packaging

```bash
npx zeropress-theme pack [themeDir] [options]
```

Packages a theme into an upload-ready zip file.

| Option | Description | Default |
|--------|-------------|---------|
| `--out <dir>` | Output directory | `dist` |
| `--name <file>` | Zip filename | `{name}-{version}.zip` |

```bash
npx zeropress-theme pack
npx zeropress-theme pack ./my-theme --out artifacts
npx zeropress-theme pack ./my-theme --name my-theme-v1.zip
```

Pack workflow:
1. Runs `validate` first (aborts on errors)
2. Excludes unnecessary files and generates a root-flattened zip
3. Re-validates the generated zip (deletes it on failure)

Auto-excluded: `.git`, `node_modules`, `dist`, `*.log`, `__MACOSX`, `.DS_Store`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`

## CI Usage

```bash
npx zeropress-theme validate ./theme --strict
npx zeropress-theme pack ./theme --out ./artifacts
```

## Preview Data

Minimum structure for the preview data JSON used by `dev`:

```json
{
  "site": {
    "title": "My Site",
    "description": "Preview description",
    "url": "https://example.com",
    "language": "ko"
  },
  "posts": [],
  "pages": [],
  "categories": [],
  "tags": []
}
```

Required: `site.title`, `site.description`, `site.url`, `site.language`.
`posts`, `pages`, `categories`, `tags` are optional (default to empty arrays).

Schema: [preview-data.schema.json](https://github.com/user/zeropress/blob/main/theme_guide_v2/preview-data.schema.json)

## Requirements

- Node.js >= 18.18.0
- ESM only

## Related

- [create-zeropress-theme](https://www.npmjs.com/package/create-zeropress-theme) — Theme scaffolding CLI
- [ZeroPress Theme Spec](https://github.com/user/zeropress/blob/main/theme_guide_v2/THEME_SPEC.md)

## License

MIT
