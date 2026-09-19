import { getToolbar, bindShortcut, createContextMenu, setAIAvailable } from "./util.js";
import { mapVscodeLanguageToVditorLang } from "./lang.js";
import {
  createAnnotationDomRange,
  createAnnotationTextIndex,
  findAnnotationTextRange,
} from "./annotationModel.js";

const enableMathEditorLineWrap = () => {
  document
    .querySelectorAll(".vditor-math-cm-host, [data-type='math-block'] .vditor-cm-host")
    .forEach((host) => {
      if (host.dataset.paperReaderWrapApplied === "true") return;
      host.dataset.paperReaderWrapApplied = "true";
      host.style.maxWidth = "100%";
      host.style.overflowX = "hidden";

      host.querySelectorAll(".cm-editor, .cm-content").forEach((node) => {
        node.classList.add("cm-lineWrapping");
        node.style.maxWidth = "100%";
        node.style.minWidth = "0";
      });

      host.querySelectorAll(".cm-scroller").forEach((node) => {
        node.style.overflowX = "hidden";
      });

      host.querySelectorAll(".cm-content, .cm-line").forEach((node) => {
        node.style.whiteSpace = "pre-wrap";
        node.style.overflowWrap = "anywhere";
        node.style.wordBreak = "break-word";
      });
    });
};

let currentMarkdownAnnotations = [];
let currentMarkdownAnnotationAnchors = [];
let annotationRenderFrame = 0;
let annotationRenderTimer = 0;
let mathRefreshTimer = 0;
let documentSaveTimer = 0;
let pendingDocumentContent;
const markdownHighlightName = "paper-reader-markdown-annotations";

const normalizeDisplayMathDelimiters = (markdown = "") => {
  return (markdown || "")
    .replace(
      /(^|\n)([ \t]*)\\\[\s*\n([\s\S]*?)\n[ \t]*\\\]([ \t]*(?=\n|$))/g,
      (_match, lineStart, indent, body, suffix) => `${lineStart}${indent}$$\n${body.trim()}\n${indent}$$${suffix}`,
    )
    .replace(
      /(^|\n)([ \t]*)\\\[\s*([^\n]*?)\s*\\\]([ \t]*(?=\n|$))/g,
      (_match, lineStart, indent, body, suffix) => `${lineStart}${indent}$$\n${body.trim()}\n${indent}$$${suffix}`,
    );
};

const getEditorRoot = () => document.querySelector("#vditor .vditor-wysiwyg, #vditor .vditor-ir, #vditor");

const getAnnotationLayerHost = () => {
  const root = getEditorRoot();
  if (!root) return null;
  return root.closest(".vditor-content") || root;
};

const clearMarkdownAnnotationMarks = () => {
  document.querySelectorAll(".paper-reader-md-note-layer").forEach((node) => node.remove());
  if (window.CSS?.highlights?.delete) {
    window.CSS.highlights.delete(markdownHighlightName);
  }
  currentMarkdownAnnotationAnchors = [];
};

const renderMarkdownAnnotations = (annotations = []) => {
  currentMarkdownAnnotations = annotations || [];
  clearMarkdownAnnotationMarks();
  const root = getEditorRoot();
  const layerHost = getAnnotationLayerHost();
  if (!root || !layerHost) return;
  const layer = document.createElement("div");
  layer.className = "paper-reader-md-note-layer";
  layer.style.width = `${Math.max(layerHost.scrollWidth, layerHost.clientWidth)}px`;
  layer.style.height = `${Math.max(layerHost.scrollHeight, layerHost.clientHeight)}px`;
  layerHost.appendChild(layer);
  const textIndex = createAnnotationTextIndex(root);
  const highlightRanges = [];
  const supportsCssHighlight = !!window.CSS?.highlights && typeof window.Highlight === "function";

  annotations.forEach((annotation) => {
    const match = findAnnotationTextRange(textIndex.text, annotation);
    if (!match) return;
    const range = createAnnotationDomRange(textIndex.entries, match.start, match.end);
    if (!range) return;
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;

    if (supportsCssHighlight) {
      highlightRanges.push(range);
    }

    const anchor = document.createElement("button");
    anchor.type = "button";
    anchor.className = "paper-reader-md-note-anchor";
    anchor.title = "Open note";
    anchor.setAttribute("aria-label", "Open note for selected text");
    anchor.dataset.annotationId = String(annotation.id);
    anchor.innerHTML = '<span class="codicon codicon-notebook" aria-hidden="true"></span>';
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handler.emit("openMarkdownAnnotationNote", annotation.id);
    });
    layer.appendChild(anchor);
    currentMarkdownAnnotationAnchors.push({ anchor, range, layerHost });
  });

  if (supportsCssHighlight && highlightRanges.length > 0) {
    window.CSS.highlights.set(markdownHighlightName, new window.Highlight(...highlightRanges));
  } else {
    renderFallbackAnnotationHighlights(layer, layerHost, currentMarkdownAnnotationAnchors);
  }
  updateMarkdownAnnotationAnchorPositions();
};

