export const $ = selector => document.querySelector(selector);

export function textSpan(parent, className, content) {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = content;
  parent.append(element);
  return element;
}
