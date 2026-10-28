import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

export const html = await readFile(new URL('../fixtures/game-probe/page.html', import.meta.url), 'utf8');
const probeHtml = html;
const probeSource = await readFile(new URL('../../.test-dist/game-probe.js', import.meta.url), 'utf8');
export const settle = () => new Promise(resolve => setImmediate(resolve));

export async function page({html = probeHtml, source = probeSource, pendingImages = [], brokenImage = null, width = 1000, cardWidth = 144, observer = true,
  animationsEnabled = false, reducedMotion = false, animationFailure = false, session = null, fetchResponse = null, globals = null, canvasContext = null} = {}) {
  const finishDecode = new Map(), all = [], observers = [], requests = [];
  const timers = new Map(), animations = []; let clock = 0, nextTimer = 1;
  const schedule = (callback, delay) => {const id = nextTimer++; timers.set(id, {callback, at: clock + delay}); return id;};
  class FakeAnimation {
    constructor(element, keyframes, options) {
      this.element = element; this.keyframes = keyframes; this.options = options; this.playState = 'running';
      this.timer = schedule(() => this.finish(), (options.delay ?? 0) + options.duration);
    }
    finish() {if (this.playState !== 'running') return; timers.delete(this.timer); this.playState = 'finished'; this.onfinish?.();}
    cancel() {timers.delete(this.timer); this.playState = 'idle'; this.oncancel?.();}
  }
  class Target {
    handlers = new Map();
    addEventListener(type, handler) {
      const handlers = this.handlers.get(type) ?? new Set(); handlers.add(handler); this.handlers.set(type, handlers);
    }
    removeEventListener(type, handler) {this.handlers.get(type)?.delete(handler);}
    fire(type, fields = {}) {
      const event = {target: this, key: '', code: '', pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0, buttons: 0,
        clientX: 0, clientY: 0, detail: 1, altKey: false, ctrlKey: false,
        metaKey: false, repeat: false, defaultPrevented: false, preventDefault() {this.defaultPrevented = true;},
        stopPropagation() {this.propagationStopped = true;}, ...fields};
      for (const handler of this.handlers.get(type) ?? []) handler(event);
      this[`on${type}`]?.(event);
      return event;
    }
  }
  class Element extends Target {
    constructor(tagName = 'div') {
      super(); this.tagName = tagName; this.dataset = {}; this.children = []; this.attributes = {};
      this.style = {setProperty(key, value) {this[key] = value;}};
      this.hidden = false; this.inert = false; this.checked = false; this.captured = new Set();
      this.width = 0; this.height = 0; this.naturalWidth = 0; this.naturalHeight = 0;
      this.srcWrites = []; this.decodeCalls = 0; this.value = ''; this.className = ''; all.push(this);
      this.scrollTop = 0; this.scrollLeft = 0;
      this.classList = {contains: name => this.className.split(/\s+/).includes(name), toggle: (name, force) => {
        const classes = new Set(this.className.split(' ').filter(Boolean));
        if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); this.className = [...classes].join(' ');
      }, add: (...names) => {this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' ');}};
      if (!animationsEnabled) this.animate = undefined;
    }
    set textContent(value) {this.text = String(value); for (const child of this.children) child.parentElement = null; this.children = [];}
    get tag() {return this.tagName;}
    get childElementCount() {return this.children.length;}
    dispatch(type) {return this.fire(type);}
    click() {return this.fire('click');}
    showModal() {this.open = true;}
    close() {this.open = false;}
    get textContent() {return (this.text ?? '') + this.children.map(item => item.textContent).join('');}
    append(...items) {for (const item of items) {item.remove(); item.parentElement = this; this.children.push(item);}}
    replaceChildren(...items) {for (const child of [...this.children]) child.remove(); this.text = ''; this.append(...items);}
    get nextElementSibling() {
      const siblings = this.parentElement?.children ?? [];
      return siblings[siblings.indexOf(this) + 1] ?? null;
    }
    insertBefore(item, reference) {
      if (item === reference) return item;
      item.remove(); item.parentElement = this;
      const index = reference ? this.children.indexOf(reference) : this.children.length;
      assert.ok(index >= 0, 'Reference must be a child'); this.children.splice(index, 0, item); return item;
    }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this);
      this.parentElement = null;
    }
    setAttribute(key, value) {this.attributes[key] = String(value);}
    getAttribute(key) {return this.attributes[key] ?? null;}
    removeAttribute(key) {delete this.attributes[key];}
    contains(target) {for (let node = target; node; node = node.parentElement) if (node === this) return true; return false;}
    get isConnected() {
      for (let node = this; node; node = node.parentElement) if (node.tagName === 'html') return true;
      return false;
    }
    focus() {
      const previous = document.activeElement; if (previous === this) return;
      document.activeElement = this; this.keyboardFocus = true;
      previous?.fire('blur'); this.fire('focus');
      for (let node = this; node; node = node.parentElement) node.fire('focusin', {target: this});
    }
    blur() {
      if (document.activeElement !== this) return;
      document.activeElement = document.body; this.keyboardFocus = false;
      this.fire('blur');
    }
    matches() {return !!this.keyboardFocus;}
    querySelectorAll(selectors) {
      const visit = root => root.children.flatMap(child => [child, ...visit(child)]);
      return visit(this).filter(node => selectors.split(',').some(selector => node.closest(selector.trim()) === node));
    }
    closest(selectors) {
      if (this.editable) return this;
      for (let node = this; node; node = node.parentElement) for (const selector of selectors.split(',').map(value => value.trim())) {
        if (/^[a-z]+$/i.test(selector) && node.tagName.toLowerCase() === selector.toLowerCase()) return node;
        const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
        if (attribute && node.getAttribute(attribute[1]) !== null && (attribute[2] === undefined || node.getAttribute(attribute[1]) === attribute[2])) return node;
      }
      return null;
    }
    setPointerCapture(id) {this.captured.add(id);}
    releasePointerCapture(id) {
      if (this.captured.delete(id)) this.fire('lostpointercapture', {pointerId: id});
    }
    get hiddenInTree() {for (let node = this; node; node = node.parentElement) if (node.hidden) return true; return false;}
    get clientWidth() {return !this.hiddenInTree && (this.className.split(' ').includes('hand-track') || this.className.split(' ').includes('table-viewport')) ? width : 0;}
    get clientHeight() {return !this.hiddenInTree && this.className.split(' ').includes('table-viewport') ? 300 : 0;}
    get scrollWidth() {return this.hiddenInTree ? 0 : this.id === 'public-desktop' ? 900 : this.id === 'village-desktop' ? 592 : this.clientWidth;}
    get scrollHeight() {return this.hiddenInTree ? 0 : this.id === 'public-desktop' ? 640 : this.id === 'village-desktop' ? 960 : this.clientHeight;}
    get offsetWidth() {return this.hidden ? 0 : Math.min(cardWidth, width);}
    getBoundingClientRect() {
      const size = Math.min(cardWidth, width), height = size * 704 / 504;
      let rect;
      if (this.className.split(' ').includes('table-viewport')) rect = {left: 24, top: 150, width: this.clientWidth, height: this.clientHeight};
      else if (this.id === 'public-desktop' || this.id === 'village-desktop') {
        const pan = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(this.style.transform ?? '');
        const scale = Number(/scale\(([^)]+)\)/.exec(this.style.transform ?? '')?.[1] ?? 1);
        rect = {left: 24 + Number(pan?.[1] ?? 0), top: 150 + Number(pan?.[2] ?? 0), width: this.scrollWidth * scale, height: this.scrollHeight * scale};
      } else if (this.id === 'dungeon-area' || this.id === 'village-area') {
        const desktop = this.parentElement.getBoundingClientRect();
        rect = {left: desktop.left + 28, top: desktop.top + 28, width: desktop.width - 56, height: desktop.height - 56};
      } else if (this.className.split(' ').includes('hand-track')) rect = {left: 200, top: 500, width, height};
      else if (this.id?.endsWith('draw-pile')) rect = {left: 30, top: 500, width: size, height};
      else if (this.id?.endsWith('discard-pile')) rect = {left: 240 + width, top: 500, width: size, height};
      else if (this.className === 'card-flight') rect = {
        left: Number.parseFloat(this.style.left), top: Number.parseFloat(this.style.top),
        width: Number.parseFloat(this.style.width), height: Number.parseFloat(this.style.height)};
      else if (this.tagName === 'button') {
        const parent = this.parentElement?.getBoundingClientRect() ?? {left: 0, top: 0};
        rect = {left: parent.left + (Number.parseFloat(this.style.left) || 0), top: parent.top, width: size, height};
      } else rect = this.parentElement?.getBoundingClientRect() ?? {left: 0, top: 0, width: size, height};
      return {...rect, right: rect.left + rect.width, bottom: rect.top + rect.height};
    }
    animate(keyframes, options) {
      if (animationFailure) throw new Error('Animation unavailable');
      const animation = new FakeAnimation(this, keyframes, options); animations.push(animation); return animation;
    }
    set src(value) {
      this.srcWrites.push(value); this.setAttribute('src', value);
      this.naturalWidth = value.endsWith('TS-BACK-001.jpg') ? 501 : 504; this.naturalHeight = 704;
    }
    get src() {return this.getAttribute('src');}
    decode() {
      this.decodeCalls++;
      if (this.id === brokenImage) return Promise.reject(new Error('Image cannot be decoded'));
      if (pendingImages.includes(this.id)) return new Promise(resolve => finishDecode.set(this.id, resolve));
      return Promise.resolve();
    }
    scrollBy({top, left}) {this.scrollTop += top; this.scrollLeft += left;}
    getContext(kind, options) {return canvasContext?.(this, kind, options) ?? null;}
  }
  // Parse the real static tree; dynamic cards use the same createElement/append path as the browser.
  const stack = [], voidTags = new Set(['meta', 'link', 'input', 'img', 'br', 'hr']);
  for (const match of html.matchAll(/<(\/?)([a-z][a-z0-9-]*)([^>]*)>/gi)) {
    const [, closing, tagName, attributes] = match;
    if (closing) {stack.pop(); continue;}
    const node = new Element(tagName);
    for (const attr of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      const [, name, value = ''] = attr;
      node.setAttribute(name, value);
      if (name === 'id') node.id = value;
      else if (name === 'class') node.className = value;
      else if (name === 'src') node.src = value;
      else if (name === 'value') node.value = value;
      else if (name === 'hidden') node.hidden = true;
      else if (name === 'checked') node.checked = true;
      else if (name === 'open') node.open = true;
      else if (name === 'width' || name === 'height') node[name] = Number(value);
      else if (name.startsWith('data-')) node.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
    stack.at(-1)?.append(node);
    if (!voidTags.has(tagName)) stack.push(node);
  }
  const find = id => all.find(node => node.id === id && node.isConnected) ?? all.find(node => node.id === id) ?? null;
  const get = id => {const node = find(id); assert.ok(node, `Missing actual HTML: ${id}`); return node;};
  const window = new Target(), document = new Target();
  window.innerWidth = 1280; window.innerHeight = 900;
  window.matchMedia = () => ({matches: reducedMotion});
  window.setTimeout = schedule; window.clearTimeout = id => timers.delete(id);
  document.getElementById = find; document.createElement = tag => new Element(tag); document.hidden = false;
  document.querySelector = selector => selector.startsWith('#') ? find(selector.slice(1)) : null;
  document.createElementNS = (_namespace, tag) => new Element(tag);
  document.activeElement = null; document.body = all.find(node => node.tagName === 'body');
  class Observer {
    constructor(callback) {this.callback = callback; this.disconnected = false; observers.push(this);}
    observe() {}
    disconnect() {this.disconnected = true;}
  }
  const storageValues = new Map(session ? [['thunderstone-session-v1', JSON.stringify(session)]] : []);
  const context = vm.createContext({window, document, HTMLElement: Element, console, Headers,
    sessionStorage: {getItem: key => storageValues.get(key) ?? null, setItem: (key, value) => storageValues.set(key, value), removeItem: key => storageValues.delete(key)},
    getComputedStyle: () => ({borderRadius: '9px'}),
    ResizeObserver: observer ? Observer : undefined,
    fetch: async (url, options) => {requests.push(url); if (fetchResponse) return fetchResponse(url, options); throw new Error(`Unexpected request: ${url}`);},
    ...(typeof globals === 'function' ? globals({window, document, Element}) : globals ?? {})});
  vm.runInContext(source, context);
  await settle();
  return {evaluate: code => vm.runInContext(code, context), window, document, get, requests, Element, all, observers, animations, timers,
    async decoded(id) {finishDecode.get(id)(); await settle();},
    cards() {return get('hand-track').children.filter(node => node.tagName === 'button' && !node.hidden);},
    inspecting() {return get('inspect-content').children.filter(node => !node.hidden);},
    enter(id = 'probe-card', extra = {}) {return get(id).fire('pointerenter', extra);},
    key(key, fields = {}) {return window.fire('keydown', {key, ...fields});},
    release() {return window.fire('keyup', {key: ' ', code: 'Space'});},
    async count(value) {get('hand-count').value = String(value); get('hand-count').fire('input'); await settle();},
    async click(id) {get(id).fire('click'); await settle();},
    async autoSort(checked) {get('auto-sort-hand').checked = checked; get('auto-sort-hand').fire('change'); await settle();},
    down(id = 'probe-card', fields = {}) {
      const card = get(id), rect = card.getBoundingClientRect();
      const clientX = rect.left + 12, clientY = rect.top + 20;
      card.fire('pointerdown', {clientX, clientY, ...fields}); return {clientX, clientY};
    },
    pointer(type, clientX, fields = {}) {return window.fire(type, {clientX, clientY: 520, ...fields});},
    async advance(ms) {
      const target = clock + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); clock = next[1].at; next[1].callback(); await settle();
      }
      clock = target; await settle();
    },
    resize(value, newCardWidth = cardWidth) {
      width = value; cardWidth = newCardWidth;
      if (observer) {
        for (const item of observers) if (!item.disconnected) item.callback();
      }
      window.fire('resize');
    }};
}

