# CodeMirror browser bundle

Generated from `scripts/article_editor_dependencies.mjs` using the exact versions in `package-lock.json`.

Rebuild at the repository root:

```powershell
npm.cmd ci
npm.cmd run build:editor
```

Commit `codemirror.js` and `LICENSES.txt` together. The application imports this local ES module directly; production/Docker need neither npm nor a CDN. Do not hand-edit generated output. Application/editor extensions live outside this directory.
