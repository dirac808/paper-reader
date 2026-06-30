import { getToolbar, bindShortcut, createContextMenu, setAIAvailable } from "./util.js";
import { mapVscodeLanguageToVditorLang } from "./lang.js";

const enableMathEditorLineWrap = () => {
  const apply = () => {
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
  apply();
  const observer = new MutationObserver(() => {
    window.requestAnimationFrame(apply);
  });
  observer.observe(document.getElementById("vditor") || document.body, {
    childList: true,
    subtree: true,
  });
};

const normalizeText = (text) => (text || "").replace(/\s+/g, " ").trim();
let currentMarkdownAnnotations = [];
let annotationRenderTimer = 0;

const collectTextNodes = (root) => {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!normalizeText(node.textContent)) {
        return NodeFilter.FILTER_REJECT;
      }
      if (node.parentElement?.closest?.(".paper-reader-md-note-anchor, script, style")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode();
  while (node) {
    nodes.push(node);
    node = walker.nextNode();
  }
  return nodes;
};

const scoreTextAnchor = (fullText, index, annotation) => {
  const selectedText = annotation?.selectedText || "";
  const prefixText = annotation?.prefixText || "";
  const suffixText = annotation?.suffixText || "";
  let score = 0;
  if (prefixText && fullText.slice(Math.max(0, index - prefixText.length), index) === prefixText) {
    score += prefixText.length;
  }
  if (
    suffixText &&
    fullText.slice(index + selectedText.length, index + selectedText.length + suffixText.length) === suffixText
  ) {
    score += suffixText.length;
  }
  return score;
};

const findBestTextIndex = (fullText, annotation) => {
  const selectedText = annotation?.selectedText || "";
  if (!selectedText) return -1;
  let bestIndex = -1;
  let bestScore = -1;
  let index = fullText.indexOf(selectedText);
  while (index >= 0) {
    const score = scoreTextAnchor(fullText, index, annotation);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
    index = fullText.indexOf(selectedText, index + Math.max(1, selectedText.length));
  }
  return bestIndex;
};

const createRangeFromTextOffsets = (textNodes, start, end) => {
  const range = document.createRange();
  let cursor = 0;
  let started = false;

  for (const node of textNodes) {
    const length = (node.textContent || "").length;
    const nodeStart = cursor;
    const nodeEnd = cursor + length;

    if (!started && start >= nodeStart && start <= nodeEnd) {
      range.setStart(node, Math.min(length, start - nodeStart));
      started = true;
    }
    if (started && end >= nodeStart && end <= nodeEnd) {
      range.setEnd(node, Math.min(length, end - nodeStart));
      return range;
    }
    cursor = nodeEnd;
  }

  return null;
};

const clearMarkdownAnnotationMarks = () => {
  document.querySelectorAll(".paper-reader-md-note-layer").forEach((node) => node.remove());
};

const renderMarkdownAnnotations = (annotations = []) => {
  currentMarkdownAnnotations = annotations || [];
  clearMarkdownAnnotationMarks();
  const root = document.querySelector("#vditor .vditor-wysiwyg, #vditor .vditor-ir, #vditor");
  if (!root) return;
  const layer = document.createElement("div");
  layer.className = "paper-reader-md-note-layer";
  document.body.appendChild(layer);
  const textNodes = collectTextNodes(root);
  const fullText = textNodes.map((node) => node.textContent || "").join("");

  annotations.forEach((annotation) => {
    const selectedText = annotation?.selectedText || "";
    const index = findBestTextIndex(fullText, annotation);
    if (index < 0) return;
    const range = createRangeFromTextOffsets(textNodes, index, index + selectedText.length);
    if (!range) return;
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;

    Array.from(range.getClientRects()).forEach((itemRect) => {
      if (itemRect.width === 0 || itemRect.height === 0) return;
      const highlight = document.createElement("span");
      highlight.className = "paper-reader-md-note-highlight";
      highlight.style.left = `${itemRect.left}px`;
      highlight.style.top = `${itemRect.top}px`;
      highlight.style.width = `${itemRect.width}px`;
      highlight.style.height = `${itemRect.height}px`;
      layer.appendChild(highlight);
    });

    const anchor = document.createElement("button");
    anchor.type = "button";
    anchor.className = "paper-reader-md-note-anchor";
    anchor.title = "Open note";
    anchor.dataset.annotationId = String(annotation.id);
    anchor.innerHTML = '<span class="codicon codicon-notebook" aria-hidden="true"></span>';
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handler.emit("openMarkdownAnnotationNote", annotation.id);
    });
    anchor.style.left = `${Math.min(window.innerWidth - 24, rect.right + 4)}px`;
    anchor.style.top = `${Math.max(4, rect.top + (rect.height - 18) / 2)}px`;
    layer.appendChild(anchor);
  });
};

const scheduleMarkdownAnnotationRender = () => {
  window.clearTimeout(annotationRenderTimer);
  annotationRenderTimer = window.setTimeout(() => {
    renderMarkdownAnnotations(currentMarkdownAnnotations);
  }, 80);
};

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
    value: content,
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
      handler.emit('doSave', editor?.getValue());
      editor?.markSaved();
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
      handler.emit("save", content)
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
        editor.setValue(content);
        editor.markSaved();
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
      window.addEventListener("scroll", scheduleMarkdownAnnotationRender, true);
      window.addEventListener("resize", scheduleMarkdownAnnotationRender);
      handler.emit("loadMarkdownAnnotations");
    }
  })
  bindShortcut(handler, editor);
  createContextMenu(editor)
}).emit("init")
