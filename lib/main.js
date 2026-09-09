"use strict";

(function () {
  const SELECTION_READ_DELAYS_MS = [50, 150, 300]

  const vscode = typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : undefined
  const restoredViewState = vscode ? (vscode.getState() || {}) : {}
  let viewStateSaveTimer

  function postMessage(message) {
    if (vscode) {
      vscode.postMessage(message)
    }
  }

  function saveViewState() {
    if (!vscode || !window.PDFViewerApplication || !PDFViewerApplication.pdfViewer) {
      return
    }
    const viewer = PDFViewerApplication.pdfViewer
    vscode.setState({
      pageNumber: viewer.currentPageNumber,
      scaleValue: viewer.currentScaleValue,
      scrollMode: viewer.scrollMode,
      spreadMode: viewer.spreadMode,
      sidebarOpen: Boolean(PDFViewerApplication.pdfSidebar && PDFViewerApplication.pdfSidebar.isOpen)
    })
  }

  function scheduleViewStateSave() {
    window.clearTimeout(viewStateSaveTimer)
    viewStateSaveTimer = window.setTimeout(saveViewState, 200)
  }

  function loadConfig() {
    const elem = document.getElementById('pdf-preview-config')
    if (elem) {
      return JSON.parse(elem.getAttribute('data-config'))
    }
    throw new Error('Could not load configuration.')
  }
  function cursorTools(name) {
    if (name === 'hand') {
      return 1
    }
    return 0
  }
  function scrollMode(name) {
    switch (name) {
      case 'vertical':
        return 0
      case 'horizontal':
        return 1
      case 'wrapped':
        return 2
      default:
        return -1
    }
  }
  function spreadMode(name) {
    switch (name) {
      case 'none':
        return 0
      case 'odd':
        return 1
      case 'even':
        return 2
      default:
        return -1
    }
  }
  function registerCodexSelectionBridge() {
    let cachedSelectionText = ''
    let cachedSelectionRect = undefined
    let cachedSelectionPagePoint = undefined
    let pdfAnnotations = []
    const pendingTranslationRects = {}

    function getSelectionData() {
      const selection = window.getSelection && window.getSelection()
      const text = selection ? selection.toString() : ''
      const trimmedText = text.trim()
      let rect
      if (selection && selection.rangeCount > 0) {
        rect = selection.getRangeAt(0).getBoundingClientRect()
      }
      return {
        text: trimmedText,
        rect: rect && (rect.width || rect.height)
          ? {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height
            }
          : undefined
      }
    }

    function getPagePointFromRect(rect) {
      if (!rect) {
        return undefined
      }

      const pageNode = document.elementFromPoint(rect.left, rect.top)
        ? document.elementFromPoint(rect.left, rect.top).closest('.page')
        : undefined
      const page = pageNode || Array.prototype.find.call(document.querySelectorAll('.page'), function (candidate) {
        const pageRect = candidate.getBoundingClientRect()
        return rect.left >= pageRect.left &&
          rect.left <= pageRect.right &&
          rect.top >= pageRect.top &&
          rect.top <= pageRect.bottom
      })
      if (!page) {
        return undefined
      }

      const pageRect = page.getBoundingClientRect()
      const pageNumber = Number(page.getAttribute('data-page-number')) || 1
      return {
        page: pageNumber,
        x: Math.max(0, Math.min(1, (rect.left - pageRect.left) / pageRect.width)),
        y: Math.max(0, Math.min(1, (rect.top - pageRect.top) / pageRect.height)),
        width: Math.max(0, Math.min(1, rect.width / pageRect.width)),
        height: Math.max(0, Math.min(1, rect.height / pageRect.height))
      }
    }

    function removeCodexMenu() {
      const existingMenu = document.getElementById('dipe-codex-context-menu')
      if (existingMenu) {
        existingMenu.remove()
      }
    }

    function removeTranslationTooltip() {
      const existingTooltip = document.getElementById('dipe-translation-tooltip')
      if (existingTooltip) {
        existingTooltip.remove()
      }
      document.removeEventListener('mousedown', handleTranslationTooltipOutsideClick, true)
      document.removeEventListener('keydown', handleTranslationTooltipKeydown, true)
      window.removeEventListener('scroll', removeTranslationTooltip, true)
    }

    function handleTranslationTooltipOutsideClick(event) {
      const tooltip = document.getElementById('dipe-translation-tooltip')
      if (tooltip && !tooltip.contains(event.target)) {
        removeTranslationTooltip()
      }
    }

    function handleTranslationTooltipKeydown(event) {
      if (event.key === 'Escape') {
        removeTranslationTooltip()
      }
    }

    function createMenuButton(label, onClick) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.style.display = 'block'
      button.style.width = '100%'
      button.style.padding = '6px 10px'
      button.style.border = '0'
      button.style.borderRadius = '3px'
      button.style.background = 'transparent'
      button.style.color = '#ffffff'
      button.style.textAlign = 'left'
      button.style.cursor = 'pointer'
      button.addEventListener('mouseenter', function () {
        button.style.background = 'rgba(127, 127, 127, 0.18)'
      })
      button.addEventListener('mouseleave', function () {
        button.style.background = 'transparent'
      })
      button.addEventListener('click', onClick)
      return button
    }

    function showTranslationTooltip(rect, text, isError) {
      removeTranslationTooltip()

      const tooltip = document.createElement('div')
      tooltip.id = 'dipe-translation-tooltip'
      tooltip.style.position = 'fixed'
      tooltip.style.left = Math.max(8, rect.left) + 'px'
      tooltip.style.top = Math.min(window.innerHeight - 80, rect.bottom + 8) + 'px'
      tooltip.style.zIndex = '100001'
      tooltip.style.maxWidth = Math.min(420, window.innerWidth - 24) + 'px'
      tooltip.style.maxHeight = '240px'
      tooltip.style.overflow = 'auto'
      tooltip.style.padding = '10px 12px'
      tooltip.style.border = isError ? '1px solid #f48771' : '1px solid rgba(127, 127, 127, 0.35)'
      tooltip.style.borderRadius = '6px'
      tooltip.style.background = '#252526'
      tooltip.style.color = isError ? '#f48771' : '#ffffff'
      tooltip.style.boxShadow = '0 12px 32px rgba(0, 0, 0, 0.24)'
      tooltip.style.font = '13px/1.55 system-ui, sans-serif'
      tooltip.style.whiteSpace = 'pre-wrap'
      tooltip.textContent = text

      document.body.appendChild(tooltip)

      const tooltipRect = tooltip.getBoundingClientRect()
      if (tooltipRect.right > window.innerWidth) {
        tooltip.style.left = Math.max(8, window.innerWidth - tooltipRect.width - 8) + 'px'
      }
      if (tooltipRect.bottom > window.innerHeight) {
        tooltip.style.top = Math.max(8, rect.top - tooltipRect.height - 8) + 'px'
      }

      setTimeout(function () {
        document.addEventListener('mousedown', handleTranslationTooltipOutsideClick, true)
        document.addEventListener('keydown', handleTranslationTooltipKeydown, true)
        window.addEventListener('scroll', removeTranslationTooltip, true)
      }, 0)
    }

    function removeAnnotationEditor() {
      const existingEditor = document.getElementById('dipe-pdf-note-editor')
      if (existingEditor) {
        existingEditor.remove()
      }
    }

    function ensureAnnotationEditorStyle() {
      if (document.getElementById('dipe-pdf-note-editor-style')) {
        return
      }

      const style = document.createElement('style')
      style.id = 'dipe-pdf-note-editor-style'
      style.textContent = [
        '#dipe-pdf-note-editor textarea { color: #ffffff !important; caret-color: #ffffff !important; }',
        '#dipe-pdf-note-editor textarea::placeholder { color: rgba(255, 255, 255, 0.62) !important; }',
        '#dipe-pdf-note-editor .dipe-note-preview h1, #dipe-pdf-note-editor .dipe-note-preview h2, #dipe-pdf-note-editor .dipe-note-preview h3 { margin: 8px 0 4px; color: #ffffff; }',
        '#dipe-pdf-note-editor .dipe-note-preview p { margin: 4px 0; }',
        '#dipe-pdf-note-editor .dipe-note-preview blockquote { margin: 6px 0; padding-left: 8px; border-left: 3px solid #6a9955; color: rgba(255,255,255,0.82); }',
        '#dipe-pdf-note-editor .dipe-note-preview code { background: rgba(255,255,255,0.12); padding: 1px 3px; border-radius: 3px; }',
        '#dipe-pdf-note-editor .dipe-note-preview .math-display { margin: 8px 0; overflow-x: auto; }',
        '#dipe-pdf-note-editor .dipe-note-preview .math-fallback { font-family: "Times New Roman", serif; font-style: italic; color: #dcdcaa; }',
        '#dipe-pdf-note-editor .dipe-note-preview .wikilink { color: #4fc1ff; font-weight: 600; }',
        '#dipe-pdf-note-editor .dipe-note-preview .tag { color: #89d185; font-weight: 600; }'
      ].join('\n')
      document.head.appendChild(style)
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    }

    function renderFormattedText(value) {
      return escapeHtml(value)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/\[\[([^\]\n]+)\]\]/g, '<span class="wikilink">[[$1]]</span>')
        .replace(/(^|[\s([{])#([A-Za-z0-9_\-\u4e00-\u9fa5]+)/g, '$1<span class="tag">#$2</span>')
    }

    function renderMath(math, displayMode) {
      if (window.katex && typeof window.katex.renderToString === 'function') {
        try {
          return window.katex.renderToString(math, {
            displayMode: displayMode,
            throwOnError: false,
            strict: false
          })
        } catch (_error) {
          // Fall through to escaped source.
        }
      }

      return '<span class="math-fallback">' + escapeHtml(math) + '</span>'
    }

    function renderInlineMarkdown(value) {
      const source = String(value)
      const mathPattern = /\\\(([\s\S]+?)\\\)|\$([^$\n]+)\$/g
      let html = ''
      let cursor = 0
      let match

      while ((match = mathPattern.exec(source))) {
        html += renderFormattedText(source.slice(cursor, match.index))
        html += renderMath(match[1] || match[2] || '', false)
        cursor = match.index + match[0].length
      }
      html += renderFormattedText(source.slice(cursor))
      return html
    }

    function renderMarkdownPreview(markdown) {
      const lines = String(markdown || '').split(/\r?\n/)
      const html = []
      let inList = false
      let mathFence = ''
      let mathLines = []

      function closeList() {
        if (inList) {
          html.push('</ul>')
          inList = false
        }
      }

      lines.forEach(function (line) {
        if (mathFence) {
          if ((mathFence === '\\]' && /^\s*\\\]\s*$/.test(line)) || (mathFence === '$$' && /^\s*\$\$\s*$/.test(line))) {
            closeList()
            html.push('<div class="math-display">' + renderMath(mathLines.join('\n'), true) + '</div>')
            mathFence = ''
            mathLines = []
          } else {
            mathLines.push(line)
          }
          return
        }

        if (!line.trim()) {
          closeList()
          return
        }

        const displayMath = line.match(/^\s*\$\$([\s\S]+)\$\$\s*$/)
        if (displayMath) {
          closeList()
          html.push('<div class="math-display">' + renderMath(displayMath[1], true) + '</div>')
          return
        }

        const bracketDisplayMath = line.match(/^\s*\\\[([\s\S]+)\\\]\s*$/)
        if (bracketDisplayMath) {
          closeList()
          html.push('<div class="math-display">' + renderMath(bracketDisplayMath[1], true) + '</div>')
          return
        }

        if (/^\s*\\\[\s*$/.test(line)) {
          closeList()
          mathFence = '\\]'
          mathLines = []
          return
        }

        if (/^\s*\$\$\s*$/.test(line)) {
          closeList()
          mathFence = '$$'
          mathLines = []
          return
        }

        const heading = line.match(/^(#{1,3})\s+(.+)$/)
        if (heading) {
          closeList()
          html.push('<h' + heading[1].length + '>' + renderInlineMarkdown(heading[2]) + '</h' + heading[1].length + '>')
          return
        }

        const listItem = line.match(/^\s*[-*]\s+(.+)$/)
        if (listItem) {
          if (!inList) {
            html.push('<ul>')
            inList = true
          }
          html.push('<li>' + renderInlineMarkdown(listItem[1]) + '</li>')
          return
        }

        const quote = line.match(/^>\s?(.+)$/)
        if (quote) {
          closeList()
          html.push('<blockquote>' + renderInlineMarkdown(quote[1]) + '</blockquote>')
          return
        }

        closeList()
        html.push('<p>' + renderInlineMarkdown(line) + '</p>')
      })
      closeList()
      if (mathFence) {
        html.push('<div class="math-display">' + renderMath(mathLines.join('\n'), true) + '</div>')
      }
      return html.join('')
    }

    function makeDraggable(panel, handle) {
      handle.addEventListener('mousedown', function (event) {
        if (event.button !== 0) {
          return
        }
        event.preventDefault()

        const startX = event.clientX
        const startY = event.clientY
        const startRect = panel.getBoundingClientRect()

        function move(moveEvent) {
          const nextLeft = Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, startRect.left + moveEvent.clientX - startX))
          const nextTop = Math.max(8, Math.min(window.innerHeight - panel.offsetHeight - 8, startRect.top + moveEvent.clientY - startY))
          panel.style.left = nextLeft + 'px'
          panel.style.top = nextTop + 'px'
        }

        function stop() {
          document.removeEventListener('mousemove', move, true)
          document.removeEventListener('mouseup', stop, true)
        }

        document.addEventListener('mousemove', move, true)
        document.addEventListener('mouseup', stop, true)
      })
    }

    function showAnnotationEditor(annotation, point, selectedText) {
      removeAnnotationEditor()
      ensureAnnotationEditorStyle()

      const anchorRect = point && point.rect
        ? point.rect
        : {
            left: window.innerWidth / 2,
            top: window.innerHeight / 2,
            right: window.innerWidth / 2,
            bottom: window.innerHeight / 2
          }

      const editor = document.createElement('div')
      editor.id = 'dipe-pdf-note-editor'
      editor.style.position = 'fixed'
      editor.style.left = Math.max(8, anchorRect.left) + 'px'
      editor.style.top = Math.min(window.innerHeight - 180, anchorRect.bottom + 8) + 'px'
      editor.style.zIndex = '100002'
      editor.style.width = Math.min(360, window.innerWidth - 24) + 'px'
      editor.style.minWidth = '320px'
      editor.style.maxWidth = Math.max(340, window.innerWidth - 24) + 'px'
      editor.style.padding = '10px'
      editor.style.border = '1px solid rgba(127, 127, 127, 0.35)'
      editor.style.borderRadius = '6px'
      editor.style.background = '#252526'
      editor.style.color = '#ffffff'
      editor.style.boxShadow = '0 12px 32px rgba(0, 0, 0, 0.24)'
      editor.style.font = '13px system-ui, sans-serif'
      editor.style.resize = 'both'
      editor.style.overflow = 'auto'

      const titleBar = document.createElement('div')
      titleBar.textContent = 'Markdown PDF note'
      titleBar.style.margin = '-10px -10px 8px'
      titleBar.style.padding = '8px 10px'
      titleBar.style.borderBottom = '1px solid rgba(127, 127, 127, 0.35)'
      titleBar.style.cursor = 'move'
      titleBar.style.fontWeight = '600'
      titleBar.style.userSelect = 'none'

      const selectedBlock = document.createElement('div')
      selectedBlock.textContent = selectedText ? selectedText : ''
      selectedBlock.style.display = selectedText ? 'block' : 'none'
      selectedBlock.style.marginBottom = '8px'
      selectedBlock.style.padding = '6px 8px'
      selectedBlock.style.borderLeft = '3px solid #6a9955'
      selectedBlock.style.color = 'rgba(255, 255, 255, 0.75)'
      selectedBlock.style.background = 'rgba(255, 255, 255, 0.06)'
      selectedBlock.style.maxHeight = '72px'
      selectedBlock.style.overflow = 'auto'

      const textarea = document.createElement('textarea')
      textarea.value = annotation ? annotation.content : ''
      textarea.placeholder = 'Write Markdown note...'
      textarea.style.boxSizing = 'border-box'
      textarea.style.width = '100%'
      textarea.style.height = '96px'
      textarea.style.resize = 'vertical'
      textarea.style.color = '#ffffff'
      textarea.style.background = '#1e1e1e'
      textarea.style.border = '1px solid rgba(127, 127, 127, 0.35)'
      textarea.style.padding = '6px'

      const preview = document.createElement('div')
      preview.className = 'dipe-note-preview'
      preview.style.marginTop = '8px'
      preview.style.padding = '8px'
      preview.style.border = '1px solid rgba(127, 127, 127, 0.25)'
      preview.style.borderRadius = '4px'
      preview.style.background = 'rgba(255, 255, 255, 0.04)'
      preview.style.color = '#ffffff'
      preview.style.maxHeight = '150px'
      preview.style.overflow = 'auto'
      preview.style.lineHeight = '1.45'

      function updatePreview() {
        preview.innerHTML = textarea.value.trim()
          ? renderMarkdownPreview(textarea.value)
          : '<p style="opacity: 0.62; margin: 0;">Markdown preview</p>'
      }
      textarea.addEventListener('input', updatePreview)
      updatePreview()

      const actions = document.createElement('div')
      actions.style.display = 'flex'
      actions.style.justifyContent = 'flex-end'
      actions.style.gap = '8px'
      actions.style.marginTop = '8px'

      const cancelButton = createMenuButton('Cancel', removeAnnotationEditor)
      cancelButton.style.width = 'auto'
      const saveButton = createMenuButton('Save', function () {
        const content = textarea.value.trim()
        if (!content) {
          return
        }
        postMessage({
          command: 'savePdfAnnotation',
          id: annotation && annotation.id,
          page: annotation ? annotation.page : point.pagePoint.page,
          x: annotation ? annotation.x : point.pagePoint.x,
          y: annotation ? annotation.y : point.pagePoint.y,
          width: annotation ? annotation.width : point.pagePoint.width,
          height: annotation ? annotation.height : point.pagePoint.height,
          selectedText: annotation ? annotation.selectedText : selectedText,
          content
        })
        removeAnnotationEditor()
      })
      saveButton.style.width = 'auto'

      if (annotation) {
        const deleteButton = createMenuButton('Delete', function () {
          postMessage({ command: 'deletePdfAnnotation', id: annotation.id })
          removeAnnotationEditor()
        })
        deleteButton.style.width = 'auto'
        actions.appendChild(deleteButton)
      }
      actions.appendChild(cancelButton)
      actions.appendChild(saveButton)
      editor.appendChild(titleBar)
      editor.appendChild(selectedBlock)
      editor.appendChild(textarea)
      editor.appendChild(preview)
      editor.appendChild(actions)
      document.body.appendChild(editor)
      makeDraggable(editor, titleBar)
      textarea.focus()
    }

    function renderPdfAnnotations() {
      document.querySelectorAll('.dipe-pdf-annotation-marker').forEach(function (marker) {
        marker.remove()
      })
      document.querySelectorAll('.dipe-pdf-annotation-highlight').forEach(function (highlight) {
        highlight.remove()
      })

      pdfAnnotations.forEach(function (annotation) {
        const page = document.querySelector('.page[data-page-number="' + annotation.page + '"]')
        if (!page) {
          return
        }

        const width = Number(annotation.width) || 0
        const height = Number(annotation.height) || 0
        if (width > 0 && height > 0) {
          const highlight = document.createElement('button')
          highlight.className = 'dipe-pdf-annotation-highlight'
          highlight.title = annotation.content
          highlight.style.position = 'absolute'
          highlight.style.left = (annotation.x * 100) + '%'
          highlight.style.top = (annotation.y * 100) + '%'
          highlight.style.width = (width * 100) + '%'
          highlight.style.height = (height * 100) + '%'
          highlight.style.border = '0'
          highlight.style.padding = '0'
          highlight.style.background = 'rgba(255, 216, 77, 0.34)'
          highlight.style.cursor = 'pointer'
          highlight.style.zIndex = '19'
          highlight.addEventListener('click', function (event) {
            event.preventDefault()
            event.stopPropagation()
            postMessage({ command: 'openPdfAnnotationNote', id: annotation.id })
          })
          page.appendChild(highlight)
        }

        const marker = document.createElement('button')
        marker.className = 'dipe-pdf-annotation-marker'
        marker.title = annotation.content
        marker.textContent = ''
        marker.style.position = 'absolute'
        marker.style.left = (Math.min(1, annotation.x + width) * 100) + '%'
        marker.style.top = (annotation.y * 100) + '%'
        marker.style.width = '12px'
        marker.style.height = '12px'
        marker.style.border = '1px solid rgba(0, 0, 0, 0.35)'
        marker.style.borderRadius = '50%'
        marker.style.background = '#ffd84d'
        marker.style.boxShadow = '0 1px 5px rgba(0, 0, 0, 0.3)'
        marker.style.cursor = 'pointer'
        marker.style.zIndex = '20'
        marker.addEventListener('click', function (event) {
          event.preventDefault()
          event.stopPropagation()
          postMessage({ command: 'openPdfAnnotationNote', id: annotation.id })
        })
        page.appendChild(marker)
      })
    }

    function updateCachedSelection() {
      SELECTION_READ_DELAYS_MS.forEach(function (delay) {
        window.setTimeout(function () {
          const selection = getSelectionData()
          cachedSelectionText = selection.text
          cachedSelectionRect = selection.rect
          cachedSelectionPagePoint = getPagePointFromRect(selection.rect)
        }, delay)
      })
    }

    function showCodexMenu(x, y, text, rect) {
      removeCodexMenu()

      const menu = document.createElement('div')
      menu.id = 'dipe-codex-context-menu'
      menu.setAttribute('role', 'menu')
      menu.style.position = 'fixed'
      menu.style.left = x + 'px'
      menu.style.top = y + 'px'
      menu.style.zIndex = '100000'
      menu.style.minWidth = '160px'
      menu.style.padding = '4px'
      menu.style.border = '1px solid rgba(0, 0, 0, 0.18)'
      menu.style.borderRadius = '4px'
      menu.style.background = '#252526'
      menu.style.color = '#ffffff'
      menu.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.18)'
      menu.style.font = '13px system-ui, sans-serif'

      const translateButton = createMenuButton('Translate selection', function () {
        const requestId = Date.now() + '-' + Math.random().toString(16).slice(2)
        pendingTranslationRects[requestId] = rect || {
          left: x,
          top: y,
          right: x,
          bottom: y,
          width: 0,
          height: 0
        }
        showTranslationTooltip(pendingTranslationRects[requestId], 'Translating...', false)
        postMessage({
          command: 'translateSelection',
          requestId,
          text,
          rect: pendingTranslationRects[requestId]
        })
        removeCodexMenu()
      })

      const addButton = createMenuButton('Add to Codex', function () {
        postMessage({ command: 'sendToCodex', text })
        removeCodexMenu()
      })

      const noteButton = createMenuButton('Add PDF note', function () {
        const pagePoint = getPagePointFromRect(rect) || cachedSelectionPagePoint
        if (!pagePoint) {
          removeCodexMenu()
          return
        }
        postMessage({
          command: 'createPdfAnnotationNote',
          page: pagePoint.page,
          x: pagePoint.x,
          y: pagePoint.y,
          width: pagePoint.width,
          height: pagePoint.height,
          selectedText: text
        })
        removeCodexMenu()
      })

      menu.appendChild(translateButton)
      menu.appendChild(addButton)
      menu.appendChild(noteButton)
      document.body.appendChild(menu)

      const menuRect = menu.getBoundingClientRect()
      if (menuRect.right > window.innerWidth) {
        menu.style.left = Math.max(0, window.innerWidth - menuRect.width - 8) + 'px'
      }
      if (menuRect.bottom > window.innerHeight) {
        menu.style.top = Math.max(0, window.innerHeight - menuRect.height - 8) + 'px'
      }
    }

    function handleContextMenu(event) {
      const selection = getSelectionData()
      const selectedText = selection.text || cachedSelectionText
      const selectedRect = selection.rect || cachedSelectionRect || {
        left: event.clientX,
        top: event.clientY,
        right: event.clientX,
        bottom: event.clientY,
        width: 0,
        height: 0
      }
      if (!selectedText) {
        removeCodexMenu()
        return
      }

      event.preventDefault()
      event.stopPropagation()
      showCodexMenu(event.clientX, event.clientY, selectedText, selectedRect)
    }

    document.addEventListener('mouseup', updateCachedSelection, true)
    document.addEventListener('contextmenu', handleContextMenu, true)
    document.addEventListener('click', removeCodexMenu, true)
    document.addEventListener('scroll', function () {
      removeCodexMenu()
      removeTranslationTooltip()
    }, true)
    window.addEventListener('blur', removeCodexMenu)
    window.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        removeCodexMenu()
        removeTranslationTooltip()
        removeAnnotationEditor()
      }
    })
    window.addEventListener('message', function (event) {
      const message = event.data || {}
      if (message.command === 'pdfAnnotations') {
        pdfAnnotations = Array.isArray(message.annotations) ? message.annotations : []
        renderPdfAnnotations()
        return
      }

      if (message.command !== 'translationResult') {
        return
      }

      const rect = pendingTranslationRects[message.requestId]
      if (!rect) {
        return
      }
      delete pendingTranslationRects[message.requestId]
      showTranslationTooltip(
        rect,
        message.error || message.text || 'No translation returned.',
        Boolean(message.error)
      )
    })

    postMessage({ command: 'loadPdfAnnotations' })
  }

  window.addEventListener('load', async function () {
    registerCodexSelectionBridge()

    const config = loadConfig()
    PDFViewerApplicationOptions.set('cMapUrl', config.cMapUrl)
    PDFViewerApplicationOptions.set('workerSrc', config.workerSrc)
    PDFViewerApplicationOptions.set('standardFontDataUrl', config.standardFontDataUrl)
    PDFViewerApplicationOptions.set('isEvalSupported', false)
    const loadOpts = {
      url:config.path,
      useWorkerFetch: false,
      cMapUrl: config.cMapUrl,
      cMapPacked: true,
      standardFontDataUrl: config.standardFontDataUrl,
      isEvalSupported: false
    }
    PDFViewerApplication.initializedPromise.then(() => {
      const defaults = config.defaults
      const optsOnLoad = () => {
        PDFViewerApplication.pdfCursorTools.switchTool(cursorTools(defaults.cursor))
        PDFViewerApplication.pdfViewer.currentScaleValue = restoredViewState.scaleValue || defaults.scale
        PDFViewerApplication.pdfViewer.scrollMode = Number.isInteger(restoredViewState.scrollMode)
          ? restoredViewState.scrollMode
          : scrollMode(defaults.scrollMode)
        PDFViewerApplication.pdfViewer.spreadMode = Number.isInteger(restoredViewState.spreadMode)
          ? restoredViewState.spreadMode
          : spreadMode(defaults.spreadMode)
        if (restoredViewState.pageNumber > 0) {
          PDFViewerApplication.pdfViewer.currentPageNumber = restoredViewState.pageNumber
        }
        if (restoredViewState.sidebarOpen === true || (restoredViewState.sidebarOpen === undefined && defaults.sidebar)) {
          PDFViewerApplication.pdfSidebar.open()
        } else {
          PDFViewerApplication.pdfSidebar.close()
        }
        PDFViewerApplication.eventBus.off('documentloaded', optsOnLoad)
      }
      PDFViewerApplication.eventBus.on('documentloaded', optsOnLoad)
      PDFViewerApplication.eventBus.on('updateviewarea', scheduleViewStateSave)
      PDFViewerApplication.eventBus.on('sidebarviewchanged', scheduleViewStateSave)
      
      PDFViewerApplication.open(config.path, loadOpts)
    })

    window.addEventListener('message', async function (event) {
      if (!event.data || event.data.type !== 'reload') {
        return
      }

      // Prevents flickering of page when PDF is reloaded
      const oldResetView = PDFViewerApplication.pdfViewer._resetView
      PDFViewerApplication.pdfViewer._resetView = function () {
        this._firstPageCapability = (0, pdfjsLib.createPromiseCapability)()
        this._onePageRenderedCapability = (0, pdfjsLib.createPromiseCapability)()
        this._pagesCapability = (0, pdfjsLib.createPromiseCapability)()

        this.viewer.textContent = ""
      }

      // Changing the fingerprint fools pdf.js into keeping scroll position
      const doc = await pdfjsLib.getDocument(loadOpts).promise
      doc._pdfInfo.fingerprints = [config.path]
      PDFViewerApplication.load(doc)

      PDFViewerApplication.pdfViewer._resetView = oldResetView
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        saveViewState()
      }
    })
  }, { once: true });

  window.onerror = function () {
    const msg = document.createElement('body')
    msg.innerText = 'An error occurred while loading the file. Please open it again.'
    document.body = msg
  }
}());
