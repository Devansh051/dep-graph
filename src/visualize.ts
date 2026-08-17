/**
 * Produce a self-contained, interactive HTML view for dependency_graph.json.
 * Usage: node --import tsx src/visualize.ts [graph-path] [html-path]
 */
import { readFileSync, writeFileSync } from "fs";

type Node = { id: string; service?: string };
type Edge = { from: string; to: string; label?: string };
type Graph = { nodes: Node[]; edges: Edge[] };

const graphPath = process.argv[2] ?? "dependency_graph.json";
const htmlPath = process.argv[3] ?? "visualization.html";
const graph = JSON.parse(readFileSync(graphPath, "utf8")) as Graph;
const graphJson = JSON.stringify(graph).replace(/</g, "\\u003c");

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tool dependency graph</title>
  <script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
  <style>
    :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #0b1020; color: #e8edf9; overflow: hidden; }
    header { position: fixed; z-index: 2; width: 100%; padding: 16px 20px; background: linear-gradient(#0b1020 70%, transparent); }
    h1 { font-size: 18px; margin: 0 0 5px; }
    p { margin: 0; font-size: 13px; color: #aebbd3; }
    svg { display: block; width: 100vw; height: 100vh; }
    .edge { stroke: #607092; stroke-opacity: .35; }
    .node { stroke: #0b1020; stroke-width: 1.2px; cursor: grab; }
    .node:active { cursor: grabbing; }
    .tooltip { position: fixed; pointer-events: none; display: none; max-width: 360px; padding: 9px 11px; border: 1px solid #35425f; border-radius: 7px; background: #151d31; font-size: 12px; line-height: 1.45; box-shadow: 0 8px 28px #0008; }
    .hint { position: fixed; bottom: 14px; right: 18px; color: #93a3c1; font-size: 12px; }
  </style>
</head>
<body>
  <header><h1>Tool dependency graph</h1><p id="summary"></p></header>
  <div class="tooltip" id="tooltip"></div><div class="hint">Scroll to zoom · drag nodes to rearrange</div>
  <svg aria-label="Interactive dependency graph"><defs><marker id="arrow" viewBox="0 -5 10 10" refX="17" refY="0" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,-5L10,0L0,5" fill="#607092" /></marker></defs><g></g></svg>
  <script>
    const graph = ${graphJson};
    const svg = d3.select('svg'), layer = svg.select('g'), tip = d3.select('#tooltip');
    document.querySelector('#summary').textContent = graph.nodes.length + ' tools · ' + graph.edges.length + ' directed dependencies';
    const services = [...new Set(graph.nodes.map(n => n.service || 'other'))].sort();
    const color = d3.scaleOrdinal(services, d3.schemeTableau10.concat(d3.schemeSet3));
    const nodes = graph.nodes.map(n => ({...n}));
    const byId = new Map(nodes.map(n => [n.id, n]));
    const links = graph.edges.map(e => ({...e, source: byId.get(e.from), target: byId.get(e.to)})).filter(e => e.source && e.target);
    const link = layer.append('g').selectAll('line').data(links).join('line').attr('class','edge').attr('marker-end','url(#arrow)');
    const node = layer.append('g').selectAll('circle').data(nodes).join('circle').attr('class','node').attr('r', 5).attr('fill', d => color(d.service || 'other'));
    const simulation = d3.forceSimulation(nodes).force('link', d3.forceLink(links).id(d => d.id).distance(54).strength(.15)).force('charge', d3.forceManyBody().strength(-28)).force('center', d3.forceCenter(innerWidth / 2, innerHeight / 2)).force('collide', d3.forceCollide(7));
    simulation.on('tick', () => { link.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y); node.attr('cx',d=>d.x).attr('cy',d=>d.y); });
    svg.call(d3.zoom().scaleExtent([.08, 5]).on('zoom', e => layer.attr('transform', e.transform)));
    node.call(d3.drag().on('start', (e,d) => { if (!e.active) simulation.alphaTarget(.25).restart(); d.fx=d.x; d.fy=d.y; }).on('drag', (e,d) => { d.fx=e.x; d.fy=e.y; }).on('end', (e,d) => { if (!e.active) simulation.alphaTarget(0); d.fx=null; d.fy=null; }));
    node.on('mouseenter', (e,d) => { const incoming=links.filter(l=>l.target===d).length, outgoing=links.filter(l=>l.source===d).length; tip.html('<strong>'+d.id+'</strong><br>Service: '+(d.service||'other')+'<br>'+incoming+' inputs from tools · '+outgoing+' outputs to tools').style('display','block'); }).on('mousemove', e => tip.style('left',(e.clientX+14)+'px').style('top',(e.clientY+14)+'px')).on('mouseleave', () => tip.style('display','none'));
    link.on('mouseenter', (e,d) => tip.html('<strong>'+d.label+'</strong><br>'+d.from+' → '+d.to).style('display','block')).on('mousemove', e => tip.style('left',(e.clientX+14)+'px').style('top',(e.clientY+14)+'px')).on('mouseleave', () => tip.style('display','none'));
  </script>
</body>
</html>`;

writeFileSync(htmlPath, html, "utf8");
console.error(`Wrote ${htmlPath}`);
