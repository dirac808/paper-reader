# Changelog

## 1.6.0 (2026/10/06)

- Edit Markdown tables in place: click a cell to type, and the table stays rendered instead of collapsing into Markdown source.
- Place the caret exactly where you click inside a cell, and allow selecting text by dragging inside a cell.
- Add controls outside the table body for every structural edit: insert or delete a row, insert or delete a column, append a row or column, and delete the table.
- Sit every control where its meaning reads. The insert control sits on the junction it splits and the delete control on the row or column it removes, both hugging the table: a `+` sits on the column boundary two pixels above the table, a `×` above its column's centre, and the row controls share a lane flush against the table's left edge.
- Reveal a control only when the pointer is near the boundary it belongs to, always reveal the control being pointed at, and keep it clickable while the pointer travels onto it.
- Keep every click inside the table widget from reaching the editor, so pressing the thin margin around a table no longer moves the cursor off the table and collapses it into source.
- Stretch every cell to the full height of its table cell, so the whole box a reader sees belongs to that cell and a click anywhere inside it lands there.
- Measure a row from its `<tr>` rather than from its first cell, so a row controls stay put when a later column wraps onto another line, and refresh the controls whenever the table's geometry changes.
- Remove the table card frame and the focus box around the edited cell, so a table looks like a rendered Markdown table again.
- Commit cell text with a single minimal transaction once typing settles, and reuse the mounted table so focus and the caret survive typing.
- Hide the ATX heading marker in the rendered view: `## Title` shows as a styled `Title`, while the `#` characters stay in the document and in the saved file.
- Add table model unit tests covering parse/serialize round trips, empty cells, escaping, alignment and repeated row/column edits, and extend the browser suite with in-place editing, caret placement, drag selection and real-mouse checks for the controls.

## 1.5.0 (2026/09/23)

- Rebuild the Markdown editor interaction path around CodeMirror 6 as the single source of truth.
- Fix exact caret placement across prose, headings, quotes, code, tables, and rendered math, including equation tags.
- Restore forward and reverse drag selection while keeping single-click placement stable.
- Update visible block indexes incrementally and cache KaTeX source glyph hit maps to reduce repeated work.
- Add strict cursor regression tests and long-document performance guards.
- Document the root causes and five-stage refactor in `logs/README.md`.

## 1.2.2 (2022/12/23)

- Fix about rendering Unicode characters

## 1.2.1 (2022/12/12)

- Update PDF.js to 3.1.81-legacy
- Restore scroll position during reload (#136)
- Run under remote development (#100)

### Thank you

- @kfigiela Run extension locally when using remote development #100
- @Daniel-Atanasov fix: Fix scroll location and flickering during reload #136

## 1.2.0 (2021/12/15)

- Allow pdf viewer to work in an untrusted workspace (#102)
- Bump version of PDF.js to Stable (v2.10.377) (#120)

### Bug fixes

- Support Unicode in PDF by passing the right cMapUrl to pdf.js (#116)
- Preserve the current page number and zoom level on reload (#121)

### Thank you
- @lramos15 Added settings about untrusted workspaces. #102
- @aifreedom Fixed bug about Unicode charactors. #116
- @simon446 Bump pdf.js version. #120
- @zamzterz Fixed to preserve page number and scale on reload. #121

## 1.1.0 (2020/07/13)

- The issue about extension view is resolved.
  + Remove message shown on loaded. 
- Support default viewer settings
  + cursor (**hand** or tool)
  + scale (**auto**, page-actual, etc...)
  + sidebar (**hide** or show)
  + scrollMode (**vertical**, horizontal or wrapped)
  + spreadMode (**none**, odd or even)

## 1.0.0 (2020/06/18)

- [Change extension API](https://github.com/microsoft/vscode/issues/77131)
- Resolve known issues about showing pdf preview.
- Upgrade PDF.js to 2.4.456

## 0.6.0 (2020/04/10)

- Support auto reload (#52)
- Migrate vscode-extension packages

### Thank you
- @GeorchW Implemented auto-refresh ( #11 )  #52

## 0.5.0 (2019/02/25)

- Recovery for working even VSCode 1.31.x.
- Avoid nested `<iframe>`.

## 0.4.3 (2018/11/28)

- Recovery for working even VSCode 1.30.0.

## 0.4.2 (2018/11/28)

- Revive display state on load VSCode.
- [Event-Stream Package Security Update](https://code.visualstudio.com/blogs/2018/11/26/event-stream)

## 0.4.0 (2018/11/9)

- Migrate vscode internal api. Due to [Microsoft/vscode#62630](https://github.com/Microsoft/vscode/issues/62630)
- Upgrade PDF.js to 2.1.36

## 0.3.0 (2018/6/6)

- Upgrade PDF.js to 1.9.426 (#23)

### Thank you
- @Kampfgnom bump to pdf.js version #23

## 0.2.0 (2017/1/12)

- Fixed displaying on linux (#5)
- Be able to open PDF from context menu in explorer now (#6)

### Thank you
- @serl support for context menu in explorer #6

## 0.1.0 (2016/11/30)

- Add extension icon.
- Use all PDF.js [Pre-built](https://mozilla.github.io/pdf.js/getting_started/#download) files.

## 0.0.2 (2016/11/24)

- consistent file icon

## 0.0.1 (2016/10/25)

- Initial release.
