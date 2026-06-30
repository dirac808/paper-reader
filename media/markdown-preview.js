(function () {
  function enhanceMathClicks() {
    var mathNodes = document.querySelectorAll('.katex, .katex-display');
    for (var index = 0; index < mathNodes.length; index += 1) {
      var node = mathNodes[index];
      if (node.getAttribute('data-paper-reader-math-click')) {
        continue;
      }
      node.setAttribute('data-paper-reader-math-click', 'true');
      node.setAttribute(
        'title',
        'Click to return to the Markdown source near this formula.'
      );
      node.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        var target = event.currentTarget;
        var dblclick = new MouseEvent('dblclick', {
          bubbles: true,
          cancelable: true,
          view: window,
        });
        target.dispatchEvent(dblclick);
      });
    }
  }

  enhanceMathClicks();
  new MutationObserver(enhanceMathClicks).observe(document.body, {
    childList: true,
    subtree: true,
  });
})();
