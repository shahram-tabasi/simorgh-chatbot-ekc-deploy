# Windows installer drop folder

Put the built installer here and the app offers it for download — Help →
"Windows app", and the small link in the footer. The newest `.exe` in this
folder wins; nothing is offered while the folder is empty.

```
SimorghDesignSuite-Setup-1.0.0.exe
```

Build it with the **Desktop installer (Windows)** GitHub Actions workflow (or
`npm run dist:win` on Windows — see `../../desktop/README.md`), then copy the
file in. In the deployed stack this folder is bind-mounted into the container,
so publishing a new build is a copy — no image rebuild:

```bash
cp SimorghDesignSuite-Setup-1.0.0.exe \
   simorgh-agent/simorgh-soft/simorgh-backend/downloads/
```

`DESKTOP_DOWNLOAD_DIR` overrides the location.
