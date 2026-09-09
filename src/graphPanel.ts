import * as vscode from 'vscode';
import { NoteStore } from './noteStore';

export class GraphPanel {
  public static readonly viewType = 'dipe.knowledgeGraph';
  private static currentPanel: GraphPanel | undefined;

  public static show(store: NoteStore): void {
    if (GraphPanel.currentPanel) {
      GraphPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
      GraphPanel.currentPanel.sendGraph();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      GraphPanel.viewType,
      'Paper Reader Knowledge Graph',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
      }
    );
    GraphPanel.currentPanel = new GraphPanel(panel, store);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly store: NoteStore
  ) {
    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => {
      GraphPanel.currentPanel = undefined;
    });
    this.panel.webview.onDidReceiveMessage((message) => {
      if (message.command === 'ready' || message.command === 'refresh') {
        this.sendGraph();
      }
    });
  }

  private sendGraph(): void {
    this.panel.webview.postMessage({
      command: 'graph',
      graph: this.store.getGraph(),
    });
  }

  private getHtml(): string {
    const nonce = `${Date.now()}${Math.random().toString(16).slice(2)}`;
    const d3Js = 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com; style-src 'unsafe-inline';">
  <style>
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    .toolbar { position: absolute; top: 0; left: 0; right: 0; height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 10px; border-bottom: 1px solid var(--vscode-panel-border); box-sizing: border-box; background: var(--vscode-editor-background); z-index: 1; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 4px 10px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    svg { width: 100vw; height: 100vh; display: block; }
    .link { stroke: var(--vscode-panel-border); stroke-opacity: 0.75; }
    .link.tag { stroke-dasharray: 4 3; }
    .node circle { stroke: var(--vscode-editor-background); stroke-width: 1.5px; }
    .node.note circle { fill: var(--vscode-charts-blue); }
    .node.tag circle { fill: var(--vscode-charts-green); }
    .node text { fill: var(--vscode-editor-foreground); font-size: 12px; paint-order: stroke; stroke: var(--vscode-editor-background); stroke-width: 3px; stroke-linejoin: round; }
    .empty { position: absolute; inset: 40px 0 0 0; display: grid; place-items: center; opacity: 0.7; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="refresh">Refresh</button>
    <span id="summary">Knowledge Graph</span>
  </div>
  <svg></svg>
  <div class="empty" id="empty">No notes yet</div>
  <script nonce="${nonce}" src="${d3Js}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const svg = d3.select('svg');
    const empty = document.getElementById('empty');
    const summary = document.getElementById('summary');
    let simulation;
    let simulationStopTimer;
    let resizeTimer;
    document.getElementById('refresh').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });

    function render(graph) {
      if (simulation) simulation.stop();
      window.clearTimeout(simulationStopTimer);
      svg.selectAll('*').remove();
      const width = window.innerWidth;
      const height = window.innerHeight;
      const topOffset = 40;
      empty.style.display = graph.nodes.length ? 'none' : 'grid';
      summary.textContent = graph.nodes.length + ' nodes, ' + graph.links.length + ' links';

      const zoomLayer = svg.append('g');
      svg.call(d3.zoom().scaleExtent([0.2, 3]).on('zoom', (event) => {
        zoomLayer.attr('transform', event.transform);
      }));

      simulation = d3.forceSimulation(graph.nodes)
        .force('link', d3.forceLink(graph.links).id((d) => d.id).distance((d) => d.type === 'tag' ? 80 : 130))
        .force('charge', d3.forceManyBody().strength(-260))
        .force('center', d3.forceCenter(width / 2, (height + topOffset) / 2))
        .force('collision', d3.forceCollide().radius(36))
        .alphaDecay(0.05);

      const link = zoomLayer.append('g')
        .selectAll('line')
        .data(graph.links)
        .enter()
        .append('line')
        .attr('class', (d) => 'link ' + d.type)
        .attr('stroke-width', 1.4);

      const node = zoomLayer.append('g')
        .selectAll('g')
        .data(graph.nodes)
        .enter()
        .append('g')
        .attr('class', (d) => 'node ' + d.type)
        .call(d3.drag()
          .on('start', (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on('drag', (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on('end', (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          }));

      node.append('circle').attr('r', (d) => d.type === 'tag' ? 7 : 10);
      node.append('text')
        .attr('x', 14)
        .attr('y', 4)
        .text((d) => d.label);

      simulation.on('tick', () => {
        link
          .attr('x1', (d) => d.source.x)
          .attr('y1', (d) => d.source.y)
          .attr('x2', (d) => d.target.x)
          .attr('y2', (d) => d.target.y);
        node.attr('transform', (d) => 'translate(' + d.x + ',' + d.y + ')');
      });
      simulationStopTimer = window.setTimeout(() => simulation && simulation.stop(), 5000);
    }

    window.addEventListener('message', (event) => {
      if (event.data.command === 'graph') {
        render(event.data.graph);
      }
    });
    window.addEventListener('resize', () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => vscode.postMessage({ command: 'refresh' }), 150);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (simulation) simulation.stop();
      } else {
        vscode.postMessage({ command: 'refresh' });
      }
    });
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }
}
