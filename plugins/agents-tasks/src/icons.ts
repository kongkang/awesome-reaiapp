const paths = {
  "sort-desc": '<line x1="4" y1="7" x2="16" y2="7"></line><line x1="4" y1="12" x2="13" y2="12"></line><line x1="4" y1="17" x2="10" y2="17"></line><polyline points="17 14 20 17 20 10"></polyline>',
  "more-vertical": '<circle cx="12" cy="5" r="1.6"></circle><circle cx="12" cy="12" r="1.6"></circle><circle cx="12" cy="19" r="1.6"></circle>',
  "x": '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
  "check": '<polyline points="20 6 9 17 4 12"></polyline>',
  "alert-circle": '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>',
} as const;

export type TasksIconName = keyof typeof paths;

export function tasksIcon(name: TasksIconName, size = 16): SVGSVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("width", String(size));
  node.setAttribute("height", String(size));
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "1.8");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  node.innerHTML = paths[name];
  return node;
}
