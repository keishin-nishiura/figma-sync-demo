// Figmaドキュメントの木構造 (ツリー構造) を最小構成で再現するモデル。
//
// - プロパティ更新は LWW (Last-Writer-Wins): サーバーに届いた順にそのまま
//   適用するだけでよく、タイムスタンプは不要 (Figma記事7章に対応)
// - reparent (親子関係の変更) は、循環参照を作ってしまう場合にサーバー側で
//   拒否する (Figma記事9章に対応)
// - 兄弟要素の順序は Fractional Indexing で管理する (Figma記事9章に対応)

import { generateKeyBetween } from '../shared/fractionalIndex.js';

export class Document {
  constructor() {
    this.nodes = new Map(); // id -> { id, parentId, order, properties }
    this.rootId = 'root';
    this.nodes.set(this.rootId, {
      id: this.rootId,
      parentId: null,
      order: null,
      properties: { name: 'Root' },
    });
  }

  createNode(id, parentId, properties = {}) {
    const siblings = this.getChildren(parentId);
    const lastOrder = siblings.length > 0 ? siblings[siblings.length - 1].order : null;
    const order = generateKeyBetween(lastOrder, null);
    const node = { id, parentId, order, properties: { ...properties } };
    this.nodes.set(id, node);
    return node;
  }

  getChildren(parentId) {
    return [...this.nodes.values()]
      .filter((n) => n.parentId === parentId)
      .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  }

  // ancestorId が nodeId の祖先かどうか (循環参照チェック用)
  isAncestor(ancestorId, nodeId) {
    let current = this.nodes.get(nodeId);
    while (current && current.parentId != null) {
      if (current.parentId === ancestorId) return true;
      current = this.nodes.get(current.parentId);
    }
    return false;
  }

  // LWW: サーバーに届いた順にそのまま適用するだけでよい (タイムスタンプ不要)
  applyPropertyUpdate(nodeId, key, value) {
    const node = this.nodes.get(nodeId);
    if (!node) return null;
    node.properties[key] = value;
    return node;
  }

  // reparent: 循環参照になる場合は null を返して拒否する
  reparent(nodeId, newParentId) {
    const node = this.nodes.get(nodeId);
    const newParent = this.nodes.get(newParentId);
    if (!node || !newParent) return null;

    // newParentId が nodeId 自身、または nodeId の子孫であれば
    // 付け替えると循環が生まれてしまうため拒否する
    if (newParentId === nodeId || this.isAncestor(nodeId, newParentId)) {
      return null;
    }

    const siblings = this.getChildren(newParentId);
    const lastOrder = siblings.length > 0 ? siblings[siblings.length - 1].order : null;
    node.parentId = newParentId;
    node.order = generateKeyBetween(lastOrder, null);
    return node;
  }

  moveNode(nodeId, beforeId, afterId) {
    const node = this.nodes.get(nodeId);
    if (!node) return null;
    const beforeOrder = beforeId ? this.nodes.get(beforeId)?.order ?? null : null;
    const afterOrder = afterId ? this.nodes.get(afterId)?.order ?? null : null;
    node.order = generateKeyBetween(beforeOrder, afterOrder);
    return node;
  }

  deleteNode(nodeId) {
    return this.nodes.delete(nodeId);
  }

  toJSON() {
    return [...this.nodes.values()];
  }
}