const renderFallbackAnnotationHighlights = (layer, layerHost, anchors) => {
  const hostRect = layerHost.getBoundingClientRect();
  const hostScrollLeft = layerHost.scrollLeft || 0;
  const hostScrollTop = layerHost.scrollTop || 0;
  anchors.forEach(({ range }) => {
    Array.from(range.getClientRects()).forEach((itemRect) => {
      if (itemRect.width === 0 || itemRect.height === 0) return;
      const highlight = document.createElement("span");
      highlight.className = "paper-reader-md-note-highlight";
      highlight.style.left = `${itemRect.left - hostRect.left + hostScrollLeft}px`;
      highlight.style.top = `${itemRect.top - hostRect.top + hostScrollTop}px`;
      highlight.style.width = `${itemRect.width}px`;
      highlight.style.height = `${itemRect.height}px`;
      layer.appendChild(highlight);
    });
  });
};

const updateMarkdownAnnotationAnchorPositions = () => {
  currentMarkdownAnnotationAnchors.forEach(({ anchor, range, layerHost }) => {
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      anchor.hidden = true;
      return;
    }
    const hostRect = layerHost.getBoundingClientRect();
    const hostScrollLeft = layerHost.scrollLeft || 0;
    const hostScrollTop = layerHost.scrollTop || 0;
    anchor.hidden = false;
    anchor.style.left = `${rect.right - hostRect.left + hostScrollLeft + 4}px`;
    anchor.style.top = `${rect.top - hostRect.top + hostScrollTop + (rect.height - 18) / 2}px`;
  });
};

const scheduleMarkdownAnnotationAnchorUpdate = () => {
  if (annotationRenderFrame) return;
  annotationRenderFrame = window.requestAnimationFrame(() => {
    annotationRenderFrame = 0;
    updateMarkdownAnnotationAnchorPositions();
  });
};

const scheduleMarkdownAnnotationRender = (delay = 0) => {
  window.clearTimeout(annotationRenderTimer);
  if (delay > 0) {
    annotationRenderTimer = window.setTimeout(() => scheduleMarkdownAnnotationRender(), delay);
    return;
  }
  if (annotationRenderFrame) return;
  annotationRenderFrame = window.requestAnimationFrame(() => {
    annotationRenderFrame = 0;
    renderMarkdownAnnotations(currentMarkdownAnnotations);
  });
};

const refreshRenderedMath = (editor, markdownConfig, rootPath) => {
  const root = document.getElementById("vditor");
  if (!root) return;
  window.Vditor?.mathRender?.(root, {
    cdn: rootPath,
    math: {
      macros: markdownConfig?.math?.macros ?? {},
    },
  });
  enableMathEditorLineWrap();
  scheduleMarkdownAnnotationAnchorUpdate();
};

const scheduleMathRefresh = (editor, markdownConfig, rootPath) => {
  window.clearTimeout(mathRefreshTimer);
  mathRefreshTimer = window.setTimeout(() => refreshRenderedMath(editor, markdownConfig, rootPath), 700);
};

const flushDocumentSave = (handler) => {
  window.clearTimeout(documentSaveTimer);
  documentSaveTimer = 0;
  if (pendingDocumentContent === undefined) return;
  const content = pendingDocumentContent;
  pendingDocumentContent = undefined;
  handler.emit("save", content);
};

const scheduleDocumentSave = (handler, content) => {
  pendingDocumentContent = content;
  window.clearTimeout(documentSaveTimer);
  documentSaveTimer = window.setTimeout(() => flushDocumentSave(handler), 150);
};

const getNormalizedEditorValue = (editor) => normalizeDisplayMathDelimiters(editor?.getValue?.() || "");

