class FakeNode {
  constructor() {
    this.childNodes = [];
    this.parentNode = null;
  }

  append(...nodes) {
    for (const node of nodes) {
      const child = node instanceof FakeNode ? node : new FakeText(String(node));
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    this.append(...nodes);
  }

  get textContent() {
    return this.childNodes.map((c) => c.textContent).join("");
  }

  set textContent(value) {
    this.replaceChildren(String(value));
  }
}

class FakeText extends FakeNode {
  constructor(value) {
    super();
    this.nodeValue = value;
  }

  get textContent() {
    return this.nodeValue;
  }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.className = "";
    const props = new Map();
    this.style = { setProperty: (key, value) => props.set(key, value), getPropertyValue: (key) => props.get(key) ?? "" };
    const element = this;
    this.classList = {
      add: (...names) => (element.className = [...new Set([...element.className.split(" ").filter(Boolean), ...names])].join(" ")),
      remove: (...names) => (element.className = element.className.split(" ").filter((n) => n && !names.includes(n)).join(" ")),
      toggle: (name, force) => {
        const has = element.className.split(" ").includes(name);
        const want = force ?? !has;
        if (want) element.classList.add(name);
        else element.classList.remove(name);
        return want;
      },
      contains: (name) => element.className.split(" ").includes(name),
    };
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener() {}

  removeEventListener() {}

  focus() {}

  scrollIntoView() {}

  closest() {
    return null;
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 0, height: 0 };
  }

  get children() {
    return this.childNodes.filter((c) => c instanceof FakeElement);
  }

  descendants() {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }

  byClass(name) {
    return this.descendants().filter((c) => c.classList.contains(name));
  }
}

export function installFakeDom() {
  const ids = new Map();
  const byId = (id) => {
    if (!ids.has(id)) ids.set(id, new FakeElement("div"));
    return ids.get(id);
  };
  const document = {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (ns, tag) => new FakeElement(tag),
    createTextNode: (value) => new FakeText(value),
    getElementById: byId,
    querySelector: (selector) => byId(`query:${selector}`),
    querySelectorAll: () => [],
  };
  globalThis.document = document;
  globalThis.Node = FakeNode;
  globalThis.window = { innerWidth: 1024, matchMedia: () => ({ matches: false }) };
  globalThis.CSS = { escape: (value) => value };
  return { byId };
}
