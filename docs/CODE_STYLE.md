# Code Style

This document defines the repository's source-code conventions. Prefer the
existing local patterns unless a rule below explicitly replaces them.

## Character Encoding

- Store text files as UTF-8.
- Use ASCII in source-code comments by default.
- Do not use decorative Unicode comment separators such as repeated box-drawing
  characters (`─`, `═`, and similar).
- Use short section comments only when they improve navigation, for example:
  `// Helpers` or `// Public API`.
- Unicode is allowed when it is intentional application content, such as
  localized text, generated Markdown, or user-facing CLI output.
- Never commit mojibake such as `â...`, `Ã...`, or `Â...`. Replace it with the
  intended text or remove the decorative comment.

## Comments

- Explain decisions, constraints, and non-obvious behavior.
- Do not narrate straightforward code.
- Prefer a concise comment above a complex block over decorative section
  dividers.
- Remove stale comments when behavior changes.

## JavaScript

- Use ES modules and the repository's existing import style.
- Prefer descriptive names over comments that explain abbreviated names.
- Keep platform-specific behavior inside its platform module.
- Run `node --check` for changed JavaScript files and `npm test` before
  considering a change complete.

## Documentation

- Update relevant docs when commands, configuration, or runtime behavior
  changes.
- Keep examples executable and consistent with `.env.example`.