handler.on("open", async (md) => {
  const { content, rootPath, documentCacheId, pendingFragment, config } = md;
  const {
    language, isWeb, isDev, markdown,
    editMode, editorTheme, codeMirrorTheme, mermaidTheme
  } = config;
  if (isWeb) {
    document.body.classList.add('is-web')
  }
  const editor = new Vditor('vditor', {
    value: normalizeDisplayMathDelimiters(content),
    cdn: rootPath,
    height: '100%',
    outline: {
      position: 'left',
    },
    cache: {
      enable: false,
      id: documentCacheId,
      focusHost: 'vscode',
    },
    mode: editMode,
    editorTheme,
    codeMirrorTheme,
    mermaidTheme,
    lang: mapVscodeLanguageToVditorLang(language),
    tab: '\t',
    toolbar: await getToolbar(rootPath, () => {
      const normalizedContent = getNormalizedEditorValue(editor);
      handler.emit('doSave', normalizedContent);
      editor?.markSaved(normalizedContent);
    }),
    onAboutOpen: () => handler.emit('openAbout'),
    onSponsorLogoClick: () => handler.emit('openSponsor'),
    onSponsorSiteClick: () => handler.emit('openExternal', 'https://database-client.com/'),
    onLinkClick(payload, event) {
      const isCompose = event.metaKey || event.ctrlKey;
      if (payload.action !== "dblclick" && !(payload.action === "click" && isCompose)) {
        return;
      }
      let uri = payload.href;
      if (payload.type === "wikilink" || payload.type === "wikilink-embed") {
        const hashIndex = uri.indexOf("#");
        const page = hashIndex < 0 ? uri : uri.slice(0, hashIndex);
        const fragment = hashIndex < 0 ? "" : uri.slice(hashIndex + 1);
        if (!page && fragment) {
          editor.scrollToBlock(fragment);
          return;
        }
        uri = `wiki:${payload.href}`;
      }
      handler.emit("openLink", uri);
    },
    debugger: isDev,
    changeEditorTheme(theme) {
      handler.emit('editorTheme', theme)
    },
    changeCodeTheme(theme) {
      handler.emit('codeMirrorTheme', theme)
    },
    changeMermaidTheme(theme) {
      handler.emit('mermaidTheme', theme)
    },
    changeEditMode(mode) {
      handler.emit('editMode', mode)
    },
    onSettingsChange(settings) {
      handler.emit('syncViewerSettings', settings)
    },
    onEditSettings() {
      handler.emit('editViewerSettings', editor.exportViewerSettings())
    },
    input(content) {
      scheduleDocumentSave(handler, content)
      if (currentMarkdownAnnotations.length > 0) {
        scheduleMarkdownAnnotationRender(3500);
      }
    },
    upload: {
      url: '/image',
      accept: 'image/*',
      handler(files) {
        const file = files[0];
        const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
        let reader = new FileReader();
        reader.readAsBinaryString(file);
        reader.onloadend = () => {
          handler.emit("img", { data: reader.result, ext })
        };
      }
    },
    onTelemetry(event, properties) {
      handler.emit('telemetry', { event, properties });
    },
    ai: {
      onPolish(markdown, apply, options) {
        handler.emit('aiPolish', { markdown, options })
        handler.on('aiPolishChunk', (chunk) => {
          editor.streamAIChunk(chunk)
        })
        handler.on('aiPolishEnd', () => {
          editor.endAIStream()
        })
      },
      onCancelPolish() {
        handler.emit('aiPolishCancel')
      }
    },
    preview: {
      markdown: {
        mathBlockPreview: true,
      },
      math: {
        macros: markdown?.math?.macros ?? {},
      },
    },
    after() {
      const { viewerSettings } = md;
      if (viewerSettings?.enabled) {
        editor.setViewerSettingsSyncEnabled(true);
        if (viewerSettings.settings) {
          editor.applyViewerSettings(viewerSettings.settings);
        }
      }
      handler.on('viewerSettingsSync', ({ enabled }) => {
        editor.setViewerSettingsSyncEnabled(!!enabled);
      });
      handler.on('viewerSettings', (settings) => {
        editor.applyViewerSettings(settings);
      });
      handler.on('markdownConfig', (update) => {
        if (update.editorTheme !== undefined) {
          editor.setEditorTheme(update.editorTheme);
        }
        if (update.codeMirrorTheme !== undefined) {
          Vditor.setCodeTheme(update.codeMirrorTheme, editor.vditor?.element);
        }
        if (update.mermaidTheme !== undefined) {
          editor.setMermaidTheme(update.mermaidTheme);
        }
        if (update.editMode !== undefined) {
          editor.switchEditMode(update.editMode);
        }
      });
      handler.on("update", content => {
        if (document.querySelector("[data-type='yaml-front-matter'].vditor-code-block--cm .cm-editor.cm-focused")) {
          return;
        }
        if (editor.getValue() === content) {
          return;
        }
        editor.setValue(normalizeDisplayMathDelimiters(content));
        editor.markSaved();
        scheduleMathRefresh(editor, markdown, rootPath);
        handler.emit("loadMarkdownAnnotations");
      })
      handler.on("markdownAnnotations", (annotations) => {
        requestAnimationFrame(() => renderMarkdownAnnotations(annotations || []));
      })
      handler.on("gotoBlock", (fragment) => {
        if (fragment) {
          editor.scrollToBlock(fragment);
        }
      })
      handler.emit('queryAIAvailable')
      handler.on("aiAvailable", (available) => {
        setAIAvailable(available, editor)
        if (available) {
          handler.emit('queryVSCodeModels')
        }
      })
      handler.on("vscodeModels", (models) => {
        editor.setVSCodeModels(models)
      })
      editor.restoreDocumentSession(true)
      if (pendingFragment) {
        editor.scrollToBlock(pendingFragment);
      }
      enableMathEditorLineWrap();
      const annotationLayerHost = getAnnotationLayerHost();
      annotationLayerHost?.addEventListener("scroll", scheduleMarkdownAnnotationAnchorUpdate, { passive: true });
      window.addEventListener("scroll", scheduleMarkdownAnnotationAnchorUpdate, true);
      window.addEventListener("resize", () => scheduleMarkdownAnnotationRender(120));
      scheduleMathRefresh(editor, markdown, rootPath);
      handler.emit("loadMarkdownAnnotations");
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          flushDocumentSave(handler);
        }
      });
    }
  })
  bindShortcut(handler, editor);
  createContextMenu(editor)
}).emit("init")
